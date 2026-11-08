// What the move card runs on once the Canton account is open: the library's move, built from the wallet, the account and this build's bridge configuration. The Bridge page loads this file
// only when it needs it, so none of it is in the page's first script.
import { cantonAdapter } from "./adapter.ts";
import { adoptRecord } from "./adopt.ts";
import { track } from "./activity.ts";
import type { Account } from "./account.ts";
import { holdingsOf } from "./balances.ts";
import type { OpenRequest, OpenState } from "./canton/accounts.ts";
import type { EvmAdapter } from "./evm/adapter.ts";
import type { BridgeConfig } from "./evm/config.ts";
import { registryClient } from "./evm/registry.ts";
import { createMove, explorerCustody, explorerLeg, explorerSentSince, explorerTx, randomRef, Refused, webLocks, type Move } from "./moves/moves.ts";
import { keptMoves, moveStore, type Checkpoint } from "./moves/state.ts";

export interface Session {
  /** Where the page and the moves meet: the card starts, continues and gives up moves here, and the in-flight bar and the Activity list read it. */
  move: Move;
  evm: EvmAdapter;
  /** The person's Canton account. */
  party: string;
  /** What the account holds of a Canton token (10 decimals): the total of its unlocked holdings, in Canton's smallest unit. */
  cantonBalance(instrument: { admin: string; id: string }): Promise<bigint>;
  /** The moves kept in this browser for this account, newest first. */
  kept(): Checkpoint[];
  /** What the account service says is open for the account (GET /accounts/v1/open): its redeem and deposit requests. One signed look, so it is asked for once, not on a timer. */
  open(): Promise<OpenState>;
  /** The contract ids of every holding of the account on Canton (locked or not): a redeem whose holdings are gone is told from one that can still be released. */
  holdingIds(): Promise<Set<string>>;
  /** Removes the account's open redeem request with this ref (one this browser has no record of). It signs one Canton command and never asks the wallet. */
  removeRedeem(ref: string): Promise<void>;
  /**
   * Keeps a record here for a redeem or a deposit that Canton lists as open but this browser has no record of (it was started in another browser), so the move can be carried on like any kept
   * move. Returns the record's ref, or null when this build cannot carry it on (its token is not one the bridge moves, or its allocation is gone). It never signs, sends or asks the wallet.
   * The open requests are read again just before the record is kept: a request that is not open any more keeps nothing and throws NoLongerOpen.
   */
  adopt(kind: "redeem" | "deposit", request: OpenRequest): Promise<string | null>;
  /** Stops the session's watching of its move (the list of finished moves). */
  close(): void;
}

/** Removes a redeem request another browser started, unless a transaction of the account is still waiting in Ostia's pool (it may be that redeem's release, which would be left with no Canton side). */
export async function removeUnlessPending(evm: Pick<EvmAdapter, "nonce" | "pendingNonce">, cancel: () => Promise<void>): Promise<void> {
  const pool = await evm.pendingNonce?.().catch(() => null);
  const final = pool == null ? null : await evm.nonce().catch(() => null);
  if (pool != null && final !== null && pool > final) throw new Refused("A transaction of this account is still waiting; cancel it in your wallet first.");
  await cancel();
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export function createSession(o: { evm: EvmAdapter; account: Pick<Account, "key" | "party" | "client" | "chain" | "submit">; config: BridgeConfig }): Session {
  const { evm, account, config } = o;
  const canton = cantonAdapter({ client: account.client, key: account.key, party: account.party, chain: account.chain, submit: account.submit, sleep });
  const store = moveStore();
  const move = createMove({
    config, evm, canton, registry: registryClient(config.registryUrl), api: { tx: explorerTx }, leg: explorerLeg, sentSince: explorerSentSince, custody: explorerCustody,
    store, locks: webLocks(), sleep, newRef: randomRef,
  });
  const stop = track(move, store);
  return {
    move, evm, party: account.party, close: stop,
    open: () => account.client.openRequests(account.key, account.party),
    cantonBalance: async (instrument) => holdingsOf(await account.client.holdings(account.key, account.party), instrument),
    kept: () => keptMoves(store, { account: evm.account, party: account.party }),
    holdingIds: async () => new Set((await account.client.holdings(account.key, account.party)).map((h) => h.contractId)),
    removeRedeem: (ref) => removeUnlessPending(evm, () => canton.cancelRedeem(ref)),
    adopt: (kind, request) => adoptRecord(kind, request, {
      account: evm.account, party: account.party, config, store,
      allocations: () => account.client.allocations(account.key, account.party), holdingIds: async () => new Set((await account.client.holdings(account.key, account.party)).map((h) => h.contractId)), openRequests: () => account.client.openRequests(account.key, account.party),
    }),
  };
}

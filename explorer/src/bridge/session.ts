// What the move card runs on once the Canton account is open: the library's move, built from the wallet, the account and this build's bridge configuration. The Bridge page loads this file
// only when it needs it, so none of it is in the page's first script.
import { cantonAdapter } from "./adapter.ts";
import { adoptRecord } from "./adopt.ts";
import { track } from "./activity.ts";
import type { AccountsClient } from "./canton/accounts.ts";
import type { Account } from "./account.ts";
import { holdingsOf } from "./balances.ts";
import type { OpenRequest, OpenState } from "./canton/accounts.ts";
import type { EvmAdapter } from "./evm/adapter.ts";
import type { BridgeConfig } from "./evm/config.ts";
import { registryClient } from "./evm/registry.ts";
import { createMove, explorerCustody, explorerLeg, explorerSentSince, explorerTx, randomRef, Refused, webLocks, type CantonAdapter, type Move } from "./moves/moves.ts";
import { keptMoves, moveStore, depositIdOf, releaseIdOf, type Checkpoint } from "./moves/state.ts";

export interface Session {
  /** Where the page and the moves meet: the card starts, continues and gives up moves here, and the in-flight bar and the Activity list read it. */
  move: Move;
  evm: EvmAdapter;
  /** The person's Canton account. */
  party: string;
  /** What the account holds of each of these Canton tokens (10 decimals), in the order given: the total of its unlocked holdings, in Canton's smallest unit. One signed read of the account's holdings, whatever the number of tokens. */
  cantonBalances(instruments: { admin: string; id: string }[]): Promise<bigint[]>;
  /** The moves kept in this browser for this account, newest first. */
  kept(): Checkpoint[];
  /** What the account service says is open for the account (GET /accounts/v1/open): its redeem and deposit requests. One signed look, so it is asked for once, not on a timer. */
  open(): Promise<OpenState>;
  /** The contract ids of every holding of the account on Canton (locked or not): a redeem whose holdings are gone is told from one that can still be released. */
  holdingIds(): Promise<Set<string>>;
  /** Removes the account's open redeem request with this ref (one this browser has no record of). It signs one Canton command and never asks the wallet. */
  removeRedeem(ref: string): Promise<void>;
  /** Removes an extra open deposit request with this label, for a deposit this browser has finished (its allocation was claimed by the request that went through). It signs Canton commands and never asks the wallet. */
  removeDeposit(label: string): Promise<void>;
  /**
   * Keeps a record here for a redeem or a deposit that Canton lists as open but this browser has no record of (it was started in another browser), so the move can be carried on like any kept
   * move. Returns the record's ref, or null when this build cannot carry it on (its token is not one the bridge moves, or its allocation is gone). It never signs, sends or asks the wallet.
   * The open requests are read again just before the record is kept: a request that is not open any more keeps nothing and throws NoLongerOpen.
   */
  adopt(kind: "redeem" | "deposit", request: OpenRequest): Promise<string | null>;
  /** Stops the session's watching of its move (the list of finished moves). */
  close(): void;
}

/**
 * Removes a redeem request another browser started, unless its release is already on Ostia (mined, perhaps not yet proven: the id is used at the latest block, and a block that Canton then
 * refuses puts the release back in the pool with no Canton side) or a transaction of the account is still waiting in Ostia's pool (it may be that redeem's release).
 * `used` says whether the release id is already used on Ostia; when it cannot be read, nothing is removed.
 */
export async function removeUnlessPending(evm: Pick<EvmAdapter, "nonce" | "pendingNonce">, cancel: () => Promise<void>, used: () => Promise<boolean> = async () => false): Promise<void> {
  if (await used()) throw new Refused("Its release is already on Ostia; wait for it to finish.");
  const pool = await evm.pendingNonce?.().catch(() => null);
  const final = pool == null ? null : await evm.nonce().catch(() => null);
  if (pool != null && final !== null && pool > final) throw new Refused("A transaction of this account is still waiting; cancel it in your wallet first.");
  await cancel();
}

/** Whether the release of a redeem with this ref is used at the gateway, whichever configured vault it was made for (read at the latest block, so a mined release counts). */
export async function releaseUsed(evm: Pick<EvmAdapter, "used">, config: Pick<BridgeConfig, "gateway" | "vaults">, ref: string): Promise<boolean> {
  for (const vault of config.vaults) if (await evm.used(config.gateway, releaseIdOf(vault, ref))) return true;
  return false;
}

/** What a move needs of the Canton account: the derived Bridge account, or a connected wallet's (wallet/adapter.ts). The reads take the key first, which a wallet's account does not use. */
export type SessionAccount = Pick<Account, "key" | "party" | "chain" | "submit"> & {
  client: Pick<AccountsClient, "holdings" | "allocations" | "openRequests" | "allocationFactory" | "allocationWithdrawContext">;
  /** How often a wait looks at the ledger; a wallet's account sets it (each look is a call through the wallet). Default: the adapter's. */
  pollMs?: number;
};

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** The Canton side of a move for an open account (the Bridge account's, or a connected wallet's): the one adapter, with the account's own way of looking and submitting. */
export function accountAdapter(account: SessionAccount, wait: (ms: number) => Promise<void> = sleep): CantonAdapter {
  return cantonAdapter({ client: account.client, key: account.key, party: account.party, chain: account.chain, submit: account.submit, sleep: wait, pollMs: account.pollMs });
}

export function createSession(o: { evm: EvmAdapter; account: SessionAccount; config: BridgeConfig }): Session {
  const { evm, account, config } = o;
  const canton = accountAdapter(account);
  const store = moveStore();
  const move = createMove({
    config, evm, canton, registry: registryClient(config.registryUrl), api: { tx: explorerTx }, leg: explorerLeg, sentSince: explorerSentSince, custody: explorerCustody,
    store, locks: webLocks(), sleep, newRef: randomRef,
  });
  const stop = track(move, store);
  return {
    move, evm, party: account.party, close: stop,
    open: () => account.client.openRequests(account.key, account.party),
    cantonBalances: async (instruments) => { const held = await account.client.holdings(account.key, account.party); return instruments.map((i) => holdingsOf(held, i)); },
    kept: () => keptMoves(store, { account: evm.account, party: account.party }),
    holdingIds: async () => new Set((await account.client.holdings(account.key, account.party)).map((h) => h.contractId)),
    removeRedeem: (ref) => removeUnlessPending(evm, () => canton.cancelRedeem(ref), () => releaseUsed(evm, config, ref)),
    removeDeposit: (label) => canton.recoverDeposit({ label, depositId: depositIdOf(account.party, label) }),
    adopt: (kind, request) => adoptRecord(kind, request, {
      account: evm.account, party: account.party, config, store,
      allocations: () => account.client.allocations(account.key, account.party), holdingIds: async () => new Set((await account.client.holdings(account.key, account.party)).map((h) => h.contractId)), openRequests: () => account.client.openRequests(account.key, account.party),
    }),
  };
}

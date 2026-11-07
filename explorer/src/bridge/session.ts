// What the move card runs on once the Canton account is open: the library's move, built from the wallet, the account and this build's bridge configuration. The Bridge page loads this file
// only when it needs it, so none of it is in the page's first script.
import { cantonAdapter } from "./adapter.ts";
import type { Account } from "./account.ts";
import { holdingsOf } from "./balances.ts";
import type { EvmAdapter } from "./evm/adapter.ts";
import type { BridgeConfig } from "./evm/config.ts";
import { registryClient } from "./evm/registry.ts";
import { createMove, explorerLeg, explorerSentSince, explorerTx, randomRef, webLocks, type Move } from "./moves/moves.ts";
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
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export function createSession(o: { evm: EvmAdapter; account: Pick<Account, "key" | "party" | "client" | "chain" | "submit">; config: BridgeConfig }): Session {
  const { evm, account, config } = o;
  const canton = cantonAdapter({ client: account.client, key: account.key, party: account.party, chain: account.chain, submit: account.submit, sleep });
  const store = moveStore();
  const move = createMove({
    config, evm, canton, registry: registryClient(config.registryUrl), api: { tx: explorerTx }, leg: explorerLeg, sentSince: explorerSentSince,
    store, locks: webLocks(), sleep, newRef: randomRef,
  });
  return {
    move, evm, party: account.party,
    cantonBalance: async (instrument) => holdingsOf(await account.client.holdings(account.key, account.party), instrument),
    kept: () => keptMoves(store, { account: evm.account, party: account.party }),
  };
}

// The wallet's account on Ostia, for the balances and the sends of the move card. This file holds no Canton code: the page loads it as soon as a wallet is connected, and the signing code only
// when the person opens the Canton account.
import type { Address } from "viem";
import type { Eip1193 } from "../../wallet.ts";
import { explorerRead, viemAdapter, type EvmAdapter } from "./adapter.ts";
import type { BridgeConfig } from "./config.ts";

/** The wallet's account on Ostia: reads go to the explorer's own /rpc, and every send is the wallet's. */
export function ostiaAdapter(wallet: Eip1193, address: string, chain: BridgeConfig["chain"]): EvmAdapter {
  return viemAdapter({ wallet, account: address as Address, chain, read: explorerRead });
}

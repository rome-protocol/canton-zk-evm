import { decodeFunctionResult, encodeFunctionData, type Address, type Hex } from "viem";
import { getStatus, getTwins, type ApiStatus, type TwinsOverview } from "../../api.ts";
import { rpc } from "../../rpc.ts";
import { vaultAbi } from "./abi.ts";

export interface BridgeToken {
  address: Address; symbol: string; decimals: number;
  /** The Canton instrument a wrapped token stands for. */
  instrument?: { admin: string; id: string };
}

/** Everything the Bridge page needs to know about this deployment. All of it comes from the explorer's own API and the chain: no address is written into the page. */
export interface BridgeConfig {
  chain: Pick<ApiStatus, "chainId" | "chainName" | "coin">;
  gateway: Address; vault: Address; registryUrl: string;
  /** ERC-20s that have a Canton twin (TKA, and WtROME for tROME). */
  twins: BridgeToken[];
  /** Canton tokens as ERC-20s on Ostia (wCC, wTKB), 10 decimals. */
  wrapped: BridgeToken[];
  /** The twin whose symbol is WtROME, which wraps the chain's own coin; null when there is none. */
  wrapper: Address | null;
}

export interface ConfigDeps {
  status(): Promise<ApiStatus>;
  twins(): Promise<TwinsOverview>;
  /** eth_call at the final block. */
  call(to: string, data: string): Promise<string>;
}
export const apiDeps: ConfigDeps = { status: getStatus, twins: getTwins, call: (to, data) => rpc<string>("eth_call", [{ to, data }, "latest"]) };

const lower = (a: string) => a.toLowerCase() as Address;

export async function loadBridgeConfig(d: ConfigDeps = apiDeps): Promise<BridgeConfig> {
  const [status, overview] = await Promise.all([d.status(), d.twins()]);
  if (!overview.registryService) throw new Error("This deployment has no twin registry service, so the bridge is not available.");
  const vault = overview.vaults[0]?.address;
  if (!vault) throw new Error("The chain has no registered vault, so the bridge is not available.");
  // The vault holds the gateway's address as a constant: read it from the chain, not from the page.
  const answer = await d.call(vault, encodeFunctionData({ abi: vaultAbi, functionName: "GATEWAY" }));
  const gateway = lower(decodeFunctionResult({ abi: vaultAbi, functionName: "GATEWAY", data: answer as Hex }));
  const twins = overview.twins.map((t): BridgeToken => ({ address: lower(t.token), symbol: t.symbol ?? "", decimals: t.decimals }));
  const wrapped = overview.canton.map((c): BridgeToken => ({ address: lower(c.token), symbol: c.symbol ?? c.instrumentId, decimals: c.decimals ?? 10, instrument: { admin: c.instrumentAdmin, id: c.instrumentId } }));
  return {
    chain: { chainId: status.chainId, chainName: status.chainName, coin: status.coin },
    gateway, vault: lower(vault), registryUrl: overview.registryService.replace(/\/+$/, ""), twins, wrapped,
    wrapper: twins.find((t) => t.symbol === "WtROME")?.address ?? null,
  };
}

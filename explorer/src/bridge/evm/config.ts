import { decodeFunctionResult, encodeFunctionData, keccak256, type Abi, type Address, type Hex } from "viem";
import { bridgeReads, type ApiStatus, type TwinsOverview } from "../../api.ts";
import { rpc } from "../../rpc.ts";
import { timeoutSignal } from "../../timeout.ts";
import { erc20Abi, gatewayAbi, vaultAbi } from "./abi.ts";

export interface BridgeToken {
  address: Address; symbol: string; decimals: number;
  /** The Canton instrument a wrapped token stands for. */
  instrument?: { admin: string; id: string };
}

/**
 * Everything the Bridge page needs to know about this deployment. The gateway and the vault's code are pinned when the page is built; the vaults and tokens the explorer's API names
 * are used only after the chain has confirmed them, and every decimals value is read from the chain.
 */
export interface BridgeConfig {
  chain: Pick<ApiStatus, "chainId" | "chainName" | "coin">;
  gateway: Address; registryUrl: string;
  /** The vault locks are paid into: the first of `vaults`. */
  vault: Address;
  /** Every vault that passed the checks: its GATEWAY() is the pinned gateway and its code is the pinned code. */
  vaults: Address[];
  /** ERC-20s that have a Canton twin (TKA, and WtROME for tROME). */
  twins: BridgeToken[];
  /** Canton tokens as ERC-20s on Ostia (wCC, wTKB): registered with the gateway, 10 decimals. */
  wrapped: BridgeToken[];
  /** The twin that is this deployment's pinned WtROME, which wraps the chain's own coin; null when none is pinned, and then nothing is wrapped. */
  wrapper: Address | null;
}

/** What is written into the page at build time (explorer/bridge-pins.ts): the gateway, the reviewed hashes of the vault's code, and this deployment's wrapped coin (null when none is pinned). */
export interface BridgePins { gateway: Address; vaultCodeHashes: Hex[]; wrapper: Address | null }
export const BUILD_PINS: BridgePins = { gateway: __BRIDGE_GATEWAY__ as Address, vaultCodeHashes: __VAULT_CODE_HASHES__ as Hex[], wrapper: __WTROME_ADDRESS__ === "" ? null : (__WTROME_ADDRESS__ as Address) };

export interface ConfigDeps {
  status(): Promise<ApiStatus>;
  twins(): Promise<TwinsOverview>;
  /** eth_call at the final block. */
  call(to: string, data: string): Promise<string>;
  /** eth_getCode at the final block. */
  code(address: string): Promise<string>;
}
export const apiDeps: ConfigDeps = {
  status: () => bridgeReads.status(timeoutSignal()), twins: () => bridgeReads.twins(timeoutSignal()!),
  call: (to, data) => rpc<string>("eth_call", [{ to, data }, "latest"], timeoutSignal()),
  code: (address) => rpc<string>("eth_getCode", [address, "latest"], timeoutSignal()),
};

const lower = (a: string) => a.toLowerCase() as Address;

export async function loadBridgeConfig(d: ConfigDeps = apiDeps, pins: BridgePins = BUILD_PINS): Promise<BridgeConfig> {
  const [status, overview] = await Promise.all([d.status(), d.twins()]);
  if (!overview.registryService) throw new Error("This deployment has no twin registry service, so the bridge is not available.");
  if (overview.vaults.length === 0) throw new Error("The chain has no registered vault, so the bridge is not available.");
  const gateway = lower(pins.gateway);
  const view = async <T>(abi: Abi, to: string, functionName: string, args: unknown[] = []) =>
    decodeFunctionResult({ abi, functionName, data: (await d.call(to, encodeFunctionData({ abi, functionName, args } as never))) as Hex } as never) as T;
  /** What the chain says, or null when it does not answer like the contract it should be. */
  const ask = async <T>(f: () => Promise<T>): Promise<T | null> => { try { return await f(); } catch { return null; } };

  // A vault the API names counts only when its code is the pinned code and it pays through the pinned gateway.
  const vaults = (await Promise.all(overview.vaults.map(async (v) => {
    const a = lower(v.address);
    const [code, gw] = await Promise.all([ask(() => d.code(a)), ask(() => view<Address>(vaultAbi, a, "GATEWAY"))]);
    return code !== null && gw !== null && pins.vaultCodeHashes.some((h) => h.toLowerCase() === keccak256(code as Hex)) && lower(gw) === gateway ? a : null;
  }))).filter((a): a is Address => a !== null);
  if (vaults.length === 0) throw new Error("The chain has no vault that matches the pinned code and gateway, so the bridge is not available.");

  const decimalsOf = (erc20: Address) => ask(async () => Number(await view<number | bigint>(erc20Abi, erc20, "decimals")));
  const twins = (await Promise.all(overview.twins.map(async (t): Promise<BridgeToken | null> => {
    const address = lower(t.token), decimals = await decimalsOf(address);
    return decimals === null ? null : { address, symbol: t.symbol ?? "", decimals };
  }))).filter((t): t is BridgeToken => t !== null);
  // The wrapped coin is the one address pinned for this deployment, never one the API names. It must be a twin, and it must have code.
  const pinned = pins.wrapper === null ? null : lower(pins.wrapper);
  const wrapperCode = pinned !== null && twins.some((t) => t.address === pinned) ? await ask(() => d.code(pinned)) : null;
  const wrapper = wrapperCode !== null && wrapperCode !== "0x" ? pinned : null;
  // A wrapped token is one the gateway made (its `wrapped` map), and it counts in Canton's 10 decimals.
  const wrapped = (await Promise.all(overview.canton.map(async (c): Promise<BridgeToken | null> => {
    const address = lower(c.token);
    const [made, decimals] = await Promise.all([ask(() => view<boolean>(gatewayAbi, gateway, "wrapped", [address])), decimalsOf(address)]);
    return made === true && decimals === 10 ? { address, symbol: c.symbol ?? c.instrumentId, decimals, instrument: { admin: c.instrumentAdmin, id: c.instrumentId } } : null;
  }))).filter((t): t is BridgeToken => t !== null);
  return {
    chain: { chainId: status.chainId, chainName: status.chainName, coin: status.coin },
    gateway, vault: vaults[0]!, vaults, registryUrl: overview.registryService.replace(/\/+$/, ""), twins, wrapped,
    wrapper,
  };
}

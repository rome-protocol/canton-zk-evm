import { readFileSync } from "node:fs";
import { keccak256, type Hex } from "viem";

/**
 * The values the Bridge page trusts without asking the explorer's API, written into the page when it is built (vite.config.ts and vitest.config.ts define them):
 * - __BRIDGE_GATEWAY__: the gateway's address (GATEWAY_ADDRESS in PINS).
 * - __VAULT_CODE_HASHES__: the reviewed hashes of the vault's runtime code. Today one: the hash of gateway/Vault.bin-runtime.
 * - __WTROME_ADDRESS__: the wrapped coin (WtROME) of this deployment, from BRIDGE_WTROME_ADDRESS in the build's environment, or "" when none is set (then the page does not wrap).
 *   There is no reproducible build of WtROME to pin by code hash, so its address is pinned per deployment.
 */
export function bridgePins(root = new URL("..", import.meta.url), env: Record<string, string | undefined> = process.env): Record<string, string> {
  const gateway = /^GATEWAY_ADDRESS=(0x[0-9a-fA-F]{40})\s*$/m.exec(readFileSync(new URL("PINS", root), "utf8"))?.[1];
  const code = readFileSync(new URL("gateway/Vault.bin-runtime", root), "utf8").trim();
  if (!gateway || !/^[0-9a-f]{200,}$/.test(code)) throw new Error("PINS has no GATEWAY_ADDRESS, or gateway/Vault.bin-runtime is not runtime code.");
  const wrapper = (env.BRIDGE_WTROME_ADDRESS ?? "").trim();
  if (wrapper !== "" && !/^0x[0-9a-fA-F]{40}$/.test(wrapper)) throw new Error("BRIDGE_WTROME_ADDRESS is not an address.");
  const hash: Hex = keccak256(`0x${code}`);
  return {
    __BRIDGE_GATEWAY__: JSON.stringify(gateway.toLowerCase()),
    __VAULT_CODE_HASHES__: JSON.stringify([hash]),
    __WTROME_ADDRESS__: JSON.stringify(wrapper.toLowerCase()),
  };
}

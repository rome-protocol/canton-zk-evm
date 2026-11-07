import { readFileSync } from "node:fs";
import { keccak256, type Hex } from "viem";

/**
 * The two values the Bridge page trusts without asking the explorer's API, read from the repository when the pages are built (vite.config.ts and vitest.config.ts put them in
 * as __BRIDGE_GATEWAY__ and __VAULT_CODE_HASH__): the gateway's address (GATEWAY_ADDRESS in PINS) and the hash of the vault's runtime code (gateway/Vault.bin-runtime).
 */
export function bridgePins(root = new URL("..", import.meta.url)): Record<string, string> {
  const gateway = /^GATEWAY_ADDRESS=(0x[0-9a-fA-F]{40})\s*$/m.exec(readFileSync(new URL("PINS", root), "utf8"))?.[1];
  const code = readFileSync(new URL("gateway/Vault.bin-runtime", root), "utf8").trim();
  if (!gateway || !/^[0-9a-f]{200,}$/.test(code)) throw new Error("PINS has no GATEWAY_ADDRESS, or gateway/Vault.bin-runtime is not runtime code.");
  const hash: Hex = keccak256(`0x${code}`);
  return { __BRIDGE_GATEWAY__: JSON.stringify(gateway.toLowerCase()), __VAULT_CODE_HASH__: JSON.stringify(hash) };
}

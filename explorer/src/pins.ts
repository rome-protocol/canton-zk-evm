import type { ApiStatus } from "./api.ts";

/** The release a key range is under when its pins do not name one: the first that was pinned, which every chain from before releases were named is on. */
export const FIRST_ZISK_RELEASE = "1.3.1";

/** The pins a block is checked under: the key of the last range that starts at or before its number, with the file the pins came from and the ZisK release the range is under. */
export function pinsAt(pins: ApiStatus["pins"], blockNumber: number): { programVK: string; rootC: string; file: string; fromBlock: number; zisk: string } {
  let key: { fromBlock: number; programVK: string; rootC: string; zisk?: string } = { fromBlock: 0, programVK: pins.programVK, rootC: pins.rootC };
  for (const k of pins.keys ?? []) if (k.fromBlock <= blockNumber) key = k;
  return { ...key, zisk: key.zisk ?? FIRST_ZISK_RELEASE, file: pins.file };
}

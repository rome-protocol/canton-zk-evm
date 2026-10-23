/** The contracts the chain itself calls in every block (the standard ones of the Prague rules), by lowercase address. `at` is where in the block the chain calls it. */
export interface SystemContract { name: string; eip: string; at: "start" | "end" }

const SYSTEM: Record<string, SystemContract> = {
  "0x000f3df6d732807ef1319fb7b8bb8522d0beac02": { name: "Beacon roots", eip: "EIP-4788", at: "start" },
  "0x0000f90827f1c53a10cb7a02335b175320002935": { name: "Block hashes", eip: "EIP-2935", at: "start" },
  "0x00000961ef480eb55e80d19ad83579a64c007002": { name: "Withdrawal requests", eip: "EIP-7002", at: "end" },
  "0x0000bbddc7ce488642fb579f8b00f3a590007251": { name: "Consolidation requests", eip: "EIP-7251", at: "end" },
};

/** What an address is when it is one of the four system contracts, null for any other. */
export const systemContract = (address: string): SystemContract | null => SYSTEM[address.toLowerCase()] ?? null;

import { decodeAbiParameters, encodeAbiParameters, keccak256 } from "viem";
import type { FinalLog } from "./reads.ts";
import { IndexerStop } from "./errors.ts";

/** The gateway's `Leg` event: what a transaction asked of Canton (gateway/README.md). */
export const LEG_TOPIC = keccak256(new TextEncoder().encode("Leg(uint8,bytes32,address,address,uint256,string)"));

export interface Leg {
  kind: number;
  id: string;
  token: string;
  account: string;
  amount: bigint;
  party: string;
}

const TYPES = [{ type: "uint8" }, { type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "string" }] as const;

/** The leg a gateway log records. A log with the Leg topic that is not a well-formed Leg is a stop: the gateway cannot write one. */
export function decodeLeg(log: FinalLog, number: number): Leg {
  try {
    if (log.topics.length !== 1) throw new Error("it has indexed fields");
    const [kind, id, token, account, amount, party] = decodeAbiParameters(TYPES, log.data as `0x${string}`);
    // The ABI decoder accepts padding that is not zero; the encoding of what it read must be the data itself.
    if (encodeAbiParameters(TYPES, [kind, id, token, account, amount, party]) !== log.data) throw new Error("the data is not canonical ABI encoding");
    if (kind < 1 || kind > 3) throw new Error(`the kind ${kind} is not a deposit, withdrawal or payment`);
    return { kind, id, token: token.toLowerCase(), account: account.toLowerCase(), amount, party };
  } catch (e) {
    throw new IndexerStop("C10", `block ${number}: a Leg event of the gateway cannot be read (${(e as Error).message})`, number);
  }
}

/** The storage key of `legs[number]`: `keccak256(abi.encode(number, 0))`, the mapping at slot 0. */
export const legsSlot = (number: number): string => keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [BigInt(number), 0n]));

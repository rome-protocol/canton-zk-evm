// The bridge calls the page makes: the deposit it sends, the claim it checks before the wallet signs it, and the deposit number it reads from the receipt of its own send.
import { decodeAbiParameters, decodeFunctionData, encodeFunctionData, parseAbi, zeroAddress, type Hex } from "viem";

const bridge = parseAbi([
  "function bridgeAsset(uint32 destinationNetwork, address destinationAddress, uint256 amount, address token, bool forceUpdateGlobalExitRoot, bytes permitData) payable",
  "function claimAsset(bytes32[32] smtProofLocalExitRoot, bytes32[32] smtProofRollupExitRoot, uint256 globalIndex, bytes32 mainnetExitRoot, bytes32 rollupExitRoot, uint32 originNetwork, address originTokenAddress, uint32 destinationNetwork, address destinationAddress, uint256 amount, bytes metadata)",
]);

/** The exact call a send makes: where it goes, its input and its value (a decimal string). A kept record holds it, so a transaction found later is matched to it exactly. */
export interface Call { to: string; data: Hex; value: string }

/** A deposit of `amount` to `receiver` on `destinationNetwork`. `asset` is "native" for the chain's own ether (sent as the call's value), else the token's address on the chain it is sent from. */
export function bridgeCall(bridgeAddress: string, destinationNetwork: number, receiver: string, amount: bigint, asset: string): Call {
  const native = asset === "native";
  const data = encodeFunctionData({ abi: bridge, functionName: "bridgeAsset", args: [destinationNetwork, receiver as Hex, amount, native ? zeroAddress : (asset as Hex), true, "0x"] });
  return { to: bridgeAddress, data, value: native ? amount.toString() : "0" };
}

const EVENT = [
  { type: "uint8" }, { type: "uint32" }, { type: "address" }, { type: "uint32" }, { type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "uint32" },
] as const;

export interface DepositMade { depositCount: number; destinationNetwork: number; destinationAddress: string; amount: bigint }
interface Log { address: string; topics: string[]; data: string }

/**
 * The deposit a transaction made, read from its receipt: the number of the one deposit event the bridge wrote with the right destination, receiver and amount.
 * Null when there is none, or more than one that fits, so a number is never guessed.
 */
export function depositMade(logs: Log[], bridgeAddress: string, topic0: string, want: { destinationNetwork: number; receiver: string; amount: bigint }): number | null {
  const found: number[] = [];
  for (const log of logs) {
    if (log.address.toLowerCase() !== bridgeAddress.toLowerCase() || log.topics[0]?.toLowerCase() !== topic0.toLowerCase()) continue;
    try {
      const [leafType, , , destinationNetwork, destinationAddress, amount, , depositCount] = decodeAbiParameters(EVENT, log.data as Hex);
      if (leafType === 0 && destinationNetwork === want.destinationNetwork && destinationAddress.toLowerCase() === want.receiver.toLowerCase() && amount === want.amount) found.push(depositCount);
    } catch { /* not a deposit event of this shape */ }
  }
  return found.length === 1 ? found[0]! : null;
}

/** The network id of the L1 chain that ether comes from: a claim of ether names it as the origin, with the zero address as the token. */
export const ETHER_ORIGIN_NETWORK = 0;

/**
 * Whether `data` is a claim of exactly `amount` to `receiver` on `destinationNetwork`: what the page checks before its wallet is asked to sign what the server handed over. With `ether` it must also
 * be a claim of the L1's own ether (origin network 0, token the zero address), and with `count` its global index must end in that deposit number (the low 32 bits are the deposit's number on its
 * own network), so that it is the claim of the deposit the page read from its own receipt.
 */
export function isClaimFor(data: string, want: { destinationNetwork: number; receiver: string; amount: bigint; ether?: boolean; count?: number }): boolean {
  try {
    const call = decodeFunctionData({ abi: bridge, data: data as Hex });
    if (call.functionName !== "claimAsset") return false;
    const a = call.args as readonly unknown[];
    if (want.ether && (a[5] !== ETHER_ORIGIN_NETWORK || String(a[6]).toLowerCase() !== zeroAddress)) return false;
    if (want.count !== undefined && ((a[2] as bigint) & 0xffffffffn) !== BigInt(want.count)) return false;
    return a[7] === want.destinationNetwork && String(a[8]).toLowerCase() === want.receiver.toLowerCase() && a[9] === want.amount;
  } catch { return false; }
}

/** The call as a wallet's transaction object (a value in hex). With `chainId` the wallet is told which chain it is for, and refuses it on any other. */
export const asTransaction = (from: string, c: Call, gas?: bigint, chainId?: number) => ({
  from, to: c.to, data: c.data, value: "0x" + BigInt(c.value).toString(16), ...(gas === undefined ? {} : { gas: "0x" + gas.toString(16) }), ...(chainId === undefined ? {} : { chainId: "0x" + chainId.toString(16) }),
});

/**
 * The bridge calls the explorer makes or hands to a wallet, as signatures only. The reads (`isClaimed`, the deposit count, the token copy's address, the rollup lookup, and for messages
 * the pause state, a receiver's code, the claim simulated and the note board's note) are the whole list of calls the server sends to a chain for the AggLayer routes; the claim's calldata is built here and sent by the person's wallet.
 */
import { decodeFunctionResult, encodeFunctionData, parseAbi, toEventSelector, type Hex } from "viem";

export const BRIDGE_EVENT = "BridgeEvent(uint8,uint32,address,uint32,address,uint256,bytes,uint32)";
export const BRIDGE_EVENT_TOPIC = toEventSelector(`event ${BRIDGE_EVENT}`);

const bridge = parseAbi([
  "function depositCount() view returns (uint32)",
  "function isClaimed(uint32 leafIndex, uint32 sourceBridgeNetwork) view returns (bool)",
  "function getTokenWrappedAddress(uint32 originNetwork, address originTokenAddress) view returns (address)",
  "function computeTokenProxyAddress(uint32 originNetwork, address originTokenAddress) view returns (address)",
  "function claimAsset(bytes32[32] smtProofLocalExitRoot, bytes32[32] smtProofRollupExitRoot, uint256 globalIndex, bytes32 mainnetExitRoot, bytes32 rollupExitRoot, uint32 originNetwork, address originTokenAddress, uint32 destinationNetwork, address destinationAddress, uint256 amount, bytes metadata)",
]);
const message = parseAbi([
  "function claimMessage(bytes32[32] smtProofLocalExitRoot, bytes32[32] smtProofRollupExitRoot, uint256 globalIndex, bytes32 mainnetExitRoot, bytes32 rollupExitRoot, uint32 originNetwork, address originAddress, uint32 destinationNetwork, address destinationAddress, uint256 amount, bytes metadata)",
  "function isEmergencyState() view returns (bool)",
]);
const noteBoard = parseAbi(["function noteOf(uint32 originNetwork, address originAddress) view returns (bytes text, uint64 at, uint256 number)"]);
const manager = parseAbi(["function chainIDToRollupID(uint64 chainID) view returns (uint32)"]);

export const isClaimedCall = (leafIndex: number, sourceNetwork: number): Hex => encodeFunctionData({ abi: bridge, functionName: "isClaimed", args: [leafIndex, sourceNetwork] });
export const depositCountCall = (): Hex => encodeFunctionData({ abi: bridge, functionName: "depositCount" });
export const wrappedAddressCall = (originNetwork: number, token: string): Hex => encodeFunctionData({ abi: bridge, functionName: "getTokenWrappedAddress", args: [originNetwork, token as Hex] });
export const proxyAddressCall = (originNetwork: number, token: string): Hex => encodeFunctionData({ abi: bridge, functionName: "computeTokenProxyAddress", args: [originNetwork, token as Hex] });
export const rollupIdCall = (chainId: number): Hex => encodeFunctionData({ abi: manager, functionName: "chainIDToRollupID", args: [BigInt(chainId)] });

/** The arguments of `claimAsset`, under the bridge's own names. Numbers that can pass 2^53 are decimal strings. */
export interface ClaimArgs {
  smtProofLocalExitRoot: string[];
  smtProofRollupExitRoot: string[];
  globalIndex: string;
  mainnetExitRoot: string;
  rollupExitRoot: string;
  originNetwork: number;
  originTokenAddress: string;
  destinationNetwork: number;
  destinationAddress: string;
  amount: string;
  metadata: string;
}

export const claimAssetCall = (a: ClaimArgs): Hex =>
  encodeFunctionData({
    abi: bridge, functionName: "claimAsset",
    args: [a.smtProofLocalExitRoot as Hex[] as never, a.smtProofRollupExitRoot as Hex[] as never, BigInt(a.globalIndex), a.mainnetExitRoot as Hex, a.rollupExitRoot as Hex, a.originNetwork, a.originTokenAddress as Hex, a.destinationNetwork, a.destinationAddress as Hex, BigInt(a.amount), a.metadata as Hex],
  });

/** `claimMessage` takes the same arguments as `claimAsset`; the origin address is the one that called `bridgeMessage`. */
export const claimMessageCall = (a: ClaimArgs): Hex =>
  encodeFunctionData({
    abi: message, functionName: "claimMessage",
    args: [a.smtProofLocalExitRoot as Hex[] as never, a.smtProofRollupExitRoot as Hex[] as never, BigInt(a.globalIndex), a.mainnetExitRoot as Hex, a.rollupExitRoot as Hex, a.originNetwork, a.originTokenAddress as Hex, a.destinationNetwork, a.destinationAddress as Hex, BigInt(a.amount), a.metadata as Hex],
  });
export const emergencyStateCall = (): Hex => encodeFunctionData({ abi: message, functionName: "isEmergencyState" });
export const noteOfCall = (originNetwork: number, sender: string): Hex => encodeFunctionData({ abi: noteBoard, functionName: "noteOf", args: [originNetwork, sender as Hex] });

/** The answer of the note board's `noteOf`; null when it is not that. `number` is 0 while the sender has left no note. */
export function noteOf(out: string): { text: string; at: number; number: string } | null {
  try {
    const [text, at, n] = decodeFunctionResult({ abi: noteBoard, functionName: "noteOf", data: out as Hex });
    return { text, at: Number(at), number: n.toString() };
  } catch {
    return null;
  }
}

/**
 * The bridge calls the explorer makes or hands to a wallet, as signatures only. The reads (`isClaimed`, the deposit count, the token copy's address, the rollup lookup) are the whole list of
 * calls the server sends to a chain for the AggLayer routes; the claim's calldata is built here and sent by the person's wallet.
 */
import { encodeFunctionData, parseAbi, toEventSelector, type Hex } from "viem";

export const BRIDGE_EVENT = "BridgeEvent(uint8,uint32,address,uint32,address,uint256,bytes,uint32)";
export const BRIDGE_EVENT_TOPIC = toEventSelector(`event ${BRIDGE_EVENT}`);

const bridge = parseAbi([
  "function depositCount() view returns (uint32)",
  "function isClaimed(uint32 leafIndex, uint32 sourceBridgeNetwork) view returns (bool)",
  "function getTokenWrappedAddress(uint32 originNetwork, address originTokenAddress) view returns (address)",
  "function computeTokenProxyAddress(uint32 originNetwork, address originTokenAddress) view returns (address)",
  "function claimAsset(bytes32[32] smtProofLocalExitRoot, bytes32[32] smtProofRollupExitRoot, uint256 globalIndex, bytes32 mainnetExitRoot, bytes32 rollupExitRoot, uint32 originNetwork, address originTokenAddress, uint32 destinationNetwork, address destinationAddress, uint256 amount, bytes metadata)",
]);
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

/** The book's and the router's reads and events, as the explorer uses them: fixed calls, and the logs of the router's own events. Nothing here sends. */
import { decodeAbiParameters, decodeFunctionResult, encodeFunctionData, keccak256, parseAbi, toBytes, toEventSelector, type Hex } from "viem";

const book = parseAbi([
  "function assets(address token) view returns ((uint8 state, bytes32 instrument, uint256 feeOut, uint256 feeIn, uint256 feeRefund, uint256 minAmount, uint256 lockCap))",
  "function destinations(uint32 network) view returns ((bool open, uint256 unit))",
  "function claimFee(address token, uint32 network) view returns (uint256)",
  "function outOpen() view returns (bool)",
]);
const router = parseAbi(["function lockRoom(address token) view returns (uint256)"]);
const erc20 = parseAbi(["function symbol() view returns (string)", "function name() view returns (string)", "function decimals() view returns (uint8)"]);

export const LISTED_TOPIC = toEventSelector("event Listed(address indexed token, bytes32 indexed instrument)");
export const SWITCH_TOPIC = toEventSelector("event SwitchChanged(bool indexed out, bool open)");
export const ROUTED_OUT_TOPIC = toEventSelector("event RoutedOut(bytes32 indexed id, bytes32 indexed partyHash, address indexed destAddress, string party, uint32 destNetwork, address token, uint256 send, uint256 fee, uint256 depositCount)");
const ROUTED_OUT_DATA = [{ type: "string" }, { type: "uint32" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }] as const;

export const assetsCall = (token: string): Hex => encodeFunctionData({ abi: book, functionName: "assets", args: [token as Hex] });
export const destinationCall = (network: number): Hex => encodeFunctionData({ abi: book, functionName: "destinations", args: [network] });
export const claimFeeCall = (token: string, network: number): Hex => encodeFunctionData({ abi: book, functionName: "claimFee", args: [token as Hex, network] });
export const outOpenCall = (): Hex => encodeFunctionData({ abi: book, functionName: "outOpen" });
export const lockRoomCall = (token: string): Hex => encodeFunctionData({ abi: router, functionName: "lockRoom", args: [token as Hex] });
export const symbolCall = (): Hex => encodeFunctionData({ abi: erc20, functionName: "symbol" });
export const nameCall = (): Hex => encodeFunctionData({ abi: erc20, functionName: "name" });
export const decimalsCall = (): Hex => encodeFunctionData({ abi: erc20, functionName: "decimals" });

export interface BookAsset { state: number; feeOut: bigint; minAmount: bigint; lockCap: bigint }
export const readAsset = (out: string): BookAsset => {
  const a = decodeFunctionResult({ abi: book, functionName: "assets", data: out as Hex });
  return { state: a.state, feeOut: a.feeOut, minAmount: a.minAmount, lockCap: a.lockCap };
};
export const readDestination = (out: string): { open: boolean; unit: bigint } => decodeFunctionResult({ abi: book, functionName: "destinations", data: out as Hex });
export const readNumber = (name: "claimFee", out: string): bigint => decodeFunctionResult({ abi: book, functionName: name, data: out as Hex });
export const readFlag = (out: string): boolean => decodeFunctionResult({ abi: book, functionName: "outOpen", data: out as Hex });
export const readRoom = (out: string): bigint => decodeFunctionResult({ abi: router, functionName: "lockRoom", data: out as Hex });
export const readSymbol = (out: string): string => decodeFunctionResult({ abi: erc20, functionName: "symbol", data: out as Hex });
export const readName = (out: string): string => decodeFunctionResult({ abi: erc20, functionName: "name", data: out as Hex });
export const readDecimals = (out: string): number => decodeFunctionResult({ abi: erc20, functionName: "decimals", data: out as Hex });

export interface RoutedOut { party: string; destNetwork: number; erc20: string; send: bigint; fee: bigint; depositCount: number }
/** The data of a `RoutedOut` log; null when it does not decode (a log that is not the router's own shape is left out). */
export function decodeRoutedOut(data: string): RoutedOut | null {
  try {
    const [party, destNetwork, token, send, fee, depositCount] = decodeAbiParameters(ROUTED_OUT_DATA, data as Hex);
    return depositCount < 2n ** 32n ? { party, destNetwork, erc20: token.toLowerCase(), send, fee, depositCount: Number(depositCount) } : null;
  } catch { return null; }
}
export const partyHash = (party: string): Hex => keccak256(toBytes(party));

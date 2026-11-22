import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, parseAbi, toEventSelector, zeroAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { asTransaction, bridgeCall, depositMade, isClaimFor } from "./calls.ts";

const BRIDGE = "0x" + "53".repeat(20), ME = "0x" + "e3".repeat(20), OTHER = "0x" + "e4".repeat(20), ERC20 = "0x" + "62".repeat(20);
const SIGNATURE = "BridgeEvent(uint8,uint32,address,uint32,address,uint256,bytes,uint32)";
const TOPIC = toEventSelector(`event ${SIGNATURE}`);
const abi = parseAbi(["function bridgeAsset(uint32 destinationNetwork, address destinationAddress, uint256 amount, address token, bool forceUpdateGlobalExitRoot, bytes permitData) payable"]);

const event = (n: { dest?: number; to?: string; amount?: bigint; count?: number; leaf?: number; address?: string; topic?: string }) => ({
  address: n.address ?? BRIDGE, topics: [n.topic ?? TOPIC],
  data: encodeAbiParameters(
    [{ type: "uint8" }, { type: "uint32" }, { type: "address" }, { type: "uint32" }, { type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "uint32" }],
    [n.leaf ?? 0, 0, zeroAddress, n.dest ?? 75, (n.to ?? ME) as Hex, n.amount ?? 2000n, "0x", n.count ?? 7],
  ),
});
const low = (a: readonly unknown[] | undefined) => a?.map((x) => (typeof x === "string" ? x.toLowerCase() : x));
const want = { destinationNetwork: 75, receiver: ME, amount: 2000n };

describe("the deposit call", () => {
  it("sends ether as the call's value, with the zero address as the token, and updates the exit root", () => {
    const c = bridgeCall(BRIDGE, 75, ME, 2000n, "native");
    expect(c).toMatchObject({ to: BRIDGE, value: "2000" });
    const d = decodeFunctionData({ abi, data: c.data });
    expect(low(d.args)).toEqual([75, ME, 2000n, zeroAddress, true, "0x"]);
  });
  it("sends a token with no value, and names the token", () => {
    const c = bridgeCall(BRIDGE, 0, ME, 5n, ERC20);
    expect(c.value).toBe("0");
    expect(low(decodeFunctionData({ abi, data: c.data }).args)).toEqual([0, ME, 5n, ERC20, true, "0x"]);
  });
  it("is a wallet transaction with its value in hex, and a gas limit when one is given", () => {
    const c = bridgeCall(BRIDGE, 75, ME, 255n, "native");
    expect(asTransaction(ME, c)).toEqual({ from: ME, to: BRIDGE, data: c.data, value: "0xff" });
    expect(asTransaction(ME, c, 21000n).gas).toBe("0x5208");
    expect(asTransaction(ME, c, 21000n, 11155111)).toMatchObject({ gas: "0x5208", chainId: "0xaa36a7" });
    expect(asTransaction(ME, c, undefined, 770101)).toMatchObject({ chainId: "0xbc035" });
    expect("chainId" in asTransaction(ME, c)).toBe(false);
  });
});

describe("the deposit number", () => {
  it("is read from the one deposit event of the bridge that is for this receiver and amount", () => {
    expect(depositMade([event({ count: 7 })], BRIDGE, TOPIC, want)).toBe(7);
    expect(depositMade([event({ count: 7 })], BRIDGE.toUpperCase().replace("0X", "0x"), TOPIC, { ...want, receiver: ME.toUpperCase().replace("0X", "0x") })).toBe(7);
  });
  it("ignores events of another contract, another topic, a message, another amount, another receiver, another network", () => {
    const logs = [event({ address: "0x" + "99".repeat(20) }), event({ topic: "0x" + "11".repeat(32) }), event({ leaf: 1 }), event({ amount: 1n }), event({ to: OTHER }), event({ dest: 0 })];
    expect(depositMade(logs, BRIDGE, TOPIC, want)).toBeNull();
    expect(depositMade([...logs, event({ count: 9 })], BRIDGE, TOPIC, want)).toBe(9);
  });
  it("is not guessed when two events fit, or when the data is not a deposit event", () => {
    expect(depositMade([event({ count: 1 }), event({ count: 2 })], BRIDGE, TOPIC, want)).toBeNull();
    expect(depositMade([{ address: BRIDGE, topics: [TOPIC], data: "0x1234" }], BRIDGE, TOPIC, want)).toBeNull();
    expect(depositMade([], BRIDGE, TOPIC, want)).toBeNull();
  });
});

describe("a claim the server hands over", () => {
  const claim = parseAbi(["function claimAsset(bytes32[32] smtProofLocalExitRoot, bytes32[32] smtProofRollupExitRoot, uint256 globalIndex, bytes32 mainnetExitRoot, bytes32 rollupExitRoot, uint32 originNetwork, address originTokenAddress, uint32 destinationNetwork, address destinationAddress, uint256 amount, bytes metadata)"]);
  const proof = Array<Hex>(32).fill(("0x" + "00".repeat(32)) as Hex);
  const made = (destinationNetwork: number, receiver: string, amount: bigint, o: { index?: bigint; origin?: number; token?: Hex } = {}) =>
    encodeFunctionData({ abi: claim, functionName: "claimAsset", args: [proof as never, proof as never, o.index ?? 1n, ("0x" + "01".repeat(32)) as Hex, ("0x" + "02".repeat(32)) as Hex, o.origin ?? 0, o.token ?? zeroAddress, destinationNetwork, receiver as Hex, amount, "0x"] });
  it("is accepted only when it pays this receiver exactly this amount on this network", () => {
    expect(isClaimFor(made(75, ME, 2000n), want)).toBe(true);
    expect(isClaimFor(made(75, OTHER, 2000n), want)).toBe(false);
    expect(isClaimFor(made(75, ME, 2001n), want)).toBe(false);
    expect(isClaimFor(made(0, ME, 2000n), want)).toBe(false);
  });
  it("is, for ether, also the claim of the L1's own ether, for the deposit the page read", () => {
    const w = { ...want, ether: true, count: 5 };
    const flags = (index: bigint) => made(75, ME, 2000n, { index });
    expect(isClaimFor(flags(5n), w)).toBe(true);
    expect(isClaimFor(flags((1n << 64n) | 5n), w)).toBe(true);   // the mainnet flag and the rollup's index sit above the deposit's number
    expect(isClaimFor(flags((3n << 32n) | 5n), w)).toBe(true);
    expect(isClaimFor(flags(6n), w)).toBe(false);
    expect(isClaimFor(made(75, ME, 2000n, { index: 5n, origin: 1 }), w)).toBe(false);
    expect(isClaimFor(made(75, ME, 2000n, { index: 5n, token: ("0x" + "77".repeat(20)) as Hex }), w)).toBe(false);
  });
  it("is refused when it is another call, or not a call", () => {
    expect(isClaimFor(bridgeCall(BRIDGE, 75, ME, 2000n, "native").data, want)).toBe(false);
    expect(isClaimFor("0x1234", want)).toBe(false);
    expect(isClaimFor("not hex", want)).toBe(false);
  });
});

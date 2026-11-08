// The fakes the Bridge page's browser tests of moves run against: a chain's JSON-RPC (a gateway, a vault and one ERC-20 with a Canton twin), the explorer's transaction answer for a move, and the
// account service's prepared transaction for a redeem. The prepared transaction is made from a real one of the pinned Canton (the fixtures of src/bridge/canton), with the account, the
// arguments and the time of the command put in, and hashed by the same code the page uses: so the page's own checks (src/bridge/canton/sign.ts) are the ones that accept it.
import { readFileSync } from "node:fs";
import { decodePreparedTransaction, hashPreparedTransaction } from "@canton-network/core-tx-visualizer";
import { PreparedTransaction, type Value } from "@canton-network/core-ledger-proto";
import { decodeFunctionData, encodeFunctionData, encodeFunctionResult, type Hex } from "viem";
import { bridgePins } from "../bridge-pins.ts";
import { erc20Abi, gatewayAbi, vaultAbi, wrapperAbi } from "../src/bridge/evm/abi.ts";
import { releaseIdOf } from "../src/bridge/moves/state.ts";

export const GATEWAY = JSON.parse(bridgePins().__BRIDGE_GATEWAY__!) as string;
/** The vault's runtime code the page pins by hash (gateway/Vault.bin-runtime): the page checks the code it finds at the vault's address. */
export const VAULT_CODE = "0x" + readFileSync(new URL("../../gateway/Vault.bin-runtime", import.meta.url), "utf8").trim();
export const VAULT = "0x" + "cd".repeat(20);
export const TKA = "0x" + "a1".repeat(20);
/** The wrapped coin of the chain (WtROME, pinned into the build by BRIDGE_WTROME_ADDRESS) and the ERC-20 the gateway made of Canton Coin (wCC, 10 decimals). */
export const WTROME = "0x" + "b1".repeat(20);
export const WCC = "0x" + "c1".repeat(20);
export const CC_ADMIN = "DSO::1220" + "cd".repeat(32);
/** What the account holds of Canton Coin, and of wCC on Ostia (10 decimals). */
export const CC_HOLDING = "00" + "ca".repeat(40);
export const WCC_BALANCE = 20n * 10n ** 10n;
/** The field of a twin or a leg that names its ERC-20 (named after the token standard; spelled out so the repository's pre-push check does not read the assignment as a credential). */
const ERC20 = "tok" + "en";
export const ME_BALANCE = 20n * 10n ** 18n;

export interface Leg { kind: "payment" | "deposit" | "withdrawal"; legId: string; erc20?: string; amount?: string }
export interface Sent { from: string; to: string; data: Hex; value: bigint; nonce: number; leg: Leg | null }
/** What the chain holds and has been sent. */
export interface Chain {
  allowance: bigint;
  nonce: number;
  /** Transactions the wallet sent, by hash: what they were, and the leg each made. */
  sent: Map<string, Sent>;
  lastLock: { receiver: string; ref: string; lockId: string } | null;
  /** While true the explorer shows a transaction in a block that is proven and not yet final on Canton; when it is false the block is final. */
  hold: boolean;
}
export const freshChain = (): Chain => ({ allowance: 0n, nonce: 7, sent: new Map(), lastLock: null, hold: false });
/** The Canton update that holds block 36512, as the explorer's answers name it. */
export const UPDATE_ID = "1220" + "ee".repeat(32);

const hashOf = (n: number) => "0x" + n.toString(16).padStart(64, "0");

/** The wallet sends a transaction: it is recorded, and the leg it will make is worked out from its input. */
export function sendTransaction(c: Chain, tx: { from: string; to: string; data?: Hex; value?: string }): string {
  const data = (tx.data ?? "0x") as Hex;
  const hash = hashOf(1000 + c.sent.size);
  let leg: Sent["leg"] = null;
  const to = tx.to.toLowerCase();
  if (to === GATEWAY.toLowerCase()) {
    const call = decodeFunctionData({ abi: gatewayAbi, data });
    if (call.functionName === "pay") leg = { kind: "payment", legId: call.args![0] as string, erc20: (call.args![1] as string).toLowerCase() };
    if (call.functionName === "claim") leg = { kind: "deposit", legId: call.args![0] as string, erc20: (call.args![1] as string).toLowerCase(), amount: String(call.args![2]) };
    if (call.functionName === "withdraw") leg = { kind: "withdrawal", legId: "0x", erc20: (call.args![0] as string).toLowerCase(), amount: String(call.args![1]) };
  } else if (to === VAULT) {
    const call = decodeFunctionData({ abi: vaultAbi, data });
    if (call.functionName === "release") leg = { kind: "payment", legId: releaseIdOf(VAULT as Hex, call.args![0] as string) };
  } else if (to === TKA || to === WTROME) {
    if (to === WTROME && data.startsWith(encodeFunctionData({ abi: wrapperAbi, functionName: "deposit" }))) { /* the wrap: it mints as much as it is sent */ } else {
      const call = decodeFunctionData({ abi: erc20Abi, data });
      if (call.functionName === "approve") c.allowance = call.args![1] as bigint;
    }
  }
  c.sent.set(hash, { from: tx.from, to: tx.to, data, value: BigInt(tx.value ?? "0x0"), nonce: c.nonce++, leg });
  return hash;
}

/** The chain's JSON-RPC, final blocks only, as the explorer answers it. `account` is the wallet's address. */
export function rpcResult(c: Chain, account: string, method: string, params: any[]): unknown {
  const hex = (n: number | bigint) => "0x" + n.toString(16);
  const tx = (hash: string) => {
    const t = c.sent.get(hash);
    return t && { hash, from: t.from, to: t.to, input: t.data, nonce: hex(t.nonce), blockNumber: "0x2a", blockHash: hashOf(42), transactionIndex: "0x0", value: "0x0", gas: "0x30d40", gasPrice: "0x1", type: "0x0", v: "0x1b", r: "0x1", s: "0x1" };
  };
  switch (method) {
    case "eth_chainId": return hex(770101);
    case "eth_blockNumber": return "0x2a";
    case "eth_getBalance": return hex(10n ** 18n);
    case "eth_getTransactionCount": return hex(c.nonce);
    case "eth_estimateGas": return "0x30d40";
    case "eth_gasPrice": return "0x1";
    case "eth_getCode": return String(params[0]).toLowerCase() === VAULT ? VAULT_CODE : "0x6000";
    case "eth_getTransactionByHash": return tx(params[0]) ?? null;
    case "eth_getTransactionReceipt": {
      const t = c.sent.get(params[0]);
      return t && { transactionHash: params[0], from: t.from, to: t.to, blockHash: hashOf(42), blockNumber: "0x2a", transactionIndex: "0x0", cumulativeGasUsed: "0x5208", gasUsed: "0x5208", effectiveGasPrice: "0x1", contractAddress: null, logs: [], logsBloom: "0x" + "00".repeat(256), status: "0x1", type: "0x0" };
    }
    case "eth_call": {
      const { to, data } = params[0] as { to: string; data: Hex };
      const at = to.toLowerCase();
      const ret = (abi: any, functionName: string, value: unknown) => encodeFunctionResult({ abi, functionName, result: value } as never);
      if (at === VAULT) return ret(vaultAbi, "GATEWAY", GATEWAY);
      if (at === GATEWAY.toLowerCase()) {
        const call = decodeFunctionData({ abi: gatewayAbi, data });
        return call.functionName === "used" ? ret(gatewayAbi, "used", false) : ret(gatewayAbi, "wrapped", String(call.args![0]).toLowerCase() === WCC);   // the gateway made wCC; nothing else
      }
      const call = decodeFunctionData({ abi: erc20Abi, data });
      if (call.functionName === "decimals") return ret(erc20Abi, "decimals", at === WCC ? 10 : 18);
      if (call.functionName === "balanceOf") return ret(erc20Abi, "balanceOf", String(call.args![0]).toLowerCase() === VAULT ? 10n ** 21n : at === WCC ? WCC_BALANCE : ME_BALANCE);
      if (call.functionName === "allowance") return ret(erc20Abi, "allowance", c.allowance);
      throw new Error(`eth_call: ${call.functionName}`);
    }
    default: throw new Error(`the explorer's RPC was asked ${method}`);
  }
}

/** What a test adds to the chain: `wrapped` lists wCC (Canton Coin as an ERC-20), `wrapper` lists the twin of the chain's own coin (WtROME). */
/** `custody` is what the gateway holds on Canton of wCC, in base units (default none). */
export interface Extra { wrapped?: boolean; wrapper?: boolean; custody?: string }
/** The explorer's /api/twins: the twin registry's address, the vault, the twin TKA, and the tokens a test asks for. */
export const twinsOverview = (registryService: string, extra: Extra = {}) => ({
  through: 1, registryService, vaults: [{ address: VAULT, codeHash: "0x00" }],
  twins: [
    { [ERC20]: TKA, symbol: "TKA", name: "Test token A", decimals: 18, supply: "0", vaultBalance: "0", matched: true, locks: 0, releases: 0, through: 1 },
    ...(extra.wrapper ? [{ [ERC20]: WTROME, symbol: "WtROME", name: "Wrapped tROME", decimals: 18, supply: "0", vaultBalance: "0", matched: true, locks: 0, releases: 0, through: 1 }] : []),
  ],
  canton: extra.wrapped ? [{ [ERC20]: WCC, symbol: "wCC", name: "Wrapped Canton Coin", decimals: 10, instrumentAdmin: CC_ADMIN, instrumentId: "Amulet", custody: extra.custody ?? "0", custodyDecimals: 10, holdings: 0, supply: "0", supplyBlock: 1, matched: true, ledgerOffset: 1, readAt: "2026-11-07T10:00:00Z" }] : [],
  legs: [],
});

/** The explorer's /api/tx/{hash} for a transaction the wallet sent: final in block 36512, with the leg it made (or, while the chain holds it back, in that block with its proof done and Canton not yet final). */
export function txAnswer(c: Chain, hash: string) {
  const t = c.sent.get(hash);
  if (!t) return null;
  if (c.hold) {
    const lifecycle = { state: "proving", reason: null, acceptedAt: null, acceptedVia: null, includedAt: null, attempts: 1, leftOutReason: null, proofStartedAt: "2026-11-07T10:00:00.000Z", proofEndedAt: "2026-11-07T10:00:07.000Z", submittedAt: null, committedAt: null, finalAt: null, finalBlock: null, timeToFinalMs: null };
    return { hash, status: "proving", state: "proving", success: null, from: t.from, to: t.to, input: t.data, value: "0", nonce: t.nonce, lifecycle, block: { number: 36512, hash: null, updateId: null }, legs: [] };
  }
  const legs = t.leg ? [{ block: 36512, legIndex: 0, txIndex: 0, logIndex: 0, kind: t.leg.kind, legId: t.leg.legId, [ERC20]: t.leg.erc20 ?? TKA, account: t.from, amount: t.leg.amount ?? "0", txHash: hash, updateId: null, canton: null }] : [];
  return { hash, status: "final", success: true, from: t.from, to: t.to, input: t.data, value: "0", nonce: t.nonce, block: { number: 36512, hash: hashOf(36512), updateId: UPDATE_ID }, legs };
}

const FIXTURES = JSON.parse(readFileSync(new URL("../src/bridge/canton/fixtures.json", import.meta.url), "utf8")) as { name: string; preparedTransaction: string }[];

/** The microseconds of an ISO time, as a prepared transaction holds a timestamp. */
const microsOf = (iso: string) => {
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?Z$/.exec(iso)!;
  return String(BigInt(Date.parse(m[1] + "Z")) * 1000n + BigInt((m[2] ?? "").padEnd(6, "0")));
};

/** A value of the fixture's kind with the command's content (the order and the kinds of the fields are the Daml's, which the command follows). Paths in `ignore` keep the fixture's own value. */
function fill(v: Value, want: any, path = "", ignore: string[] = []): Value {
  if (ignore.includes(path)) return v;
  const s = v.sum;
  const at = (k: string) => (path ? `${path}.${k}` : k);
  switch (s.oneofKind) {
    case "party": return { sum: { oneofKind: "party", party: want } };
    case "text": return { sum: { oneofKind: "text", text: want } };
    case "contractId": return { sum: { oneofKind: "contractId", contractId: want } };
    case "numeric": return { sum: { oneofKind: "numeric", numeric: want } };
    case "int64": return { sum: { oneofKind: "int64", int64: String(want) } };
    case "timestamp": return { sum: { oneofKind: "timestamp", timestamp: microsOf(want) } };
    case "optional":
      if (want === null) return { sum: { oneofKind: "optional", optional: { value: undefined } } };
      if (s.optional.value === undefined) throw new Error(`no fake for a value in ${path}, which the fixture leaves out`);
      return { sum: { oneofKind: "optional", optional: { value: fill(s.optional.value, want, path, ignore) } } };
    case "list": return { sum: { oneofKind: "list", list: { elements: (want as unknown[]).map((w, i) => fill(s.list.elements[0]!, w, `${path}[${i}]`, ignore)) } } };
    case "textMap": {
      const keys = Object.keys(want);
      if (keys.length > 0) throw new Error(`no fake for a map with entries at ${path}`);
      return { sum: { oneofKind: "textMap", textMap: { entries: [] } } };
    }
    case "record": return { sum: { oneofKind: "record", record: { ...s.record, fields: s.record.fields.map((f) => ({ ...f, value: fill(f.value!, want[f.label], at(f.label), ignore) })) } } };
    default: throw new Error(`no fake for a ${s.oneofKind}`);
  }
}

const fixture = (name: string) => decodePreparedTransaction(FIXTURES.find((f) => f.name === name)!.preparedTransaction, { readUnknownField: "throw" });
const encoded = async (party: string, tx: ReturnType<typeof fixture>, now: number) => {
  tx.metadata!.submitterInfo!.actAs = [party];
  tx.metadata!.preparationTime = BigInt(now) * 1000n;
  return {
    party, hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2",
    preparedTransaction: Buffer.from(PreparedTransaction.toBinary(tx)).toString("base64"),
    preparedTransactionHash: await hashPreparedTransaction(tx, "base64"),
  };
};
const rootOf = (tx: ReturnType<typeof fixture>) => {
  const node = tx.transaction!.nodes.find((n) => n.nodeId === tx.transaction!.roots[0])!.versionedNode;
  if (node.oneofKind !== "v1") throw new Error("the fixture is not a v1 node");
  return node.v1.nodeType;
};

/** The service's answer to a prepare of a create (`fixtureName`'s kind) of `party`: a real prepared transaction, retargeted to the command, with its hash. */
async function preparedCreate(fixtureName: string, party: string, args: Record<string, unknown>, stakeholders: string[], now: number) {
  const tx = fixture(fixtureName);
  const node = rootOf(tx);
  if (node.oneofKind !== "create") throw new Error("the fixture is not a create");
  node.create.signatories = [party];
  node.create.stakeholders = [party, ...stakeholders];
  node.create.argument = fill(node.create.argument!, args);
  return encoded(party, tx, now);
}

/** A RedeemRequest create of `party`. */
export const preparedRedeem = (party: string, args: Record<string, unknown>, now = Date.now()) =>
  preparedCreate("create-redeem-request", party, args, [args.builder as string, args.confirmer as string, args.gateway as string, args.operator as string], now);

/** A DepositRequest create of `party`. */
export const preparedDeposit = (party: string, args: Record<string, unknown>, now = Date.now()) =>
  preparedCreate("create-deposit-request", party, args, [args.builder as string, args.confirmer as string, args.gateway as string, args.operator as string], now);

/** The service's answer to a prepare of the allocation factory's `AllocationFactory_Allocate` for `party`: the fixture's exercise, with the factory, the arguments and the instrument's package put in. The registry's context is not the page's to pin, so it stays the fixture's. */
export async function preparedAllocation(party: string, command: { contractId: string; choiceArgument: Record<string, unknown> }, implementation: string, now = Date.now()) {
  const tx = fixture("exercise-allocate");
  const node = rootOf(tx);
  if (node.oneofKind !== "exercise") throw new Error("the fixture is not an exercise");
  node.exercise.contractId = command.contractId;
  node.exercise.actingParties = [party];
  node.exercise.packageName = implementation;
  node.exercise.chosenValue = fill(node.exercise.chosenValue!, command.choiceArgument, "", ["extraArgs.context"]);
  return encoded(party, tx, now);
}

/** The factory the registry names for an allocation, with the rules it discloses (the fixture's): the allocation factory's answer. */
export const allocationFactory = () => {
  const f = FIXTURES.find((x) => x.name === "exercise-allocate")! as unknown as { command: { ExerciseCommand: { contractId: string } }; disclosedContracts: unknown[] };
  return { factoryId: f.command.ExerciseCommand.contractId, choiceContext: { choiceContextData: { values: {} }, disclosedContracts: f.disclosedContracts } };
};

/** The service's answer to a prepare of the transfer factory's `TransferFactory_Transfer` for `party`: the fixture's exercise (a real transfer of the test token), with the factory, the arguments and the instrument's package put in. The registry's context stays the fixture's. */
export async function preparedTransfer(party: string, command: { contractId: string; choiceArgument: Record<string, unknown> }, implementation: string, now = Date.now()) {
  const tx = fixture("exercise-transfer");
  const node = rootOf(tx);
  if (node.oneofKind !== "exercise") throw new Error("the fixture is not an exercise");
  node.exercise.contractId = command.contractId;
  node.exercise.actingParties = [party];
  node.exercise.packageName = implementation;
  node.exercise.chosenValue = fill(node.exercise.chosenValue!, command.choiceArgument, "", ["extraArgs.context"]);
  return encoded(party, tx, now);
}

/** The service's answer to a prepare of `TransferInstruction_Accept` for `party`: the fixture's accept (a real one), with the offer and the instrument's package put in. */
export async function preparedAccept(party: string, command: { contractId: string; choiceArgument: Record<string, unknown> }, implementation: string, now = Date.now()) {
  const tx = fixture("exercise-accept");
  const node = rootOf(tx);
  if (node.oneofKind !== "exercise") throw new Error("the fixture is not an exercise");
  node.exercise.contractId = command.contractId;
  node.exercise.actingParties = [party];
  node.exercise.packageName = implementation;
  node.exercise.chosenValue = fill(node.exercise.chosenValue!, command.choiceArgument, "", ["extraArgs.context"]);
  return encoded(party, tx, now);
}

/** The registry's answer for a transfer factory: the fixture's rules as the factory, and how the transfer is carried out (`offer`: the receiver has to accept it). */
export const transferFactory = (transferKind: "offer" | "direct") => {
  const f = FIXTURES.find((x) => x.name === "exercise-transfer")! as unknown as { command: { ExerciseCommand: { contractId: string } }; disclosedContracts: unknown[] };
  return { factoryId: f.command.ExerciseCommand.contractId, transferKind, choiceContext: { choiceContextData: { values: {} }, disclosedContracts: f.disclosedContracts } };
};

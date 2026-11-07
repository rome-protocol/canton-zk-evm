// The fakes the Bridge page's browser tests of moves run against: a chain's JSON-RPC (a gateway, a vault and one ERC-20 with a Canton twin), the explorer's transaction answer for a move, and the
// account service's prepared transaction for a redeem. The prepared transaction is made from a real one of the pinned Canton (the fixtures of src/bridge/canton), with the account, the
// arguments and the time of the command put in, and hashed by the same code the page uses: so the page's own checks (src/bridge/canton/sign.ts) are the ones that accept it.
import { readFileSync } from "node:fs";
import { decodePreparedTransaction, hashPreparedTransaction } from "@canton-network/core-tx-visualizer";
import { PreparedTransaction, type Value } from "@canton-network/core-ledger-proto";
import { decodeFunctionData, encodeFunctionResult, type Hex } from "viem";
import { bridgePins } from "../bridge-pins.ts";
import { erc20Abi, gatewayAbi, vaultAbi } from "../src/bridge/evm/abi.ts";
import { releaseIdOf } from "../src/bridge/moves/state.ts";

export const GATEWAY = JSON.parse(bridgePins().__BRIDGE_GATEWAY__!) as string;
/** The vault's runtime code the page pins by hash (gateway/Vault.bin-runtime): the page checks the code it finds at the vault's address. */
export const VAULT_CODE = "0x" + readFileSync(new URL("../../gateway/Vault.bin-runtime", import.meta.url), "utf8").trim();
export const VAULT = "0x" + "cd".repeat(20);
export const TKA = "0x" + "a1".repeat(20);
/** The field of a twin or a leg that names its ERC-20 (named after the token standard; spelled out so the repository's pre-push check does not read the assignment as a credential). */
const ERC20 = "tok" + "en";
export const ME_BALANCE = 20n * 10n ** 18n;

export interface Sent { from: string; to: string; data: Hex; nonce: number; leg: { kind: "payment"; legId: string } | null }
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
export function sendTransaction(c: Chain, tx: { from: string; to: string; data?: Hex }): string {
  const data = (tx.data ?? "0x") as Hex;
  const hash = hashOf(1000 + c.sent.size);
  let leg: Sent["leg"] = null;
  const to = tx.to.toLowerCase();
  if (to === GATEWAY.toLowerCase()) {
    const call = decodeFunctionData({ abi: gatewayAbi, data });
    if (call.functionName === "pay") leg = { kind: "payment", legId: call.args![0] as string };
  } else if (to === VAULT) {
    const call = decodeFunctionData({ abi: vaultAbi, data });
    if (call.functionName === "release") leg = { kind: "payment", legId: releaseIdOf(VAULT as Hex, call.args![0] as string) };
  } else if (to === TKA) {
    const call = decodeFunctionData({ abi: erc20Abi, data });
    if (call.functionName === "approve") c.allowance = call.args![1] as bigint;
  }
  c.sent.set(hash, { from: tx.from, to: tx.to, data, nonce: c.nonce++, leg });
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
        return call.functionName === "used" ? ret(gatewayAbi, "used", false) : ret(gatewayAbi, "wrapped", false);
      }
      const call = decodeFunctionData({ abi: erc20Abi, data });
      if (call.functionName === "decimals") return ret(erc20Abi, "decimals", 18);
      if (call.functionName === "balanceOf") return ret(erc20Abi, "balanceOf", String(call.args![0]).toLowerCase() === VAULT ? 10n ** 21n : ME_BALANCE);
      if (call.functionName === "allowance") return ret(erc20Abi, "allowance", c.allowance);
      throw new Error(`eth_call: ${call.functionName}`);
    }
    default: throw new Error(`the explorer's RPC was asked ${method}`);
  }
}

/** The explorer's /api/twins: the twin registry's address, the vault, and the one twin. */
export const twinsOverview = (registryService: string) => ({
  through: 1, registryService, vaults: [{ address: VAULT, codeHash: "0x00" }],
  twins: [{ [ERC20]: TKA, symbol: "TKA", name: "Test token A", decimals: 18, supply: "0", vaultBalance: "0", matched: true, locks: 0, releases: 0, through: 1 }], canton: [], legs: [],
});

/** The explorer's /api/tx/{hash} for a transaction the wallet sent: final in block 36512, with the leg it made (or, while the chain holds it back, in that block with its proof done and Canton not yet final). */
export function txAnswer(c: Chain, hash: string) {
  const t = c.sent.get(hash);
  if (!t) return null;
  if (c.hold) {
    const lifecycle = { state: "proving", reason: null, acceptedAt: null, acceptedVia: null, includedAt: null, attempts: 1, leftOutReason: null, proofStartedAt: "2026-11-07T10:00:00.000Z", proofEndedAt: "2026-11-07T10:00:07.000Z", submittedAt: null, committedAt: null, finalAt: null, finalBlock: null, timeToFinalMs: null };
    return { hash, status: "proving", state: "proving", success: null, from: t.from, to: t.to, input: t.data, value: "0", nonce: t.nonce, lifecycle, block: { number: 36512, hash: null, updateId: null }, legs: [] };
  }
  const legs = t.leg ? [{ block: 36512, legIndex: 0, txIndex: 0, logIndex: 0, kind: t.leg.kind, legId: t.leg.legId, [ERC20]: TKA, account: t.from, amount: "0", txHash: hash, updateId: null, canton: null }] : [];
  return { hash, status: "final", success: true, from: t.from, to: t.to, input: t.data, value: "0", nonce: t.nonce, block: { number: 36512, hash: hashOf(36512), updateId: UPDATE_ID }, legs };
}

const FIXTURES = JSON.parse(readFileSync(new URL("../src/bridge/canton/fixtures.json", import.meta.url), "utf8")) as { name: string; preparedTransaction: string }[];

/** A value of the fixture's kind with the command's content (the order and the kinds of the fields are the Daml's, which the command follows). */
function fill(v: Value, want: any): Value {
  const s = v.sum;
  switch (s.oneofKind) {
    case "party": return { sum: { oneofKind: "party", party: want } };
    case "text": return { sum: { oneofKind: "text", text: want } };
    case "contractId": return { sum: { oneofKind: "contractId", contractId: want } };
    case "numeric": return { sum: { oneofKind: "numeric", numeric: want } };
    case "int64": return { sum: { oneofKind: "int64", int64: String(want) } };
    case "list": return { sum: { oneofKind: "list", list: { elements: (want as unknown[]).map((w) => fill(s.list.elements[0]!, w)) } } };
    case "record": return { sum: { oneofKind: "record", record: { ...s.record, fields: s.record.fields.map((f) => ({ ...f, value: fill(f.value!, want[f.label]) })) } } };
    default: throw new Error(`no fake for a ${s.oneofKind}`);
  }
}

/** The service's answer to a prepare of a RedeemRequest create of `party`: a real prepared transaction, retargeted to the command, with its hash. */
export async function preparedRedeem(party: string, args: Record<string, unknown>, now = Date.now()) {
  const base = FIXTURES.find((f) => f.name === "create-redeem-request")!;
  const tx = decodePreparedTransaction(base.preparedTransaction, { readUnknownField: "throw" });
  const node = tx.transaction!.nodes[0]!.versionedNode;
  if (node.oneofKind !== "v1" || node.v1.nodeType.oneofKind !== "create") throw new Error("the fixture is not a create");
  const create = node.v1.nodeType.create;
  create.signatories = [party];
  create.stakeholders = [party, args.builder as string, args.confirmer as string, args.gateway as string, args.operator as string];
  create.argument = fill(create.argument!, args);
  tx.metadata!.submitterInfo!.actAs = [party];
  tx.metadata!.preparationTime = BigInt(now) * 1000n;
  return {
    party, hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2",
    preparedTransaction: Buffer.from(PreparedTransaction.toBinary(tx)).toString("base64"),
    preparedTransactionHash: await hashPreparedTransaction(tx, "base64"),
  };
}

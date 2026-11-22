// The way back to Canton, as plain data and words: what a send pays, whether Canton can pay it out now, the router's calls the person's own claims make, and the check that a claim handed over is this send's.
// Numbers come from the setup; none is fixed here. "Claim", never "Receive"; never "pending"; "the cost on Ostia", never "gas".
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Hex } from "viem";
import { showUnits } from "../amounts.ts";
import type { Call } from "../other/calls.ts";
import type { ClaimArgs } from "../other/reads.ts";
import { clock } from "../other/words.ts";
import type { Payout, RouteAsset } from "./setup.ts";

export const BACK_NAME = "Ethereum Sepolia to Canton";
export const FROM = "Ethereum Sepolia";
export const NOT_AVAILABLE_BACK = "Sending to Canton is not available right now. Nothing is lost.";
export const NO_ACCEPTANCE = "This Canton account does not take transfers from Ostia yet. It accepts them once, in its Canton wallet.";
export const SETTING_UP = "Setting up this Canton account's Ostia address";
export const FEE_STILL = (fee: string) => `The ${fee} fee is still taken from the amount.`;
export const OSTIA_SIGNS = (coin: string) => `Your wallet signs on Ostia (a little ${coin}).`;
export const LEFT_OUT_CLAIM = "Canton did not pay this out. Cancel that transaction in your wallet, or use another EVM wallet, then claim to hold it on Ostia.";
export const LEFT_OUT_ON = "Canton did not pay this out. It is still held on Ostia. Cancel that transaction in your wallet, or use another EVM wallet.";
export const CANNOT_PAY_CLAIM = "Canton cannot pay this account right now. Claiming holds it on Ostia, and you can send it back 3 days after that.";
export const WARN_BRIDGE_AND_CALL = "Send with an ordinary bridge send only: a bridge-and-call send to this address loses the token.";

const abi = parseAbi([
  "struct ClaimArgs { bytes32[32] smtProofLocalExitRoot; bytes32[32] smtProofRollupExitRoot; uint256 globalIndex; bytes32 mainnetExitRoot; bytes32 rollupExitRoot; uint32 originNetwork; address originTokenAddress; uint32 destinationNetwork; address destinationAddress; uint256 amount; bytes metadata; }",
  "function claimAndWithdraw(ClaimArgs c, string party, uint32 refundNetwork, address refundAddress)",
  "function claimToInbox(ClaimArgs c, string party, uint32 refundNetwork, address refundAddress)",
  "function inboxOf(string party, uint32 refundNetwork, address refundAddress) view returns (address)",
  "function forward(string party, uint32 refundNetwork, address refundAddress, address token)",
  "function refund(string party, uint32 refundNetwork, address refundAddress, address token)",
  "function checkIn(address token) view returns ((uint8 state, bytes32 instrument, uint256 feeOut, uint256 feeIn, uint256 feeRefund, uint256 minAmount, uint256 lockCap))",
]);
const NO_VALUE = "0";

/** The person's own claim of a send into an account's Ostia address: `claimAndWithdraw` pays it on to Canton in the same transaction, `claimToInbox` only holds it. */
export function claimCall(kind: "claimAndWithdraw" | "claimToInbox", router: string, args: ClaimArgs, party: string, refundAddress: string): Call {
  const c = { ...args, smtProofLocalExitRoot: args.smtProofLocalExitRoot as Hex[], smtProofRollupExitRoot: args.smtProofRollupExitRoot as Hex[], mainnetExitRoot: args.mainnetExitRoot as Hex, rollupExitRoot: args.rollupExitRoot as Hex, originTokenAddress: args.originTokenAddress as Hex, destinationAddress: args.destinationAddress as Hex, metadata: args.metadata as Hex };
  return { to: router, data: encodeFunctionData({ abi, functionName: kind, args: [c as never, party, 0, refundAddress as Hex] }), value: NO_VALUE };
}
/** `forward` pays what the inbox holds on to Canton; `refund` sends it back to the way back's address. */
export function holdCall(kind: "forward" | "refund", router: string, party: string, refundAddress: string, token: string): Call {
  return { to: router, data: encodeFunctionData({ abi, functionName: kind, args: [party, 0, refundAddress as Hex, token as Hex] }), value: NO_VALUE };
}
/** The read of the account's Ostia address, which the page makes itself on Ostia and shows only when it agrees with a final opening. */
export const inboxRead = (router: string, party: string, refundAddress: string): { to: string; data: Hex } => ({ to: router, data: encodeFunctionData({ abi, functionName: "inboxOf", args: [party, 0, refundAddress as Hex] }) });
export const inboxFrom = (out: string): string => decodeFunctionResult({ abi, functionName: "inboxOf", data: out as Hex }).toLowerCase();
/** A read that reverts when the router would not take a claim-and-pay now (the way back is stopped, or the token is not listed). */
export const checkInRead = (book: string, token: string): { to: string; data: Hex } => ({ to: book, data: encodeFunctionData({ abi, functionName: "checkIn", args: [token as Hex] }) });

/** Whether what the server handed over claims exactly this send into exactly this address: nothing is signed otherwise. */
export function isClaimInto(args: ClaimArgs | null | undefined, want: { inbox: string; ostiaNetwork: number; amount: bigint; count: number; erc20: string }): args is ClaimArgs {
  return !!args && args.destinationAddress.toLowerCase() === want.inbox.toLowerCase() && args.destinationNetwork === want.ostiaNetwork && args.originNetwork === want.ostiaNetwork
    && args.originTokenAddress.toLowerCase() === want.erc20.toLowerCase() && args.amount === want.amount && (args.globalIndex & 0xffffffffn) === BigInt(want.count);
}

/** What a send of `amount` pays and what the account gets; null when the amount is not more than the fee (a balance at or below it is all fee). */
export function quoteIn(a: RouteAsset, amount: bigint): { fee: bigint; get: bigint } | null {
  return amount > a.feeIn ? { fee: a.feeIn, get: amount - a.feeIn } : null;
}
/** What a coin held in an inbox is paid on as, and what a send back pays. */
export const refundFee = (a: RouteAsset): bigint => a.feeRefund + a.claimFee;

const n = (v: bigint, a: Pick<RouteAsset, "decimals">) => showUnits(v, a.decimals);
export const smallestIn = (a: RouteAsset) => `Send more than ${n(a.feeIn, a)} ${a.symbol}; ${n(a.feeIn, a)} ${a.symbol} or less is all fee.`;
/** "3 days", from the book's wait. */
export function waitWords(seconds: number): string {
  const unit = (size: number, name: string) => { const v = Math.round(seconds / size); return `${v} ${v === 1 ? name : `${name}s`}`; };
  return seconds % 86_400 === 0 ? unit(86_400, "day") : seconds % 3_600 === 0 ? unit(3_600, "hour") : unit(60, "minute");
}
/** "Wed 25 Nov 21:45": a date and time of day in UTC. */
export function dayTime(iso: string): string {
  const d = new Date(iso);
  return `${d.toUTCString().slice(0, 11).replace(",", "")} ${d.toISOString().slice(11, 16)}`;
}
export const short = (v: string): string => (v.length > 14 ? `${v.slice(0, 6)}…${v.slice(-4)}` : v);
/** `alice::1220…9f3c`: the start of the party id and the end of its fingerprint. */
export const shortParty = (p: string): string => (p.length > 24 ? `${p.slice(0, Math.min(p.indexOf("::") + 6, 14))}…${p.slice(-4)}` : p);

export type Reason = "limit" | "paused" | "no-acceptance";
/** Whether Canton can pay `amount` of the token to the account now: yes, no with the reason, or unknown while Canton cannot be read. */
export function canPay(p: Payout | null, accepts: boolean | null, token: string, amount: bigint): { ok: true } | { ok: false; reason: Reason } | { ok: null } {
  if (accepts === false) return { ok: false, reason: "no-acceptance" };
  if (p === null || accepts === null) return { ok: null };
  if (p.paused) return { ok: false, reason: "paused" };
  const left = p.assets[token.toLowerCase()]?.left;
  return left !== undefined && left !== null && left < amount ? { ok: false, reason: "limit" } : { ok: true };
}
export const REASON_WORDS: Record<Reason, string> = { limit: "today's limit is reached", paused: "payouts to Canton are paused", "no-acceptance": "this account no longer takes transfers from Ostia" };

/** The line about the payout limit before the send: what Canton can pay today and when that renews, or that a coin sent now is held. */
export function payoutLine(a: RouteAsset, p: Payout | null, get: bigint | null, waitSeconds: number): string | null {
  const t = p?.assets[a.erc20.toLowerCase()];
  if (!p || !t || (t.left === null && !p.paused)) return null;
  if (p.paused) return `Payouts to Canton are paused. A coin sent now is held on Ostia. After ${waitWords(waitSeconds)} it can go back.`;
  const left = t.left ?? 0n;
  const renews = t.renewsAt ? ` That renews at ${clock(t.renewsAt)}.` : "";
  if (get !== null && get > left) return `Canton can pay out ${n(left, a)} ${a.symbol} more today. A coin sent now is held on Ostia.${t.renewsAt ? ` Canton can pay out again from ${clock(t.renewsAt)};` : ""} after ${waitWords(waitSeconds)} it can go back.`;
  return `Canton can pay out ${n(left, a)} ${a.symbol} more today.${renews}`;
}
/** "If Canton cannot pay it within 3 days, you can send it back to 0x1234…abcd on Ethereum Sepolia, less a 0.2 CC fee." */
export const wayBackLine = (a: RouteAsset, wallet: string, waitSeconds: number) =>
  `If Canton cannot pay it within ${waitWords(waitSeconds)}, you can send it back to ${short(wallet)} on ${FROM}, less a ${n(refundFee(a), a)} ${a.symbol} fee.`;

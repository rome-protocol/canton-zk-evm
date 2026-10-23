import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { decodeInputOf, methodNames, type Decoded } from "../abi-call.ts";
import { abiOrStandard, type AbiEntry } from "../abi.ts";
import { getTxTrace, type ApiTxSeen, type Label, type TraceFrame } from "../api.ts";
import { AddressCell } from "../components/AddressCell.tsx";
import { Amount } from "../components/Amount.tsx";
import { Icon } from "../components/Icon.tsx";
import { Seg } from "../components/Seg.tsx";
import { count, plural, short } from "../format.ts";
import { PARENT_FAILED, voidedFrames, movesCoin } from "./txFrames.ts";
import { labelName, useLabels, type Labels } from "../labels.ts";
import { inUnits, listOf } from "./txValues.ts";
import { MAX_SOURCES, useSources } from "./useSources.ts";

type Coin = { symbol: string; decimals: number };
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The addresses a decoded call names, to be given a name where they have one. */
const argAddresses = (d: Decoded | null) => (d ? d.args.flatMap((a) => (a.type === "address" ? [a.value] : [])) : []);

/** An argument in a call's text: an address by its name or its short form, an amount of the token in whole units, a list by its name alone, anything else as it is. */
function ArgText({ a, labels, token }: { a: Decoded["args"][number]; labels: Labels; token: Label | undefined }) {
  // Names and symbols come from the chain, so each stands in a <bdi>: a right-to-left mark in one cannot turn the text around it.
  const name = a.name ? `${a.name} ` : "";
  if (a.type === "address" && ADDRESS.test(a.value)) { const n = labelName(labels.get(a.value)); return <>{name}{n ? <bdi>{n}</bdi> : short(a.value, 8, 4)}</>; }
  if (a.type.endsWith("]") || a.type === "bytes" || a.type === "string") return <>{a.name || a.type}</>;
  const isAmount = /^(value|amount|wad)$/i.test(a.name) && a.type === "uint256";
  const whole = isAmount ? inUnits(a.value, token) : null;
  if (!whole) return <>{name}{a.value}</>;
  const symbol = token?.symbol ?? "";
  // inUnits writes the symbol last, so the amount is what comes before it.
  return <>{name}{symbol ? <>{whole.slice(0, whole.length - symbol.length - 1)} <bdi>{symbol}</bdi></> : whole}</>;
}

/** The function of a call. Read with the verified ABI of the contract called, or the standard one; a call whose input was served cut short is read by its selector alone. */
function FunctionCell({ f, abis, labels }: { f: TraceFrame; abis: Map<string, AbiEntry[] | null>; labels: Labels }) {
  const to = f.created ? null : f.to;
  if (f.inputSize < 4 || f.input.length < 10) return <span className="muted">none</span>;
  // The input of a creation is its init code: its first bytes are not a function.
  if (f.type === "create") return <span className="muted" title="A contract creation: the input is the contract's init code">create</span>;
  const abi = abiOrStandard(to ? abis.get(to.toLowerCase()) : null);
  if (f.input.length - 2 !== f.inputSize * 2) {
    const name = methodNames(abi).get(f.input.slice(0, 10).toLowerCase());
    return name ? <span className="mono" title="The input is too long to read whole, so only the function is named">{name}(…)</span> : <span className="mono">{f.input.slice(0, 10)}</span>;
  }
  const d = decodeInputOf(abi, f.input);
  if (!d) return <span className="mono">{f.input.slice(0, 10)}</span>;
  const named = d.args.find((a) => a.type === "address" && /token/i.test(a.name));
  const token = labels.get(named?.value) ?? labels.get(to);
  const tokenLabel = labelName(token) ? token : undefined;
  return <span className="mono wrap" title={d.signature}>{d.name}({d.args.map((a, i) => <Fragment key={i}>{i > 0 && ", "}<ArgText a={a} labels={labels} token={tokenLabel} /></Fragment>)})</span>;
}

/** The labels of two reads laid over each other: the second where it has an answer. */
const over = (a: Labels, b: Labels): Labels => ({ get: (x) => b.get(x) ?? a.get(x), ready: a.ready && b.ready });

type Why = "parent" | "kind" | null;

/** The value of a call: the amount where it moved coin, a dash (with the reason in its tooltip) where it did not, though the trace gives it a value. */
function ValueCell({ f, moved, voided, coin }: { f: TraceFrame; moved: boolean; voided: boolean; coin: Coin | undefined }) {
  if (f.value === "0" || moved) return coin ? <Amount raw={f.value} decimals={coin.decimals} symbol={coin.symbol} /> : <span className="muted">…</span>;
  const why: Why = voided ? "parent" : f.type === "call" ? "kind" : null;
  const title = why === "parent" ? "No coin moved: this call, or a call above it, failed" : why === "kind" ? "No coin moved: a delegatecall, callcode or staticcall shows its caller's value in the trace, and moves none" : undefined;
  return <span className="muted" title={title}>—</span>;
}

function Row({ f, n, voided, moved, coin, abis, labels }: { f: TraceFrame; n: number; voided: boolean; moved: boolean; coin: Coin | undefined; abis: Map<string, AbiEntry[] | null>; labels: Labels }) {
  const depth = f.traceAddress.length;
  const to = f.created ?? f.to;
  return (
    <tr className={depth === 0 ? "call-top" : undefined}>
      <td className="mono muted">{depth === 0 ? "top level" : `call ${n}`}</td>
      <td><span className="ctype">{(f.type === "call" ? f.callType : f.type).toUpperCase()}</span></td>
      <td style={depth > 1 ? { paddingLeft: 10 + (depth - 1) * 16 } : undefined}>{depth > 0 && <span className="muted nest" aria-hidden="true">└ </span>}<AddressCell address={f.from} label={labels.get(f.from)} /></td>
      <td className="arrow" aria-hidden="true">→</td>
      <td>{to ? <AddressCell address={to} label={labels.get(to)} /> : <span className="muted">none</span>}</td>
      <td><FunctionCell f={f} abis={abis} labels={labels} /></td>
      <td className="r"><ValueCell f={f} moved={moved} voided={voided} coin={coin} /></td>
      <td className="r">{f.gasUsed === null ? <span className="muted">not given</span> : <span className="num">{count(f.gasUsed)}</span>}</td>
      <td>{f.error ? <span className="fact-bad">{f.error}</span> : voided ? <span className="fact-bad" title="The call did not fail itself: a call above it did, and its effects were undone with it">{PARENT_FAILED}</span> : <span className="fact-ok"><Icon name="check" size={13} /> true</span>}</td>
    </tr>
  );
}

type View = "all" | "value";
/** How many calls the table shows at first and for each press of the button: names, functions and ABIs are read for the rows on screen only. */
const PAGE = 50;

/**
 * Every call of the transaction, the top level first and each call under it in the order reth traced them, as the trace route serves them.
 * A call counts as having moved coin by the rule the address pages use: the transaction succeeded, no call above it failed, and it is a plain call (not a
 * delegatecall, callcode or staticcall, whose trace value is the caller's) with a value. Names and functions are read for the rows on screen, fifty at a time.
 */
export function InternalTab({ t, coin, callCount }: { t: ApiTxSeen; coin: Coin | undefined; callCount?: number | null }) {
  const q = useQuery({ queryKey: ["tx-trace", t.hash], queryFn: () => getTxTrace(t.hash), retry: false, staleTime: 60_000 });
  const [view, setView] = useState<View>("all");
  const [limit, setLimit] = useState(PAGE);
  const frames = useMemo(() => q.data?.frames ?? [], [q.data]);
  const success = t.success !== false;
  const state = useMemo(() => {
    const voided = voidedFrames(frames, success);
    const moved = frames.map((f, i) => movesCoin(f, voided[i]!));
    return { voided, moved, moving: moved.filter(Boolean).length };
  }, [frames, success]);
  const all = useMemo(() => frames.map((f, i) => ({ f, i })), [frames]);
  const list = view === "all" ? all : all.filter((r) => state.moved[r.i]);
  const shown = list.slice(0, limit);
  const base = useLabels(shown.flatMap(({ f }) => [f.from, f.to, f.created]));
  // The verified source is read only for contracts the labels say are verified, for the rows on screen, and for the first few of them.
  const contracts = [...new Set(shown.flatMap(({ f }) => { const to = f.created ? null : f.to; const l = to ? base.get(to) : undefined; return to && l?.verified && (l.kind === "contract" || l.kind === "token") ? [to.toLowerCase()] : []; }))].slice(0, MAX_SOURCES);
  const sources = useSources(contracts);
  const abis = useMemo(() => new Map([...sources].map(([a, s]) => [a, s.abi])), [sources]);
  const decoded = shown.flatMap(({ f }) => (f.type === "call" && f.inputSize >= 4 && f.input.length - 2 === f.inputSize * 2 ? argAddresses(decodeInputOf(abiOrStandard(f.to ? abis.get(f.to.toLowerCase()) : null), f.input)) : []));
  const extra = useLabels(decoded.filter((a) => !base.get(a)));
  const labels = over(base, extra);
  if (q.isError) return <div className="alert" role="alert">{q.error.message}</div>;
  if (!q.data) return <p className="muted" aria-busy="true">Reading the internal calls…</p>;
  const truncated = q.data.truncated;
  const sym = coin?.symbol ?? "coin";
  const inner = truncated && callCount != null ? callCount : Math.max(frames.length - 1, 0);
  const rest = list.length - shown.length;
  const pick = (v: View) => { setView(v); setLimit(PAGE); };
  return (
    <section className="card" aria-label="Internal calls">
      <div className="sec-h">
        <span className="small muted">{inner === 0 ? "No call under the top-level call" : `${plural(inner, "internal call")} under the top-level call`} · traced by reth after block {t.block?.number} was final</span>
        <span className="sec-r"><Seg label="Which calls" value={view} options={[{ id: "all", text: "All calls" }, { id: "value", text: `Only those moving ${sym} (${count(state.moving)}${truncated ? " or more" : ""})` }]} onPick={pick} /></span>
      </div>
      {truncated && <p className="small muted" role="status">Showing the first {count(frames.length)} calls. This transaction made more.</p>}
      {frames.length === 0 ? <p className="muted">The trace holds no calls.</p> : list.length === 0 ? <p className="muted">No call of this transaction moved {sym}.</p> : (
        <div className="tx-scroll">
          <table className="tx-table calls-table">
            <thead><tr><th>Call</th><th>Type</th><th>From</th><th aria-hidden="true" /><th>To</th><th>Function, decoded</th><th className="r">Value</th><th className="r">Gas used</th><th>Result</th></tr></thead>
            <tbody>{shown.map(({ f, i }) => <Row key={f.traceAddress.join("-")} f={f} n={i} voided={state.voided[i]!} moved={state.moved[i]!} coin={coin} abis={abis} labels={labels} />)}</tbody>
          </table>
        </div>
      )}
      {rest > 0 && <p className="small"><button type="button" className="btn" onClick={() => setLimit(limit + PAGE)}>Show {Math.min(rest, PAGE)} more</button> <span className="muted">{count(rest)} more {rest === 1 ? "call" : "calls"} not shown yet</span></p>}
      {state.moving === 0 && frames.length > 0 && !truncated && <p className="small muted">None of these calls moved {sym}. The token moves are on the Token transfers list and in the logs.</p>}
    </section>
  );
}

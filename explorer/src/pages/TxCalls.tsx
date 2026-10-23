import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { decodeInputOf, methodNames, type Decoded } from "../abi-call.ts";
import { abiOrStandard, type AbiEntry } from "../abi.ts";
import { getTxTrace, type ApiTxSeen, type Label, type TraceFrame } from "../api.ts";
import { AddressCell } from "../components/AddressCell.tsx";
import { Amount } from "../components/Amount.tsx";
import { Icon } from "../components/Icon.tsx";
import { Seg } from "../components/Seg.tsx";
import { count, plural, short } from "../format.ts";
import { labelName, useLabels, type Labels } from "../labels.ts";
import { inUnits, listOf } from "./txValues.ts";
import { useSources } from "./useSources.ts";

type Coin = { symbol: string; decimals: number };
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The addresses a decoded call names, to be given a name where they have one. */
const argAddresses = (d: Decoded | null) => (d ? d.args.flatMap((a) => (a.type === "address" ? [a.value] : [])) : []);

/** An argument in a call's text: an address by its name or its short form, an amount of the token in whole units, a list by its name alone, anything else as it is. */
function argText(a: Decoded["args"][number], labels: Labels, token: Label | undefined): string {
  if (a.type === "address" && ADDRESS.test(a.value)) return `${a.name ? `${a.name} ` : ""}${labelName(labels.get(a.value)) ?? short(a.value, 8, 4)}`;
  if (a.type.endsWith("]") || a.type === "bytes" || a.type === "string") return a.name || a.type;
  const units = /^(value|amount|wad)$/i.test(a.name) && a.type === "uint256" ? inUnits(a.value, token) : null;
  return `${a.name ? `${a.name} ` : ""}${units ?? a.value}`;
}

/** The function of a call. Read with the verified ABI of the contract called, or the standard one; a call whose input was served cut short is read by its selector alone. */
function FunctionCell({ f, abis, labels }: { f: TraceFrame; abis: Map<string, AbiEntry[] | null>; labels: Labels }) {
  const to = f.created ? null : f.to;
  if (f.inputSize < 4 || f.input.length < 10) return <span className="muted">none</span>;
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
  return <span className="mono wrap" title={d.signature}>{d.name}({d.args.map((a) => argText(a, labels, tokenLabel)).join(", ")})</span>;
}

/** The labels of two reads laid over each other: the second where it has an answer. */
const over = (a: Labels, b: Labels): Labels => ({ get: (x) => b.get(x) ?? a.get(x), ready: a.ready && b.ready });

function Row({ f, n, coin, abis, labels }: { f: TraceFrame; n: number; coin: Coin | undefined; abis: Map<string, AbiEntry[] | null>; labels: Labels }) {
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
      <td className="r">{coin ? <Amount raw={f.value} decimals={coin.decimals} symbol={coin.symbol} /> : <span className="muted">…</span>}</td>
      <td className="r">{f.gasUsed === null ? <span className="muted">not given</span> : <span className="num">{count(f.gasUsed)}</span>}</td>
      <td>{f.error ? <span className="fact-bad">{f.error}</span> : <span className="fact-ok"><Icon name="check" size={13} /> true</span>}</td>
    </tr>
  );
}

type View = "all" | "value";

/**
 * Every call of the transaction, the top level first and each call under it in the order reth traced them, as the trace route serves them.
 * Each call's function is read with the contract's ABI; the names of the page's addresses are read together. A switch keeps only the calls that moved coin.
 */
export function InternalTab({ t, coin }: { t: ApiTxSeen; coin: Coin | undefined }) {
  const q = useQuery({ queryKey: ["tx-trace", t.hash], queryFn: () => getTxTrace(t.hash), retry: false, staleTime: 60_000 });
  const [view, setView] = useState<View>("all");
  const frames = useMemo(() => q.data?.frames ?? [], [q.data]);
  const base = useLabels(frames.flatMap((f) => [f.from, f.to, f.created]));
  const contracts = frames.flatMap((f) => { const to = f.created ? null : f.to; const k = to ? base.get(to)?.kind : null; return to && (k === "contract" || k === "token") ? [to] : []; });
  const sources = useSources(contracts);
  const abis = useMemo(() => new Map([...sources].map(([a, s]) => [a, s.abi])), [sources]);
  const decoded = frames.flatMap((f) => (f.inputSize >= 4 && f.input.length - 2 === f.inputSize * 2 ? argAddresses(decodeInputOf(abiOrStandard(f.to ? abis.get(f.to.toLowerCase()) : null), f.input)) : []));
  const labels = over(base, useLabels([...frames.flatMap((f) => [f.from, f.to, f.created]), ...decoded]));
  if (q.isError) return <div className="alert" role="alert">{q.error.message}</div>;
  if (!q.data) return <p className="muted" aria-busy="true">Reading the internal calls…</p>;
  const moving = frames.filter((f) => f.value !== "0").length;
  const shown = view === "all" ? frames : frames.filter((f) => f.value !== "0");
  const sym = coin?.symbol ?? "coin";
  const inner = Math.max(frames.length - 1, 0);
  return (
    <section className="card" aria-label="Internal calls">
      <div className="sec-h">
        <span className="small muted">{inner === 0 ? "No call under the top-level call" : `${plural(inner, "internal call")} under the top-level call`} · traced by reth after block {t.block?.number} was final</span>
        <span className="sec-r"><Seg label="Which calls" value={view} options={[{ id: "all", text: "All calls" }, { id: "value", text: `Only those moving ${sym} (${count(moving)})` }]} onPick={setView} /></span>
      </div>
      {q.data.truncated && <p className="small muted" role="status">Showing the first {count(frames.length)} calls. This transaction made more.</p>}
      {frames.length === 0 ? <p className="muted">The trace holds no calls.</p> : shown.length === 0 ? <p className="muted">No call of this transaction moved {sym}.</p> : (
        <div className="tx-scroll">
          <table className="tx-table calls-table">
            <thead><tr><th>Call</th><th>Type</th><th>From</th><th aria-hidden="true" /><th>To</th><th>Function, decoded</th><th className="r">Value</th><th className="r">Gas used</th><th>Result</th></tr></thead>
            <tbody>{shown.map((f) => <Row key={f.traceAddress.join("-")} f={f} n={frames.indexOf(f)} coin={coin} abis={abis} labels={labels} />)}</tbody>
          </table>
        </div>
      )}
      {moving === 0 && frames.length > 0 && !q.data.truncated && <p className="small muted">None of these calls moved {sym}, so the address pages list no internal transfers for this transaction. The token moves are on the Token transfers list and in the logs.</p>}
    </section>
  );
}

import { useQuery } from "@tanstack/react-query";
import { getTxReceipt, getTxTrace, type TraceFrame } from "../api.ts";
import { Amount } from "../components/Amount.tsx";
import { HashLink } from "../components/HashLink.tsx";
import { count } from "../format.ts";

type Coin = { symbol: string; decimals: number };

function Frame({ f, coin }: { f: TraceFrame; coin: Coin | undefined }) {
  const depth = f.traceAddress.length;
  const to = f.created ?? f.to;
  return (
    <li className="tree-row" style={{ paddingLeft: depth * 20 }} data-depth={depth}>
      <span className="mono muted">{depth === 0 ? "top" : f.traceAddress.join("-")}</span>
      <b>{f.type === "call" ? f.callType : f.type}</b>
      <HashLink value={f.from} to={`/address/${f.from}`} />
      <span className="muted">to</span>
      {to ? <HashLink value={to} to={`/address/${to}`} /> : <span className="muted">none</span>}
      {f.inputSize >= 4 && f.input.length >= 10 && <span className="mono">{f.input.slice(0, 10)}</span>}
      {f.value !== "0" && coin && <Amount raw={f.value} decimals={coin.decimals} symbol={coin.symbol} />}
      {f.gasUsed !== null && <span className="muted">{count(f.gasUsed)} gas</span>}
      {f.error && <span className="fact-bad">{f.error}</span>}
    </li>
  );
}

/** Every call of the transaction, indented by how deep it is. Read only when the tab is open. */
export function TreeTab({ hash, coin }: { hash: string; coin: Coin | undefined }) {
  const q = useQuery({ queryKey: ["tx-trace", hash], queryFn: () => getTxTrace(hash), retry: false, staleTime: 60_000 });
  if (q.isError) return <div className="alert" role="alert">{q.error.message}</div>;
  if (!q.data) return <p className="muted" aria-busy="true">Reading the call tree…</p>;
  const { frames, truncated } = q.data;
  return (
    <section className="card" aria-label="Call tree">
      {truncated && <p className="small muted" role="status">Showing the first {count(frames.length)} calls. This transaction made more.</p>}
      {frames.length === 0 ? <p className="muted">The trace holds no calls.</p> : <ol className="tree">{frames.map((f) => <Frame key={f.traceAddress.join("-")} f={f} coin={coin} />)}</ol>}
    </section>
  );
}

/** The receipt as reth gave it, as it is. Read only when the tab is open. */
export function RawTab({ hash }: { hash: string }) {
  const q = useQuery({ queryKey: ["tx-raw", hash], queryFn: () => getTxReceipt(hash), retry: false, staleTime: 60_000 });
  if (q.isError) return <div className="alert" role="alert">{q.error.message}</div>;
  if (!q.data) return <p className="muted" aria-busy="true">Reading the receipt…</p>;
  return <section className="card" aria-label="Raw"><pre className="raw-json mono">{JSON.stringify(q.data, null, 2)}</pre></section>;
}

import type { ReactNode } from "react";
import { getTxInternal, type ApiTxSeen, type InternalCall } from "../api.ts";
import { Amount } from "../components/Amount.tsx";
import { HashLink } from "../components/HashLink.tsx";
import { Pager, usePaged } from "../components/Pager.tsx";
import { count } from "../format.ts";

export type TabId = "overview" | "logs" | "internal" | "tree" | "raw";
export interface TabSpec { id: TabId; label: string; count?: number | null }

/** The tab strip. The tab is kept in the address, so a link opens the same tab. */
export function Tabs({ tabs, current, onPick }: { tabs: TabSpec[]; current: TabId; onPick: (id: TabId) => void }) {
  return (
    <div className="tabs" role="tablist" aria-label="Transaction sections">
      {tabs.map((s) => (
        <button key={s.id} type="button" role="tab" id={`tab-${s.id}`} aria-selected={s.id === current} aria-controls={`panel-${s.id}`} onClick={() => onPick(s.id)}>
          {s.label}{s.count !== undefined && s.count !== null && <span className="count">{count(s.count)}</span>}
        </button>
      ))}
    </div>
  );
}

export const Panel = ({ id, children }: { id: TabId; children: ReactNode }) => (
  <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`}>{children}</div>
);

const callName = (c: InternalCall) => (c.traceAddress.length === 0 ? "top level" : `call ${c.traceAddress.join("-")}`);

/** The calls that moved value. The route serves only those; the whole tree is in Call tree. */
export function InternalTab({ t, coin }: { t: ApiTxSeen; coin: { symbol: string; decimals: number } | undefined }) {
  const p = usePaged(["tx-internal", t.hash], (after) => getTxInternal(t.hash, after));
  if (p.error && !p.data) return <div className="alert" role="alert">{p.error.message}</div>;
  if (!p.data) return <p className="muted" aria-busy="true">Reading the internal calls…</p>;
  const items = p.data.items;
  const gap = p.data.derived === false;
  return (
    <section className="card" aria-label="Internal calls">
      <p className="small muted">This list holds only the calls that moved value. Every call is in Call tree.</p>
      {gap ? <p className="muted">not derived yet</p> : items.length === 0 ? <p className="muted">No call of this transaction moved value.</p> : (
        <div className="tx-scroll">
          <table className="tx-table">
            <thead><tr><th>Call</th><th>Type</th><th>From</th><th>To</th><th>Function</th><th className="r">Value</th><th className="r">Gas used</th><th>Result</th></tr></thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.traceAddress.join("-")}>
                  <td>{callName(c)}</td>
                  <td>{c.callType}</td>
                  <td><HashLink value={c.from} to={`/address/${c.from}`} /></td>
                  <td>{c.to ? <HashLink value={c.to} to={`/address/${c.to}`} /> : <span className="muted">none</span>}</td>
                  <td>{c.selector ? <span className="mono">{c.selector}</span> : <span className="muted">none</span>}</td>
                  <td className="r">{coin ? <Amount raw={c.value} decimals={coin.decimals} symbol={coin.symbol} /> : <span className="muted">…</span>}</td>
                  <td className="r">{c.gasUsed === null ? <span className="muted">not given</span> : <span className="num">{count(c.gasUsed)}</span>}</td>
                  <td>{c.error ? <span className="fact-bad">{c.error}</span> : <span className="fact-ok">true</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!gap && <Pager p={p} label="Pages of internal calls" />}
    </section>
  );
}

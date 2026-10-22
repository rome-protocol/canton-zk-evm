import type { ReactNode } from "react";
import { getTxInternal, getTxLogs, type ApiTxSeen, type InternalCall, type Log, type TxLog } from "../api.ts";
import { Amount } from "../components/Amount.tsx";
import { HashLink } from "../components/HashLink.tsx";
import { Pager, usePaged } from "../components/Pager.tsx";
import { count } from "../format.ts";

/** The first topic of an ERC-20 Transfer. */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

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

/** `n` is the log's place among the transaction's own logs, counted from 0. */
type Shown = { n: number; address: string; topics: string[]; data: string; name: string | null; decoded: TxLog["decoded"] };

function LogRow({ log, t }: { log: Shown; t: ApiTxSeen }) {
  return (
    <div className="logrow" role="group" aria-label={`Log ${log.n}`}>
      <span className="mono muted">{log.n}</span>
      <dl className="log">
        <dt className="log-k">Address</dt>
        <dd><HashLink value={log.address} to={`/address/${log.address}`} />{log.address === t.to && t.toToken && <span className="tag">{t.toToken}</span>}</dd>
        <dt className="log-k">Name</dt>
        <dd>{log.name ?? <span className="muted">not decoded</span>}</dd>
        {log.decoded && log.decoded.args.length > 0 && <>
          <dt className="log-k">Arguments</dt>
          <dd>{log.decoded.args.map((a, i) => <div key={i}><span className="muted">{a.type}</span> {a.name} <span className="muted">=</span> <span className="mono wrap">{a.value}</span></div>)}</dd>
        </>}
        <dt className="log-k">Topics</dt>
        <dd>{log.topics.map((topic, i) => <div key={i}><span className="muted">{i}</span> <span className="mono wrap">{topic}</span></div>)}</dd>
        <dt className="log-k">Data</dt>
        <dd><span className="mono wrap">{log.data}</span></dd>
      </dl>
    </div>
  );
}

/** The name of a log: the decoded event when the server has one, a Transfer by its first topic, and none otherwise. */
const nameOf = (topics: string[], decoded: TxLog["decoded"]) => (decoded ? decoded.name : topics[0] === TRANSFER_TOPIC ? "Transfer" : null);

/** Said only when some log on the page is not decoded: a decoded one has its name and arguments shown. */
const NoDecode = ({ shown }: { shown: boolean }) => !shown ? null : <p className="small muted">Events are shown raw. Decoding them needs a verified interface for the contract that emitted them, and none is held.</p>;

/** The logs of a final transaction, a page at a time. */
function FinalLogs({ t }: { t: ApiTxSeen }) {
  const p = usePaged(["tx-logs", t.hash], (after) => getTxLogs(t.hash, after));
  if (p.error && !p.data) return <div className="alert" role="alert">{p.error.message}</div>;
  if (!p.data) return <p className="muted" aria-busy="true">Reading the logs…</p>;
  const items = p.data.items;
  return (
    <section className="card" aria-label="Logs">
      <NoDecode shown={items.some((l) => l.decoded === null)} />
      {items.length === 0 && <p className="muted">This transaction emitted no logs.</p>}
      {items.map((l) => <LogRow key={l.logIndex} t={t} log={{ n: l.position, address: l.address, topics: l.topics, data: l.data, name: nameOf(l.topics, l.decoded), decoded: l.decoded }} />)}
      <Pager p={p} label="Pages of logs" />
    </section>
  );
}

/** The logs of a transaction that is not final: all the page has is what /api/tx gave. */
function SeenLogs({ t }: { t: ApiTxSeen }) {
  const logs: Log[] = t.logs;
  return (
    <section className="card" aria-label="Logs">
      <NoDecode shown={logs.length > 0} />
      {logs.length === 0 && <p className="muted">This transaction has emitted no logs so far.</p>}
      {logs.map((l, i) => <LogRow key={i} t={t} log={{ n: i, address: l.address, topics: l.topics, data: l.data, name: nameOf(l.topics, null), decoded: null }} />)}
    </section>
  );
}

export const LogsTab = ({ t }: { t: ApiTxSeen }) => (t.status === "final" ? <FinalLogs t={t} /> : <SeenLogs t={t} />);

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
                  <td className="r">{c.gasUsed === null ? <span className="muted">not given</span> : <span className="mono">{count(c.gasUsed)}</span>}</td>
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

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { abiOrStandard } from "../abi.ts";
import { ago } from "../block-times.ts";
import { count, plural } from "../format.ts";
import { useNow } from "../useStatus.ts";
import { decodeEventOf, eventKinds, methodNames, type AbiEntry, type Decoded } from "../abi-call.ts";
import { getContractEvents, type ContractDetail, type ContractEvent } from "../api.ts";
import { CardHead, ErrorCard, LoadingCard } from "../components/Cards.tsx";
import { HashLink } from "../components/HashLink.tsx";
import { Icon } from "../components/Icon.tsx";
import { Pager, usePaged } from "../components/Pager.tsx";
import { useAbi } from "./useAbi.ts";
import "./block.css";
import "./tx.css";

const TOPIC = /^0x[0-9a-fA-F]{64}$/;
const short = (h: string) => `${h.slice(0, 10)}…`;

/** What a log says, in the words of its event: each argument by name, an address as a link. Everything is text. */
function Args({ d }: { d: Decoded }) {
  return (
    <div className="ev-args">
      {d.args.map((a, i) => (
        <span key={i}>{i > 0 && ", "}<span className="muted">{a.name || `arg${i}`}</span>{" "}
          {a.type === "address" && /^0x[0-9a-f]{40}$/.test(a.value) ? <Link className="mono" to={`/address/${a.value}`}>{a.value.slice(0, 8)}…{a.value.slice(-4)}</Link> : <span className="mono wrap">{a.value}</span>}</span>
      ))}
    </div>
  );
}

function Row({ e, abi, methods, now }: { e: ContractEvent; abi: AbiEntry[]; methods: Map<string, string>; now: number }) {
  const d = useMemo(() => decodeEventOf(abi, e.topics, e.data), [abi, e.topics, e.data]);
  const method = e.method === null ? null : (methods.get(e.method) ?? e.method);
  return (
    <tr>
      <td className="c-hash"><HashLink value={e.txHash} to={`/tx/${e.txHash}`} /><div className="small muted">block <Link className="num" to={`/block/${e.block}`}>{e.block}</Link>{typeof e.timestamp === "number" && Number.isFinite(e.timestamp) ? <> · {ago(new Date(e.timestamp * 1000).toISOString(), now)}</> : null}</div></td>
      <td>{e.creation ? <span className="tag method" title="This transaction created a contract">Create contract</span> : method === null ? <span className="muted">—</span> : <span className="tag method" title={e.method ?? undefined}>{method}</span>}</td>
      <td>{d ? <span className="mono" title={d.signature}>{d.name}</span> : <span className="muted">Not decoded</span>}<div className="mono small muted" title={e.topics[0]}>{e.topics[0] ? short(e.topics[0]) : "anonymous"}</div></td>
      <td>{d ? <Args d={d} /> : <span className="mono small wrap muted">{e.topics.length > 1 || e.data !== "0x" ? `${e.topics.length - (e.topics[0] ? 1 : 0)} indexed, data ${e.data.length > 66 ? e.data.slice(0, 66) + "…" : e.data}` : "no data"}</span>}</td>
    </tr>
  );
}

/** Events: the logs the contract wrote in final blocks, newest first, decoded with its verified ABI (a proxy's with the implementation's too), paged. */
export function EventsTab({ detail }: { detail: ContractDetail }) {
  const abis = useAbi(detail);
  const verifiedAbi = abis.all;
  const isVerified = verifiedAbi.length > 0;
  // An unverified contract's logs are still read as the standard token events they are; a verified ABI always wins.
  const abi = useMemo(() => abiOrStandard(verifiedAbi), [verifiedAbi]);
  const now = useNow();
  const methods = useMemo(() => methodNames(abi), [abi]);
  const allKinds = useMemo(() => eventKinds(abi), [abi]);
  const [topic, setTopic] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState("");
  const p = usePaged(["contract-events", detail.address, topic], (c) => getContractEvents(detail.address, topic, c));
  // Verified: every event of the ABI. Not verified: only the standard events this page of logs holds (and the one chosen), so the row of buttons stays short.
  const seen = new Set(p.data?.items.map((e) => e.topics[0]) ?? []);
  const kinds = isVerified ? allKinds : allKinds.filter((k) => seen.has(k.topic0) || k.topic0 === topic);
  const apply = () => { if (TOPIC.test(text.trim())) { setTopic(text.trim().toLowerCase()); } };
  const typed = topic !== null && !kinds.some((k) => k.topic0 === topic);
  return (
    <section className="card" aria-label="Events">
      <CardHead as="h2" title="Events" sub={`${typeof detail.eventCount !== "number" ? "Events" : detail.eventCountCapped ? `${count(detail.eventCount)}+ events` : plural(detail.eventCount, "event")} from final blocks, ${isVerified ? "decoded with the verified ABI" : "decoded with standard token events, as the source is not verified"}, newest first`} action={
        <div className="ev-filter">
          <div className="seg" role="group" aria-label="Event kind">
            <button type="button" aria-pressed={topic === null} onClick={() => { setTopic(null); setTyping(false); }}>All events</button>
            {kinds.map((k) => <button key={k.topic0} type="button" aria-pressed={topic === k.topic0} title={k.signature} onClick={() => { setTopic(k.topic0); setTyping(false); }}>{k.name}</button>)}
          </div>
          <button type="button" className="btn-line" aria-pressed={typing || typed} onClick={() => setTyping((t) => !t)}><Icon name="search" size={13} /> Filter by topic</button>
        </div>
      } />
      {typing && (
        <form className="fn-q" onSubmit={(ev) => { ev.preventDefault(); apply(); }}>
          <label htmlFor="ev-topic" className="muted small">First topic</label>
          <input id="ev-topic" className="inp mono" type="text" spellCheck={false} placeholder="0x and 64 hex digits" value={text} onChange={(ev) => setText(ev.target.value)} />
          <button type="submit" className="btn-line">Filter</button>
        </form>
      )}
      {typing && text.trim() !== "" && !TOPIC.test(text.trim()) && <p className="fact-bad small" role="alert">A topic is 0x and 64 hex digits.</p>}
      {typed && <p className="small muted card-note">Only the logs whose first topic is <span className="mono">{topic}</span>.</p>}
      {p.error && !p.data ? <ErrorCard message={p.error.message} retrying />
        : !p.data ? <LoadingCard>Reading the events…</LoadingCard>
        : p.data.items.length === 0 ? <p className="muted">{topic ? "This contract has written no logs of that kind in a final block." : "This contract has written no logs in a final block."}</p>
        : (
          <div className="scroll tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Transaction</th><th>Method</th><th>Event</th><th>Decoded</th></tr></thead>
              <tbody>{p.data.items.map((e) => <Row key={`${e.block}-${e.logIndex}`} e={e} abi={abi} methods={methods} now={now} />)}</tbody>
            </table>
          </div>
        )}
      <p className="small muted ev-foot">Only events of final blocks are listed. An event in a block that is still being proven appears here once the block is final.</p>
      <Pager p={p} label="Events pages" />
    </section>
  );
}

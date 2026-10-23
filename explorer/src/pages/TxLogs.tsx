import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { decodeEventOf, type Decoded } from "../abi-call.ts";
import { abiOrStandard } from "../abi.ts";
import { getTxLogs, type ApiTxSeen, type Label, type Log, type TxLog } from "../api.ts";
import { AddressCell } from "../components/AddressCell.tsx";
import { HashLink } from "../components/HashLink.tsx";
import { Pager, usePaged } from "../components/Pager.tsx";
import { Seg } from "../components/Seg.tsx";
import { plural } from "../format.ts";
import { labelName, useLabels, type Labels } from "../labels.ts";
import { inUnits } from "./txValues.ts";
import { useSources } from "./useSources.ts";

/** The first topic of an ERC-20 Transfer. */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** How a log was read: by the server, with the contract's verified ABI, or with the standard token ABI. */
type How = "verified" | "standard";
/** `n` is the log's place among the transaction's own logs, counted from 0. */
interface Shown { n: number; address: string; topics: string[]; data: string; decoded: Decoded | TxLog["decoded"]; how: How | null }
type Raw = Pick<Shown, "n" | "address" | "topics" | "data"> & { decoded: TxLog["decoded"] };

/** The name of a log: the decoded event when there is one, a Transfer by its first topic, and none otherwise. */
const nameOf = (topics: string[], decoded: Shown["decoded"]) => (decoded ? decoded.name : topics[0] === TRANSFER_TOPIC ? "Transfer" : null);

/** The addresses a topic may be: a 32-byte topic that is an address padded with zeros. A topic that is not one gives a label of nothing, harmlessly. */
const topicAddress = (topic: string) => (/^0x0{24}[0-9a-fA-F]{40}$/.test(topic) ? `0x${topic.slice(26)}` : null);

/** Which arguments sit in the topics: the event's own answer, or the first ones when only the server's reading is held. */
const indexedOf = (d: NonNullable<Shown["decoded"]>, topicCount: number): boolean[] => ("indexed" in d && d.indexed ? d.indexed : d.args.map((_, i) => i < topicCount - 1));

function Chip({ name }: { name: string }) {
  return <span className="argchip">{name}</span>;
}

/** An address in a topic: its name when it has one, and its full address as a link. */
function Who({ address, labels }: { address: string; labels: Labels }) {
  const label = labels.get(address);
  return <>{labelName(label) && <><AddressCell address={address} label={label} />{" "}</>}<Link className="mono wrap" to={`/address/${address}`}>{address}</Link></>;
}

/** A data argument: its raw value, and for an amount of the token the amount in whole units after it. */
function DataArg({ name, value, type, token }: { name: string; value: string; type: string; token: Label | undefined }) {
  const units = type === "uint256" && /^(value|amount|wad)$/i.test(name) ? inUnits(value, token) : null;
  return <div><Chip name={name || type} /> <span className="mono wrap">{value}</span>{units && <span className="muted"> = {units}</span>}</div>;
}

function LogRow({ log, t, labels, mode }: { log: Shown; t: ApiTxSeen; labels: Labels; mode: "decoded" | "hex" }) {
  const d = mode === "decoded" ? log.decoded : null;
  const indexed = d ? indexedOf(d, log.topics.length) : [];
  const label = labels.get(log.address);
  const token = labelName(label) ? label : undefined;
  const args = d?.args ?? [];
  const inTopics = args.filter((_, i) => indexed[i]);
  const inData = args.filter((_, i) => !indexed[i]);
  const params = args.map((a, i) => `${indexed[i] ? `index_topic_${args.slice(0, i).filter((_, j) => indexed[j]).length + 1} ` : ""}${a.type}${a.name ? ` ${a.name}` : ""}`);
  return (
    <div className="logrow" role="group" aria-label={`Log ${log.n}`}>
      <span className="mono muted lognum">{log.n}</span>
      <dl className="log">
        <dt className="log-k">Address</dt>
        <dd>
          {labelName(label) ? <Who address={log.address} labels={labels} /> : <HashLink value={log.address} to={`/address/${log.address}`} />}
          {log.address === t.to && t.toToken && <span className="tag">{t.toToken}</span>}
        </dd>
        <dt className="log-k">Name</dt>
        <dd>
          {d ? <><span className="mono ev-name">{d.name}</span> <span className="mono small">({params.join(", ")})</span></> : (nameOf(log.topics, log.decoded) ?? <span className="muted">not decoded</span>)}
        </dd>
        <dt className="log-k">Topics</dt>
        <dd>
          {log.topics.map((topic, i) => {
            const a = d && i > 0 ? inTopics[i - 1] : undefined;
            const plain = <span className="mono wrap">{topic}</span>;
            return (
              <div key={i}><span className="muted">{i}</span>{" "}
                {a ? <><Chip name={a.name || a.type} /> {a.type === "address" && ADDRESS.test(a.value) ? <Who address={a.value} labels={labels} /> : <span className="mono wrap">{a.value}</span>}</> : plain}
              </div>
            );
          })}
        </dd>
        <dt className="log-k">Data</dt>
        <dd>{d && inData.length > 0 ? inData.map((a, i) => <DataArg key={i} name={a.name} value={a.value} type={a.type} token={token} />) : <span className="mono wrap">{log.data}</span>}</dd>
      </dl>
    </div>
  );
}

/** Said only when some log on the page is not decoded: a decoded one has its name and arguments shown. */
const NoDecode = ({ shown }: { shown: boolean }) => !shown ? null : <p className="small muted">Events are shown raw. Decoding them needs a verified interface for the contract that emitted them, and none is held.</p>;

/** What the card says of how its logs were read. */
function readWith(logs: Shown[], labels: Labels): string {
  const verified = logs.filter((l) => l.how === "verified").length, standard = logs.filter((l) => l.how === "standard").length;
  const head = plural(logs.length, "log");
  if (verified === 0 && standard === 0) return head;
  const emitters = new Set(logs.map((l) => l.address.toLowerCase()));
  if (verified === logs.length && emitters.size === 1) return `${head}, decoded with the verified ABI of ${labelName(labels.get(logs[0]!.address)) ?? "the contract"}`;
  const parts = [verified > 0 && `${verified} with verified ABIs`, standard > 0 && `${standard} with the standard token interface`, verified + standard < logs.length && `${logs.length - verified - standard} not decoded`].filter(Boolean);
  return `${head}, ${parts.join(", ")}`;
}

/** The logs as a list of cards, with the names of the addresses and the ABIs read together, and the switch between decoded and hex. */
function LogList({ raws, t, extra, foot }: { raws: Raw[]; t: ApiTxSeen; extra?: ReactNode; foot?: ReactNode }) {
  const [mode, setMode] = useState<"decoded" | "hex">("decoded");
  const labels = useLabels(raws.flatMap((l) => [l.address, ...l.topics.map(topicAddress)]));
  const contracts = raws.map((l) => l.address).filter((a) => { const k = labels.get(a)?.kind; return k === "contract" || k === "token"; });
  const sources = useSources(contracts);
  const logs = useMemo<Shown[]>(() => raws.map((l) => {
    if (l.decoded) return { ...l, how: "verified" as const };
    const verified = sources.get(l.address.toLowerCase())?.abi ?? null;
    const own = verified ? decodeEventOf(verified, l.topics, l.data) : null;
    if (own) return { ...l, decoded: own, how: "verified" as const };
    const std = decodeEventOf(abiOrStandard(null), l.topics, l.data);
    return std ? { ...l, decoded: std, how: "standard" as const } : { ...l, how: null };
  }), [raws, sources]);
  const any = logs.some((l) => l.decoded);
  return (
    <section className="card" aria-label="Logs">
      <div className="sec-h">
        <span className="small muted">{logs.length > 0 ? (any ? readWith(logs, labels) : plural(logs.length, "log")) : ""}</span>
        {any && <span className="sec-r"><Seg label="Logs view" value={mode} options={[{ id: "decoded", text: "Decoded" }, { id: "hex", text: "Hex" }]} onPick={setMode} /></span>}
      </div>
      <NoDecode shown={logs.some((l) => l.decoded === null)} />
      {extra}
      {logs.map((l) => <LogRow key={l.n} t={t} log={l} labels={labels} mode={mode} />)}
      {foot}
    </section>
  );
}

/** The logs of a final transaction, a page at a time. */
function FinalLogs({ t }: { t: ApiTxSeen }) {
  const p = usePaged(["tx-logs", t.hash], (after) => getTxLogs(t.hash, after));
  const raws = useMemo<Raw[]>(() => (p.data?.items ?? []).map((l) => ({ n: l.position, address: l.address, topics: l.topics, data: l.data, decoded: l.decoded })), [p.data]);
  if (p.error && !p.data) return <div className="alert" role="alert">{p.error.message}</div>;
  if (!p.data) return <p className="muted" aria-busy="true">Reading the logs…</p>;
  return (
    <LogList raws={raws} t={t} extra={raws.length === 0 ? <p className="muted">This transaction emitted no logs.</p> : null} foot={<Pager p={p} label="Pages of logs" />} />
  );
}

/** The logs of a transaction that is not final: all the page has is what /api/tx gave. */
function SeenLogs({ t }: { t: ApiTxSeen }) {
  const logs: Log[] = t.logs;
  const raws = useMemo<Raw[]>(() => logs.map((l, i) => ({ n: i, address: l.address, topics: l.topics, data: l.data, decoded: null })), [logs]);
  return <LogList raws={raws} t={t} extra={logs.length === 0 ? <p className="muted">This transaction has emitted no logs so far.</p> : null} />;
}

export const LogsTab = ({ t }: { t: ApiTxSeen }) => (t.status === "final" ? <FinalLogs t={t} /> : <SeenLogs t={t} />);

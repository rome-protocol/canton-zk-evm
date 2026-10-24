import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getBlock, getTx, getUpdate, getUpdates, getUpdatesAround, type ApiBlock, type UpdateAroundItem, type UpdateDetail, type UpdateItem } from "../api.ts";
import { ErrorCard, LoadingCard, unready } from "../components/Cards.tsx";
import { Chip } from "../components/Chip.tsx";
import { CopyButton, HashLink, copyText } from "../components/HashLink.tsx";
import { Icon } from "../components/Icon.tsx";
import { Item, Kv } from "../components/Kv.tsx";
import { Pager, usePaged } from "../components/Pager.tsx";
import { bytesOf, count, duration, seconds, short, units, utc, utcDate } from "../format.ts";
import { listPoll } from "../stats.ts";
import { useFollowing, useNow, useStatus } from "../useStatus.ts";
import { useLive } from "../useLive.ts";
import { Bad, Good } from "./BlockSides.tsx";
import "./block.css";
import "./canton.css";

/** The reader's note, said once for both pages: what the offset is the offset of. */
const READER = "on the reader's participant";

/** The Canton updates that carry a block, newest first. Each offset is the one the reader party's participant gives it, never the builder's completion offset. */
export function CantonUpdates() {
  const live = useLive(["blocks"]);
  const p = usePaged(["canton", "updates"], getUpdates, listPoll(live));
  const items = p.data?.items;
  return (
    <>
      <div className="ptitle"><h1>Canton updates</h1><span className="muted">the updates that carry a block, as the reader party sees them</span></div>
      <div className="note">Each final block is one Canton transaction. The offset is the one the reader's participant gives the update ({READER}); it is not the builder's own completion offset.</div>
      {p.error && !items ? <ErrorCard message={p.error.message} retrying /> : !items ? <LoadingCard>Reading the Canton updates…</LoadingCard> : (
        <section className="card" aria-label="Canton updates">
          <div className="list-h"><span className="muted">{items.length ? "Newest first, by record time" : "No Canton updates yet."}</span><Pager p={p} label="Pages of Canton updates" /></div>
          <div className="scroll">
            <table className="tbl">
              <thead><tr><th className="r">Offset</th><th>Update id</th><th>Record time</th><th>Synchronizer</th><th>EVM block</th></tr></thead>
              <tbody>
                {items.map((u: UpdateItem) => (
                  <tr key={u.updateId}>
                    <td className="r num">{u.offset}</td>
                    <td><HashLink value={u.updateId} kind="update" to={`/canton/${u.updateId}`} /></td>
                    <td className="mono">{u.recordTime}</td>
                    <td><HashLink value={u.synchronizer} /></td>
                    <td>{u.block === null ? <span className="muted">none</span> : <Link className="num" to={`/block/${u.block}`}>Block {u.block}</Link>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">Offsets are {READER}. Updates there that carry no block are not listed, so offsets can skip.</p>
        </section>
      )}
    </>
  );
}

const NOT_LOGGED = <span className="muted">not in the producer's log</span>;
const PRODUCER = <span className="tag">producer log</span>;

function OnCanton({ u, now }: { u: UpdateDetail; now: number }) {
  const t = u.template, pr = u.producerRecord;
  return (
    <section className="card side canton" aria-labelledby="oc-h">
      <div className="side-h"><span className="side-l" id="oc-h">On Canton</span><span className="muted small">as the reader party sees it</span></div>
      <Kv>
        <Item label="Update id"><HashLink value={u.updateId} full /></Item>
        <Item label="Record time"><span className="mono">{u.recordTime}</span> <span className="muted">· {duration(now - Date.parse(u.recordTime))} ago</span></Item>
        <Item label="Synchronizer id"><HashLink value={u.synchronizer} full /></Item>
        <Item label="Offset"><span className="num">{count(u.offset)}</span> <span className="tag">{READER}</span></Item>
        <Item label="Template">{pr?.template ? <><span className="mono">{pr.template}</span> {PRODUCER}</> : NOT_LOGGED}</Item>
        <Item label="Choice">{pr?.choice ? <><span className="mono">{pr.choice}</span> <span className="muted">· exercised on the chain's head contract</span> {PRODUCER}</> : NOT_LOGGED}</Item>
        <Item label="Created">
          <span className="mono">{t.module}:{t.entity}</span>
          {u.contractId && <> <span className="muted">· contract</span> <HashLink value={u.contractId} /></>}
          <span className="muted"> · package <span className="mono" title={t.packageName ?? undefined}>{short(t.packageId, 8, 4)}</span></span>
        </Item>
        {u.signatories.length > 0 && (
          <Item label="Signed by"><div className="signers">{u.signatories.map((s) => <div key={s.role + s.party}><span className="muted">the chain's {s.role}</span><HashLink value={s.party} kind="party" full /></div>)}</div></Item>
        )}
        {pr?.commandId && <Item label="Command id"><span className="mono">{pr.commandId}</span> {PRODUCER}</Item>}
        {pr?.argumentBytes != null && <Item label="Carried"><span className="num">{count(pr.argumentBytes)}</span> bytes in the argument{pr.trafficBytes != null && <>, <span className="num">{count(pr.trafficBytes)}</span> bytes of traffic</>} {PRODUCER}</Item>}
      </Kv>
    </section>
  );
}

/** What the block holds, in a line: how many transactions, the first one's hash, what it carried and from whom to whom. The value is the transaction's own route's. */
function Transactions({ b }: { b: ApiBlock }) {
  const first = b.transactions[0];
  const coin = useStatus().data?.coin;
  const tx = useQuery({ queryKey: ["tx", first?.hash], queryFn: () => getTx(first!.hash), enabled: !!first, retry: false, staleTime: 60_000 });
  if (!first) return <span className="num">{count(b.txCount)}</span>;
  const value = tx.data?.value;
  const carried = tx.isError || value === null ? <span className="muted">cannot be read right now</span>
    : value === undefined || !coin ? <span className="muted">reading…</span>
    : <span>{units(value, coin.decimals)} {coin.symbol}</span>;
  const person = (a: string) => <Link className="mono" to={`/address/${a}`}>{short(a)}</Link>;
  return (
    <>
      <span className="num">{count(b.txCount)}</span> <span className="muted">·</span> <Link className="mono" to={`/tx/${first.hash}`}>{short(first.hash, 10, 6)}</Link>{" "}
      {carried}<span className="muted">,</span> {person(first.from)} <span className="muted">{first.to ? "to" : "creating a contract"}</span> {first.to && person(first.to)}
      {b.txCount > 1 && <span className="muted"> and {count(b.txCount - 1)} more</span>}
    </>
  );
}

/** The size of the proof and each fact read from its own bytes, against the explorer's pins. */
function ProofFacts({ c }: { c: NonNullable<ApiBlock["canton"]> }) {
  const f = c.proof;
  return (
    <>
      <span className="num">{count(c.proofBytes)} bytes</span>{" "}
      {!f ? <span className="muted">its facts cannot be read</span> : (
        <>
          {f.programVK.ok ? <Good>ours</Good> : <Bad>program key is not ours</Bad>} <span className="muted">·</span>{" "}
          {f.rootC.ok ? <Good>ZisK 1.3.1</Good> : <Bad>ZisK release is not 1.3.1</Bad>} <span className="muted">·</span>{" "}
          {f.blockHash.ok ? <Good>this block</Good> : <Bad>not this block's hash</Bad>}
        </>
      )}
    </>
  );
}

function OnEvm({ u, b, failed }: { u: UpdateDetail; b: ApiBlock | undefined; failed: boolean }) {
  const c = b?.canton;
  return (
    <section className="card side evm" aria-labelledby="oe-h">
      <div className="side-h"><span className="side-l" id="oe-h">On the EVM</span><span className="muted small">from reth, at the final head</span>
        <span className="grow" />
        {u.block !== null && <Link className="btn-line" to={`/block/${u.block}`}>Open block {u.block} <Icon name="next" size={13} /></Link>}</div>
      <Kv>
        <Item label="Block">{u.block === null ? "none" : <><Link className="num" to={`/block/${u.block}`}>{u.block}</Link> <Chip status="final" /></>}</Item>
        {u.blockHash && <Item label="Block hash"><HashLink value={u.blockHash} to={`/block/${u.blockHash}`} full /></Item>}
        {b && (
          <>
            <Item label="Parent">{b.number > 0 ? <><Link className="num" to={`/block/${b.number - 1}`}>Block {b.number - 1}</Link> · <HashLink value={b.parentHash} to={`/block/${b.parentHash}`} /></> : "none"}</Item>
            <Item label="Block time"><span className="mono">{utc(b.timestamp * 1000)}</span> <span className="muted">· {utcDate(b.timestamp * 1000)}{c ? ` · made ${seconds(b.timestamp, c.recordTime)} before the record time` : ""}</span></Item>
            <Item label="Transactions"><Transactions b={b} /></Item>
            <Item label="Gas used"><span className="num">{count(b.gasUsed)}</span> <span className="muted">of {count(b.gasLimit)}</span></Item>
            <Item label="State root"><HashLink value={b.stateRoot} /></Item>
            {c && <Item label="Proof"><ProofFacts c={c} /></Item>}
            {c && <Item label="Hashes">{c.hashesMatch ? <Good>reth, the record and the record's header give the same hash</Good> : <Bad>reth, the record and the record's header do not all give the same hash</Bad>}</Item>}
          </>
        )}
      </Kv>
      {failed && <p className="muted small">The block cannot be read right now.</p>}
    </section>
  );
}

/** What joins the two sides: the one block and the one Canton transaction, which the block's hash names. */
function Join({ hash }: { hash: string | null }) {
  return (
    <div className="join" role="group" aria-label="The block and its Canton transaction">
      <span className="join-ic"><Icon name="link" size={18} /></span>
      <span className="muted small">one block, one Canton transaction</span>
      {hash && <Link className="mono small" to={`/block/${hash}`}>{short(hash)}</Link>}
    </div>
  );
}

/** A part of the record, copied as hex. */
function CopyPart({ name, hex }: { name: string; hex: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button type="button" className="btn-line" aria-label={copied ? "Copied" : `Copy the ${name}`} onClick={async () => {
      if (!(await copyText(hex))) return;
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    }}><Icon name={copied ? "check" : "copy"} size={13} />{name}</button>
  );
}

/** The three parts of the record, in proportion, each to copy. Verify itself is on the block page, which holds the pins it checks them against. */
function RecordHolds({ c, block }: { c: NonNullable<ApiBlock["canton"]>; block: number }) {
  const parts = [["header", c.headerHex], ["transactions", c.txsHex], ["proof", c.proofHex]] as const;
  const size = (hex: string) => hex.length / 2;
  const total = parts.reduce((n, [, hex]) => n + size(hex), 0);
  return (
    <section className="card rec holds" aria-labelledby="holds-h">
      <div className="rec-row">
        <h3 className="rec-k" id="holds-h">What the record holds</h3><span className="muted small">the three parts Verify checks; each can be copied as hex</span>
        <span className="grow" />
        {parts.map(([name, hex]) => <CopyPart key={name} name={name} hex={hex} />)}
        <Link className="btn-primary" to={`/block/${block}`}><Icon name="check" size={13} />Verify in your browser</Link>
      </div>
      <div className="bar" role="img" aria-label="The parts of the record, in proportion">
        {parts.map(([name, hex]) => <span key={name} className={`bar-${name}`} style={{ flexGrow: size(hex) }}>{name === "transactions" ? "txs" : `${name} ${bytesOf(hex)}`}</span>)}
      </div>
      <div className="bar-key small muted">
        {parts.map(([name, hex]) => <span key={name}>{`${name} ${count(size(hex))} bytes`}</span>)}
        <span className="grow" />
        <span>{count(total)} bytes in all, carried hex-encoded in the Advance argument</span>
      </div>
    </section>
  );
}

/** What the reader party can and cannot see of this transaction. */
function Privacy({ chain }: { chain: string | undefined }) {
  return (
    <div className="legs" role="note" aria-label="What the reader party sees">
      <Icon name="lock" size={15} />
      <div><b>What the reader party sees, and what it does not.</b> It is shown the BlockRecord this update creates, with the two signers above. Any Daml legs settled in the same Canton transaction are seen only by their parties, so they are not shown, and no other party id is shown. Canton's public scan does not list {chain ?? "this chain"}'s activity; this page is read through the chain's own reader party.</div>
    </div>
  );
}

/** The offsets one participant gave that the window skips, each with the blocks it lies between. Only offsets of one participant are compared. */
function skipped(items: UpdateAroundItem[]): string | null {
  const words: string[] = [];
  items.slice(0, -1).forEach((a, i) => {
    const b = items[i + 1]!;
    if (a.participant !== b.participant || a.offset - b.offset < 2) return;
    const [from, to] = [b.offset + 1, a.offset - 1];
    const range = from === to ? `Offset ${from} belongs` : `Offsets ${from} to ${to} belong`;
    words.push(`${range} to other updates on the reader's participant${a.block !== null && b.block !== null ? `, between blocks ${b.block} and ${a.block}` : ""}.`);
  });
  return words.length ? `${words.join(" ")} They carry no block, so they are not listed.` : null;
}

/** The updates just newer and just older than this one, from the route that gives the window by the list's own key. */
function Around({ id }: { id: string }) {
  const q = useQuery({ queryKey: ["canton", "around", id], queryFn: () => getUpdatesAround(id), retry: false });
  const items = q.data?.items;
  const gap = items && skipped(items);
  return (
    <section className="card" aria-labelledby="around-h">
      <div className="sec-h"><h3 id="around-h">Canton updates around this one</h3><span className="muted small">ordered by record time and update id · offsets {READER}</span><span className="grow" /><Link className="btn-line" to="/canton">All Canton updates <Icon name="next" size={13} /></Link></div>
      {q.isError ? <p className="muted">The explorer cannot read the updates around this one right now.</p> : !items ? <p className="muted">Reading the Canton updates…</p> : (
        <>
          <div className="scroll">
            <table className="tbl">
              <thead><tr><th>Offset</th><th>Update id</th><th>Record time</th><th>Template · choice {PRODUCER}</th><th>EVM block</th><th className="r">Transactions</th></tr></thead>
              <tbody>
                {items.map((x) => (
                  <tr key={x.updateId} aria-current={x.updateId === id ? "true" : undefined} className={x.updateId === id ? "here" : undefined}>
                    <td className="num">{x.offset}</td>
                    <td><HashLink value={x.updateId} kind="update" to={`/canton/${x.updateId}`} plain /></td>
                    <td className="mono">{x.recordTime}</td>
                    <td className="mono">{x.submittedTemplate ? `${x.submittedTemplate}${x.submittedChoice ? ` · ${x.submittedChoice}` : ""}` : NOT_LOGGED}</td>
                    <td>{x.block === null ? <span className="muted">none</span> : <Link className="num" to={`/block/${x.block}`}>Block {x.block}</Link>}</td>
                    <td className="r num">{x.txCount === null ? <span className="muted">—</span> : count(x.txCount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {gap && <p className="muted small">{gap}</p>}
        </>
      )}
    </section>
  );
}

/** One Canton update, with the block its record holds. It is final the moment it is read, so it is read once. */
export function CantonUpdate() {
  const { updateId = "" } = useParams();
  const now = useNow();
  const st = useStatus().data;
  const q = useFollowing(["canton", "update", updateId], () => getUpdate(updateId), () => true);
  const blk = q.data?.block ?? null;
  const evm = useQuery({ queryKey: ["block", String(blk)], queryFn: () => getBlock(String(blk)), enabled: blk !== null });
  const wait = unready(q, "Reading the Canton update…");
  if (wait) return wait;
  const u = q.data!;
  return (
    <>
      <div className="crumbs"><Link to="/canton">Canton</Link> / Update {u.updateId.slice(0, 12)}…</div>
      <div className="ptitle">
        <h1>Canton update</h1><span className="chip chip-final"><i className="dot" />Final on Canton</span>
        {u.block !== null && <span className="muted">the record of block {u.block}</span>}
        <span className="grow" />
        {u.block !== null && (
          <nav className="pn" aria-label="Neighbouring blocks">
            {u.block > 0 && <Link to={`/block/${u.block - 1}`}><Icon name="prev" size={13} /> block {u.block - 1}</Link>}
            {st?.final && st.final.number > u.block && <Link className="pn-next" to={`/block/${u.block + 1}`}>block {u.block + 1} <Icon name="next" size={13} /></Link>}
          </nav>
        )}
      </div>
      <p className="updid mono">{u.updateId} <CopyButton value={u.updateId} /></p>
      <div className="sides sides-join"><OnCanton u={u} now={now} /><Join hash={u.blockHash} /><OnEvm u={u} b={evm.data} failed={evm.isError} /></div>
      {evm.data?.canton && u.block !== null && <RecordHolds c={evm.data.canton} block={u.block} />}
      <Privacy chain={st?.chainName} />
      <Around id={u.updateId} />
    </>
  );
}

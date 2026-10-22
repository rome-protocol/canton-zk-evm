import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { getBlock, getUpdate, getUpdates, type ApiBlock, type UpdateDetail, type UpdateItem } from "../api.ts";
import { ErrorCard, LoadingCard, unready } from "../components/Cards.tsx";
import { Chip } from "../components/Chip.tsx";
import { CopyButton, HashLink } from "../components/HashLink.tsx";
import { Item, Kv } from "../components/Kv.tsx";
import { Pager, usePaged } from "../components/Pager.tsx";
import { bytesOf, count, duration, gwei, seconds, utc, utcDate } from "../format.ts";
import { listPoll } from "../stats.ts";
import { useFollowing, useNow, useStatus } from "../useStatus.ts";
import { useLive } from "../useLive.ts";

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
                    <td className="r mono">{u.offset}</td>
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

function OnCanton({ u, now }: { u: UpdateDetail; now: number }) {
  const t = u.template, pr = u.producerRecord;
  return (
    <section className="card side canton" aria-labelledby="oc-h">
      <div className="side-h"><span className="side-l" id="oc-h">On Canton</span><span className="muted small">as the reader party sees it</span></div>
      <Kv>
        <Item label="Update id"><HashLink value={u.updateId} full /></Item>
        <Item label="Record time"><span className="mono">{u.recordTime}</span> <span className="muted">· {duration(now - Date.parse(u.recordTime))} ago</span></Item>
        <Item label="Synchronizer id"><HashLink value={u.synchronizer} full /></Item>
        <Item label="Offset"><span className="mono">{count(u.offset)}</span> <span className="tag">{READER}</span></Item>
        <Item label="Template"><span className="mono">{t.module}:{t.entity}</span>{t.packageName && <span className="muted"> · package {t.packageName}</span>}</Item>
        {pr?.template && <Item label="Submitted"><span className="mono">{pr.template}</span>{pr.choice && <> · choice <span className="mono">{pr.choice}</span></>} <span className="tag">producer log</span></Item>}
        {u.contractId && <Item label="Created"><span className="mono">{t.module}:{t.entity}</span> <span className="muted">· contract</span> <HashLink value={u.contractId} /></Item>}
        {u.signatories.length > 0 && (
          <Item label="Signed by"><div className="signers">{u.signatories.map((s) => <div key={s.role + s.party}><span className="muted">{s.role}</span> <HashLink value={s.party} kind="party" /></div>)}</div></Item>
        )}
        {pr?.commandId && <Item label="Command id"><span className="mono">{pr.commandId}</span> <span className="tag">producer log</span></Item>}
        {pr?.argumentBytes != null && <Item label="Carried"><span className="mono">{count(pr.argumentBytes)}</span> bytes in the argument{pr.trafficBytes != null && <>, <span className="mono">{count(pr.trafficBytes)}</span> bytes of traffic</>}</Item>}
      </Kv>
    </section>
  );
}

function OnEvm({ u, b, failed }: { u: UpdateDetail; b: ApiBlock | undefined; failed: boolean }) {
  const c = b?.canton;
  return (
    <section className="card side evm" aria-labelledby="oe-h">
      <div className="side-h"><span className="side-l" id="oe-h">On the EVM</span><span className="muted small">from reth, at the final head</span>
        {u.block !== null && <Link className="btn-link" to={`/block/${u.block}`}>Open block {u.block} →</Link>}</div>
      <Kv>
        <Item label="Block">{u.block === null ? "none" : <><Link className="num" to={`/block/${u.block}`}>{u.block}</Link> <Chip status="final" /></>}</Item>
        {u.blockHash && <Item label="Block hash"><HashLink value={u.blockHash} to={`/block/${u.blockHash}`} full /></Item>}
        {b && (
          <>
            <Item label="Parent">{b.number > 0 ? <><Link className="num" to={`/block/${b.number - 1}`}>Block {b.number - 1}</Link> · <HashLink value={b.parentHash} to={`/block/${b.parentHash}`} /></> : "none"}</Item>
            <Item label="Block time"><span className="mono">{utc(b.timestamp * 1000)}</span> <span className="muted">· {utcDate(b.timestamp * 1000)}{c ? ` · made ${seconds(b.timestamp, c.recordTime)} before the record time` : ""}</span></Item>
            <Item label="Transactions">{b.txCount}</Item>
            <Item label="Gas used"><span className="mono">{count(b.gasUsed)}</span> <span className="muted">of {count(b.gasLimit)}</span></Item>
            <Item label="Base fee">{b.baseFee === null ? "none" : gwei(b.baseFee)}</Item>
            <Item label="State root"><HashLink value={b.stateRoot} /></Item>
            {c && <Item label="Proof"><span className="mono">{count(c.proofBytes)}</span> bytes</Item>}
            {c && <Item label="Hashes">{c.hashesMatch ? <span className="fact-ok">reth, the record and the record's header give the same hash</span> : <span className="fact-bad">reth, the record and the record's header do not all give the same hash</span>}</Item>}
          </>
        )}
      </Kv>
      {failed && <p className="muted small">The block cannot be read right now.</p>}
    </section>
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
        {parts.map(([name, hex]) => <span key={name} className="rd mono">{`${name} ${bytesOf(hex)} `}<CopyButton value={hex} label={`Copy the ${name}`} /></span>)}
        <Link className="btn-link" to={`/block/${block}`}>Verify in your browser</Link>
      </div>
      <div className="bar" role="img" aria-label="The parts of the record, in proportion">
        {parts.map(([name, hex]) => <span key={name} className={`bar-${name}`} style={{ flexGrow: size(hex) }} />)}
      </div>
      <div className="bar-key small muted">
        {parts.map(([name, hex]) => <span key={name}>{`${name} ${count(size(hex))} bytes`}</span>)}
        <span className="grow" />
        <span>{count(total)} bytes in all, carried hex-encoded in the Advance argument</span>
      </div>
    </section>
  );
}

/** The newest updates, with this one marked when it is among them. The route pages from the newest, so an update far back is not in this window. */
function Newest({ id }: { id: string }) {
  const q = useQuery({ queryKey: ["canton", "newest"], queryFn: () => getUpdates(null, 6) });
  const items = q.data?.items;
  return (
    <section className="card" aria-labelledby="newest-h">
      <div className="sec-h"><h3 id="newest-h">Newest Canton updates</h3><span className="muted small">ordered by record time · offsets {READER}</span><Link className="btn-link" to="/canton">All Canton updates →</Link></div>
      {q.isError ? <p className="muted">The explorer cannot read this list right now.</p> : !items ? <p className="muted">Reading the Canton updates…</p> : (
        <div className="scroll">
          <table className="tbl">
            <thead><tr><th className="r">Offset</th><th>Update id</th><th>Record time</th><th>EVM block</th></tr></thead>
            <tbody>
              {items.map((x) => (
                <tr key={x.updateId} aria-current={x.updateId === id ? "true" : undefined} className={x.updateId === id ? "here" : undefined}>
                  <td className="r mono">{x.offset}</td>
                  <td><HashLink value={x.updateId} kind="update" to={`/canton/${x.updateId}`} /></td>
                  <td className="mono">{x.recordTime}</td>
                  <td>{x.block === null ? <span className="muted">none</span> : <Link className="num" to={`/block/${x.block}`}>Block {x.block}</Link>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
        <h1>Canton update</h1><Chip status="final" />
        {u.block !== null && <span className="muted">the record of block {u.block}</span>}
        <span className="grow" />
        {u.block !== null && (
          <nav className="pn" aria-label="Neighbouring blocks">
            {u.block > 0 && <Link to={`/block/${u.block - 1}`}>block {u.block - 1}</Link>}
            {st?.final && st.final.number > u.block && <Link to={`/block/${u.block + 1}`}>block {u.block + 1}</Link>}
          </nav>
        )}
      </div>
      <p className="updid mono">{u.updateId}</p>
      <div className="sides"><OnCanton u={u} now={now} /><OnEvm u={u} b={evm.data} failed={evm.isError} /></div>
      <div className="legs"><span>What the reader party sees, and what it does not. Daml legs settled in the same Canton transaction are seen only by their parties, so they are not shown here, and no other party id is shown.</span></div>
      {evm.data?.canton && u.block !== null && <RecordHolds c={evm.data.canton} block={u.block} />}
      <Newest id={u.updateId} />
    </>
  );
}

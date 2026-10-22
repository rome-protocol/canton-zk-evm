import { Link, useParams } from "react-router-dom";
import { getUpdate, getUpdates, type UpdateDetail, type UpdateItem } from "../api.ts";
import { ErrorCard, LoadingCard, unready } from "../components/Cards.tsx";
import { Chip } from "../components/Chip.tsx";
import { HashLink } from "../components/HashLink.tsx";
import { Item, Kv } from "../components/Kv.tsx";
import { Pager, usePaged } from "../components/Pager.tsx";
import { count, duration } from "../format.ts";
import { listPoll } from "../stats.ts";
import { useFollowing, useNow } from "../useStatus.ts";
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

function OnEvm({ u }: { u: UpdateDetail }) {
  return (
    <section className="card side evm" aria-labelledby="oe-h">
      <div className="side-h"><span className="side-l" id="oe-h">On the EVM</span><span className="muted small">from reth, at the final head</span>
        {u.block !== null && <Link className="btn-link" to={`/block/${u.block}`}>Open block {u.block} →</Link>}</div>
      <Kv>
        <Item label="Block">{u.block === null ? "none" : <><Link className="num" to={`/block/${u.block}`}>{u.block}</Link> <Chip status="final" /></>}</Item>
        {u.blockHash && <Item label="Block hash"><HashLink value={u.blockHash} to={`/block/${u.blockHash}`} full /></Item>}
      </Kv>
    </section>
  );
}

/** One Canton update, with the block its record holds. It is final the moment it is read, so it is read once. */
export function CantonUpdate() {
  const { updateId = "" } = useParams();
  const now = useNow();
  const q = useFollowing(["canton", "update", updateId], () => getUpdate(updateId), () => true);
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
            <Link to={`/block/${u.block + 1}`}>block {u.block + 1}</Link>
          </nav>
        )}
      </div>
      <p className="updid mono">{u.updateId}</p>
      <div className="sides"><OnCanton u={u} now={now} /><OnEvm u={u} /></div>
      <div className="legs"><span>What the reader party sees, and what it does not. Daml legs settled in the same Canton transaction are seen only by their parties, so they are not shown here, and no other party id is shown.</span></div>
    </>
  );
}

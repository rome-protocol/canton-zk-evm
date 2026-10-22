import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getUpdate, type ApiBlock, type ApiStatus, type CantonSide, type UpdateDetail } from "../api.ts";
import { ago } from "../block-times.ts";
import { Chip } from "../components/Chip.tsx";
import { HashLink } from "../components/HashLink.tsx";
import { Icon } from "../components/Icon.tsx";
import { Item, Kv } from "../components/Kv.tsx";
import { count, exact, units, utc } from "../format.ts";
import "./block.css";

export const Good = ({ children }: { children: string }) => <span className="fact-ok"><Icon name="check" size={13} />{children}</span>;
export const Bad = ({ children }: { children: React.ReactNode }) => <span className="fact-bad"><Icon name="cross" size={13} />{children}</span>;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "20 Oct 2026, 12:49:09 UTC". */
const longUtc = (ms: number) => { const d = new Date(ms); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${utc(ms)}`; };

/** The word for where a block stands. A block that is final reads "Final on Canton", with how long ago that was. */
function Stage({ b }: { b: ApiBlock }) {
  if (b.status === "final" && b.canton) return <><span className="chip chip-final"><i className="dot" />Final on Canton</span> <span className="muted">final {ago(b.canton.recordTime)}</span></>;
  return <Chip status={b.status} />;
}

/** The share of the block's gas limit that its gas used makes, to two places. */
const share = (used: number, limit: number) => (limit > 0 ? `${((used / limit) * 100).toFixed(2)}%` : "—");

export function EvmSide({ b, st }: { b: ApiBlock; st: ApiStatus | undefined }) {
  const coin = st?.coin;
  const burnt = b.baseFee === null ? null : (BigInt(b.baseFee) * BigInt(b.gasUsed)).toString();
  const c = b.canton;
  const sizes = c && [["header", c.headerHex], ["transactions", c.txsHex], ["proof", c.proofHex]] as const;
  return (
    <section className="card side evm" aria-labelledby="evm-h">
      <div className="side-h"><span className="side-l" id="evm-h">On the EVM</span><span className="muted small">from reth{b.status === "final" ? ", at the final head" : ""}</span></div>
      <Kv wide>
        <Item label="Block height"><span className="mono">{b.number}</span></Item>
        <Item label="Stage"><Stage b={b} /></Item>
        <Item label="Time"><span className="mono">{longUtc(b.timestamp * 1000)}</span> <span className="muted">· block timestamp, whole seconds</span></Item>
        <Item label="Transactions"><a className="num" href="#transactions">{count(b.txCount)} transaction{b.txCount === 1 ? "" : "s"}</a></Item>
        <Item label="Hash"><HashLink value={b.hash} full /></Item>
        <Item label="Parent hash">
          {b.number > 0 ? <><HashLink value={b.parentHash} to={`/block/${b.parentHash}`} long /> <span className="muted">block {b.number - 1}</span></> : <span className="muted">none</span>}
        </Item>
        <Item label="Gas used"><span className="mono">{count(b.gasUsed)}</span> <span className="muted">({share(b.gasUsed, b.gasLimit)} of {count(b.gasLimit)})</span></Item>
        <Item label="Base fee">{b.baseFee === null ? "none" : <span className="mono" title={`${b.baseFee} wei`}>{exact(b.baseFee, 9)} gwei</span>}</Item>
        <Item label="Burnt fees">{burnt === null || !coin ? "—" : <span className="mono" title={`${exact(burnt, coin.decimals)} ${coin.symbol}`}>{units(burnt, coin.decimals)} {coin.symbol}</span>}</Item>
        <Item label="Fee recipient"><HashLink value={b.miner} to={`/address/${b.miner}`} />{b.baseFee !== null && <span className="muted"> · priority fees only</span>}</Item>
        <Item label="State root"><HashLink value={b.stateRoot} long /></Item>
        {sizes && (
          <Item label="Record data">
            <span className="mono">{count(sizes.reduce((n, [, h]) => n + h.length / 2, 0))} bytes</span>{" "}
            <span className="muted">· {sizes.map(([name, h]) => `${name} ${count(h.length / 2)}`).join(", ")}</span>
          </Item>
        )}
      </Kv>
    </section>
  );
}

/** What the update's own route adds to the block's record: the synchronizer, the offset on the reader's participant and what was submitted. Never the builder's offset. */
function Record({ b, c, st, update, reading, failed }: { b: ApiBlock; c: CantonSide; st: ApiStatus | undefined; update: UpdateDetail | undefined; reading: boolean; failed: boolean }) {
  const signers = st?.signers;
  const sent = update?.producerRecord;
  const [created, choice] = [c.template, sent?.choice ?? null];
  return (
    <Kv wide>
      <Item label="Update id"><HashLink value={c.updateId} kind="update" to={`/canton/${c.updateId}`} full /></Item>
      <Item label="Record time"><span className="mono">{c.recordTime}</span> <span className="muted">· {ago(c.recordTime)}</span></Item>
      <Item label="Synchronizer">{update ? <HashLink value={update.synchronizer} kind="party" /> : <span className="muted">—</span>}</Item>
      <Item label="Offset">{update ? <><span className="mono">{update.offset}</span> <span className="tag">on the reader's participant</span></> : <span className="muted">—</span>}</Item>
      <Item label="Template">
        {update ? (sent?.template ? <><span className="mono">{sent.template}</span>{choice && <> <span className="muted">· choice</span> <span className="mono">{choice}</span></>} <span className="tag">producer log</span></> : <span className="muted">not in the producer's log</span>)
          : failed ? <span className="muted">cannot be read right now</span> : reading ? <span className="muted">reading…</span> : <span className="muted">—</span>}
      </Item>
      <Item label="Created"><span className="mono">{created}</span> <span className="muted">for block {b.number}</span></Item>
      {signers && (
        <Item label="Signed by">
          <div className="signers">
            <div><span className="muted">the chain's operator</span> <HashLink value={signers.operator} kind="party" /></div>
            <div><span className="muted">the chain's confirmer</span> <HashLink value={signers.confirmer} kind="party" /></div>
          </div>
        </Item>
      )}
      <Item label="Hashes">
        {c.hashesMatch ? <Good>reth, the record and the record's header give the same hash</Good> : <Bad>reth, the record and the record's header do not all give the same hash</Bad>}
      </Item>
    </Kv>
  );
}

/** Block 0 has no record. It is tied to block 1's record by its hash, which block 1's record names as its parent. */
function GenesisSide({ b, st }: { b: ApiBlock; st: ApiStatus | undefined }) {
  const blockOne = (st?.final?.number ?? 0) >= 1;
  return (
    <div className="empty-side">
      <b>The chain's starting block.</b>
      <p>It has no block record. Block 1's record names it as its parent.</p>
      {b.genesisReferenced ? <Good>Block 1's record names this hash as its parent</Good>
        : blockOne ? <Bad>Block 1's record does not name this hash as its parent</Bad>
        : <p>Nothing on Canton refers to it yet.</p>}
    </div>
  );
}

export function CantonPanel({ b, st }: { b: ApiBlock; st: ApiStatus | undefined }) {
  const pending = b.status === "proving";
  const id = b.canton?.updateId;
  const update = useQuery({ queryKey: ["update", id], queryFn: () => getUpdate(id!), enabled: !!id, retry: false, staleTime: 60_000 });
  return (
    <section className={`card side canton${pending ? " pending" : ""}`} aria-labelledby="canton-h">
      <div className="side-h">
        <span className="side-l" id="canton-h">{b.canton ? "Final on Canton" : "On Canton"}</span>
        {b.canton && <span className="muted small">read as the reader party</span>}
        {b.canton && <><span className="grow" /><Link className="btn-line" to={`/canton/${b.canton.updateId}`}>Open the Canton record <Icon name="next" size={13} /></Link></>}
      </div>
      {b.canton ? <Record b={b} c={b.canton} st={st} update={update.data} reading={update.isPending} failed={update.isError} />
        : b.status === "genesis" ? <GenesisSide b={b} st={st} />
        : b.status === "unindexed" ? <div className="empty-side"><b>Final on Canton, not indexed yet.</b><p>Canton holds this block. The explorer has not read its record yet, so the record and the proof are not shown. This page looks again.</p></div>
        : <div className="empty-side"><b>Not on Canton yet.</b><p>reth has made this block and it is being proven. It becomes final when Canton commits it. It can still disappear if Canton refuses it.</p></div>}
    </section>
  );
}

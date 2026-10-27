import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getBlock, getBlockDetail, type ApiBlock, type ApiStatus, type BlockRow, type CantonSide } from "../api.ts";
import { unready } from "../components/Cards.tsx";
import { BlockLegs, PagedTransactions } from "../components/BlockParts.tsx";
import { Chip } from "../components/Chip.tsx";
import { CopyButton, HashLink } from "../components/HashLink.tsx";
import { Icon } from "../components/Icon.tsx";
import { bytesOf, units } from "../format.ts";
import { useInFlight } from "../stats.ts";
import { useFollowing, useStatus } from "../useStatus.ts";
import { VERIFY_MODULE_URL, useModuleSize } from "../verify/module-size.ts";
import { VerifyPanel } from "../verify/VerifyPanel.tsx";
import { HowFinal, Tiles, timesOf } from "./BlockFinal.tsx";
import { pinsAt } from "../pins.ts";
import { Info } from "../components/Info.tsx";
import { LegsPrivacy } from "./LegParts.tsx";
import { ProofCard } from "./BlockProof.tsx";
import { Bad, CantonPanel, EvmSide, Good } from "./BlockSides.tsx";

/** A block's neighbours: the one before it, and the one after it when the chain has one. */
function Neighbours({ b, st }: { b: ApiBlock; st: ApiStatus | undefined }) {
  const newest = Math.max(st?.final?.number ?? -1, st?.proving?.number ?? -1, b.status === "genesis" ? -1 : b.number);
  const prev = b.number > 0, next = b.number < newest;
  return (
    <nav className="pn" aria-label="Neighbouring blocks">
      {prev && <Link to={`/block/${b.number - 1}`} aria-label={`Previous block, ${b.number - 1}`}><Icon name="prev" size={13} /> {b.number - 1}</Link>}
      {next && <Link className="pn-next" to={`/block/${b.number + 1}`} aria-label={`Next block, ${b.number + 1}`}>{b.number + 1} <Icon name="next" size={13} /></Link>}
    </nav>
  );
}

function What({ row }: { row: BlockRow }) {
  if (row.transfer && row.success === false) return <>Tried to send <b>{units(row.transfer.value, row.transfer.decimals)} {row.transfer.symbol}</b> to <HashLink value={row.transfer.to} to={`/address/${row.transfer.to}`} />. <span className="muted">Reverted, nothing moved.</span></>;
  if (row.transfer) return <>Sent <b>{units(row.transfer.value, row.transfer.decimals)} {row.transfer.symbol}</b> to <HashLink value={row.transfer.to} to={`/address/${row.transfer.to}`} /></>;
  return row.to === null ? <>Created a contract</> : <span className="muted">—</span>;
}

function Result({ success }: { success: boolean | null }) {
  return success === null ? <span className="muted">Not known</span> : success ? <Good>Success</Good> : <Bad>Failed (reverted)</Bad>;
}

function Transactions({ rows }: { rows: BlockRow[] }) {
  return (
    <section className="card" aria-labelledby="txs-h">
      <div className="sec-h"><h3 id="txs-h">Transactions</h3><span className="muted small">{rows.length}</span></div>
      {rows.length ? (
        <div className="scroll">
          <table className="tbl txs">
            <thead><tr><th>Hash</th><th>From</th><th>To</th><th>What it did</th><th>Result</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.hash}>
                  <td className="c-hash"><HashLink value={r.hash} to={`/tx/${r.hash}`} plain /></td>
                  <td className="c-from"><HashLink value={r.from} to={`/address/${r.from}`} plain /></td>
                  <td className="c-to">{r.to ? <><HashLink value={r.to} to={`/${r.transfer ? "token" : "address"}/${r.to}`} plain />{r.transfer && <span className="tag">{r.transfer.symbol}</span>}</> : <span className="muted">none</span>}</td>
                  <td className="c-did"><What row={r} /></td>
                  <td className="c-res"><Result success={r.success} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="muted">No transactions in this block.</p>}
    </section>
  );
}

/** The three parts of the record that Verify checks, as the record holds them, to copy. */
function RecordData({ c }: { c: CantonSide }) {
  const parts = [["proof", c.proofHex], ["header", c.headerHex], ["transactions", c.txsHex]] as const;
  return (
    <section className="card rec" aria-label="The record's data">
      <div className="rec-row">
        <span className="rec-k">The record's data</span><Info about="the record's data">What Verify checks, as the record holds it, to copy.</Info>
        <span className="grow" />
        {parts.map(([name, hex]) => <span key={name} className="rd mono">{`${name} ${bytesOf(hex)} `}<CopyButton value={hex} label={`Copy the ${name}`} /></span>)}
      </div>
    </section>
  );
}

/** The Verify card. It checks the block record's proof, header and transactions against this explorer's pins, and is greyed while the block has no record. It waits for the pins, which come with the status answer. */
function Verify({ b, st }: { b: ApiBlock; st: ApiStatus | undefined }) {
  const moduleSize = useModuleSize(VERIFY_MODULE_URL);
  if (!st) return null;
  const record = b.canton && { proofHex: b.canton.proofHex, headerHex: b.canton.headerHex, txsHex: b.canton.txsHex };
  return <VerifyPanel block={record} blockHash={b.hash} pins={pinsAt(st.pins, b.number)} proving={b.status === "proving"} moduleUrl={VERIFY_MODULE_URL} moduleSize={moduleSize} />;
}

export function Block() {
  const { id = "" } = useParams();
  const st = useStatus().data;
  const q = useFollowing(["block", id], () => getBlock(id), (b) => b.status === "final" || (b.status === "genesis" && b.genesisReferenced === true));
  const final = q.data?.status === "final";
  const detail = useQuery({ queryKey: ["block-detail", id, q.data?.status], queryFn: () => getBlockDetail(id), enabled: final, retry: false, staleTime: 30_000 });
  // A block still being proven has no journal row to read: the producer's times are those of its in-flight attempt.
  const flight = useInFlight(false, q.data?.status === "proving");
  const wait = unready(q, "Reading the block…");
  if (wait) return wait;
  const b = q.data!;
  const proving = b.status === "proving";
  const src = proving ? flight : detail;
  const lifecycle = proving ? flight.data?.attempts.find((a) => a.number === b.number) : detail.data?.lifecycle;
  const times = timesOf({ proofBytes: b.canton?.proofBytes ?? null, lifecycle, recordTime: b.canton?.recordTime ?? null, reading: (final || proving) && src.isPending && !src.isError, failed: (final || proving) && src.isError, final });
  return (
    <>
      <nav className="crumbs" aria-label="Where this is"><Link to="/blocks">Blocks</Link> / Block {b.number}</nav>
      <div className="ptitle">
        <h1>Block <span className="num">#{b.number}</span></h1>
        {final ? <span className="chip chip-final"><i className="dot" />Final on Canton</span> : <Chip status={b.status} />}
        <span className="grow" />
        <Neighbours b={b} st={st} />
      </div>
      {b.canton && !b.canton.hashesMatch && (
        <div className="alert bad-alert" role="alert">
          <Icon name="warn" size={15} />
          <div><b>The hashes do not match.</b> reth's hash for this block, the hash in its block record and the hash of the record's header are not all the same. The explorer's status is red until this is explained.</div>
        </div>
      )}
      {b.status !== "genesis" && <Tiles txCount={b.txCount} gasUsed={b.gasUsed} times={times} unindexed={b.status === "unindexed"} />}
      <div className="sides"><EvmSide b={b} st={st} /><CantonPanel b={b} st={st} /></div>
      {b.status !== "genesis" && (
        <>
          <HowFinal times={times} final={b.canton !== null} unindexed={b.status === "unindexed"} />
          {b.canton && <ProofCard c={b.canton} pins={st?.pins} block={b.number}><Verify b={b} st={st} /></ProofCard>}
          {!b.canton && <Verify b={b} st={st} />}
          <LegsPrivacy />
          {final ? (st && <PagedTransactions id={String(b.number)} total={b.txCount} coin={st.coin} chain={st.chainName} />) : <Transactions rows={b.transactions} />}
          {final && <BlockLegs key={b.number} id={String(b.number)} />}
          {b.canton && <RecordData c={b.canton} />}
        </>
      )}
    </>
  );
}

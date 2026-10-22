import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { blocksCsvPath, getBlock, getBlockPage, type ApiStatus, type BlockFilter, type BlockListItem } from "../api.ts";
import { ErrorCard, LoadingCard } from "../components/Cards.tsx";
import { Chip } from "../components/Chip.tsx";
import { HashLink } from "../components/HashLink.tsx";
import { NumberedPager, useNumbered } from "../components/Numbered.tsx";
import { Pager, usePaged } from "../components/Pager.tsx";
import { count, duration, span } from "../format.ts";
import { listPoll, useInFlight } from "../stats.ts";
import { useLive } from "../useLive.ts";
import { POLL_MS, useNow, useStatus } from "../useStatus.ts";

const PER = 25;
/** A proof that took longer than this is flagged on the list. */
const SLOW_PROOF_SECONDS = 30;
const share = (gasUsed: number, gasLimit: number) => (gasLimit > 0 ? (gasUsed / gasLimit) * 100 : 0);
const FILTERS: { id: BlockFilter; label: string }[] = [{ id: "all", label: "All" }, { id: "transactions", label: "With transactions" }, { id: "empty", label: "Empty" }];

function Gas({ used, limit }: { used: number; limit: number }) {
  const pct = share(used, limit);
  return <>{count(used)} <span className="muted small">{pct.toFixed(1)}%</span><span className="gasbar" aria-hidden="true"><i style={{ width: `${Math.min(100, pct)}%` }} /></span></>;
}

/** The genesis has no record. Block 1's record names it as parent only when the genesis page's own check shows that to hold. */
function GenesisCell() {
  const g = useQuery({ queryKey: ["block", "0"], queryFn: () => getBlock("0"), retry: false, staleTime: 30_000 });
  return <td className="muted">no record{g.data?.genesisReferenced === true ? "; block 1's record names it as parent" : ""}</td>;
}

function Row({ b, now }: { b: BlockListItem; now: number }) {
  if (b.number === 0) {
    return (
      <tr>
        <td><Link className="num" to="/block/0">0</Link></td>
        <td>genesis</td><td className="r">0</td><td className="r mono">0</td>
        <td className="r muted">—</td><td className="r muted">—</td>
        <GenesisCell />
        <td><Chip status="genesis" /></td>
      </tr>
    );
  }
  return (
    <tr>
      <td><Link className="num" to={`/block/${b.number}`}>{b.number}</Link></td>
      <td title={new Date(b.timestamp * 1000).toISOString()}>{duration(now - b.timestamp * 1000)} ago</td>
      <td className="r">{b.txCount}</td>
      <td className="r mono"><Gas used={b.gasUsed} limit={b.gasLimit} /></td>
      <td className="r">{b.proofSeconds === null ? <span className="muted">—</span> : <>{span(b.proofSeconds)}{b.proofSeconds > SLOW_PROOF_SECONDS && <span className="tag"> slow proof</span>}</>}</td>
      <td className="r">{b.finalSeconds === null ? <span className="muted">—</span> : span(b.finalSeconds)}</td>
      <td>{b.updateId ? <HashLink value={b.updateId} kind="update" to={`/canton/${b.updateId}`} /> : <span className="muted">no record</span>}</td>
      <td><Chip status="final" /></td>
    </tr>
  );
}

/** The block being proven, which the list does not hold yet: the status names it, its page gives its transactions and gas, and the producer's log how long its proof has run. */
function ProvingRow({ proving, now, live }: { proving: NonNullable<ApiStatus["proving"]>; now: number; live: boolean }) {
  const block = useQuery({ queryKey: ["block", String(proving.number)], queryFn: () => getBlock(String(proving.number)), refetchInterval: POLL_MS });
  const attempt = useInFlight(live).data?.attempts.find((a) => a.number === proving.number);
  const started = attempt?.proofStartedAt ? Date.parse(attempt.proofStartedAt) : null;
  const ended = attempt?.proofEndedAt ? Date.parse(attempt.proofEndedAt) : null;
  const b = block.data;
  return (
    <tr className="row-proving">
      <td><Link className="num" to={`/block/${proving.number}`}>{proving.number}</Link></td>
      <td>cut {duration(now - proving.timestamp * 1000)} ago</td>
      <td className="r">{b ? b.txCount : attempt?.txCount ?? "—"}</td>
      <td className="r mono">{b ? <Gas used={b.gasUsed} limit={b.gasLimit} /> : "—"}</td>
      <td className="r amber">{started === null ? "—" : ended !== null ? span(Math.max(0, ended - started) / 1000) : `${(Math.max(0, now - started) / 1000).toFixed(1)} s so far`}</td>
      <td className="r muted">—</td>
      <td className="muted">not on Canton yet</td>
      <td><Chip status="proving" /></td>
    </tr>
  );
}

interface View { items: BlockListItem[] | undefined; error: Error | null; first: boolean }

function Table({ view, st, pager, now, live }: { view: View; st: ApiStatus | undefined; pager: React.ReactNode; now: number; live: boolean }) {
  const { items } = view;
  if (view.error && !items) return <ErrorCard message={view.error.message} retrying />;
  if (!items) return <LoadingCard>Reading the blocks…</LoadingCard>;
  const proving = view.first && st?.proving && st.proving.number > (items[0]?.number ?? -1) ? st.proving : null;
  const top = proving?.number ?? items[0]?.number;
  return (
    <section className="card" aria-label="Blocks">
      <div className="list-h"><span className="muted">{top !== undefined ? `Showing blocks ${top} to ${items[items.length - 1]?.number ?? top}` : "No blocks yet."}</span>{pager}</div>
      <div className="scroll">
        <table className="tbl">
          <thead><tr><th>Block</th><th>Age</th><th className="r">Transactions</th><th className="r">Gas used</th><th className="r">Proof time</th><th className="r">Time to final</th><th>Canton update</th><th>Stage</th></tr></thead>
          <tbody>
            {proving && <ProvingRow proving={proving} now={now} live={live} />}
            {items.map((b) => <Row key={b.number} b={b} now={now} />)}
          </tbody>
        </table>
      </div>
      <p className="muted small">Ages are counted to {new Date(now).toISOString().slice(11, 19)} UTC. Each final block is one Canton transaction; its update id opens the Canton record.</p>
    </section>
  );
}

/** Every final block: the blocks run in one count, so any page can be asked for and the last page is known. */
function AllBlocks({ st, now, live }: { st: ApiStatus | undefined; now: number; live: boolean }) {
  const total = st?.final ? st.final.number + 1 : 0;
  const p = useNumbered(["blocks", "page"], total, PER, (before) => getBlockPage(before, PER), (n, per) => String(total - (n - 1) * per), listPoll(live));
  return <Table view={{ items: p.data?.items, error: p.error, first: p.page === 1 }} st={st} now={now} live={live} pager={<NumberedPager p={p} label="Pages of blocks" always />} />;
}

/** The blocks of a filter: their numbers have gaps, so the pages are walked by the server's cursor. */
function FilteredBlocks({ filter, st, now, live }: { filter: BlockFilter; st: ApiStatus | undefined; now: number; live: boolean }) {
  const p = usePaged(["blocks", "page", filter], (before) => getBlockPage(before, PER, filter), listPoll(live));
  return <Table view={{ items: p.data?.items, error: p.error, first: false }} st={st} now={now} live={live} pager={<Pager p={p} label="Pages of blocks" />} />;
}

function Title({ st }: { st: ApiStatus | undefined }) {
  if (!st?.final) return null;
  const proving = st.proving ? 1 : 0, total = (st.proving?.number ?? st.final.number) + 1;
  return <span className="muted">{total} blocks · {st.final.number} final on Canton{proving ? ` · ${proving} being proven` : ""}</span>;
}

/** Every final block, newest first, a page at a time. */
export function Blocks() {
  const live = useLive(["blocks"]);
  const now = useNow();
  const st = useStatus().data;
  const [filter, setFilter] = useState<BlockFilter>("all");
  return (
    <>
      <div className="ptitle">
        <h1>Blocks</h1>
        <Title st={st} />
        <span className="grow" />
        <div className="seg" role="group" aria-label="Show blocks">
          {FILTERS.map((f) => <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>)}
        </div>
        <a className="csv" href={blocksCsvPath(filter)} download="blocks.csv">CSV</a>
      </div>
      <div className="note">
        Blocks are cut on demand: when transactions wait and the last block is final. The producer's setting decides whether empty blocks are also made.{" "}
        <strong>Proof time</strong> is ZisK's time for the block. <strong>Time to final</strong>, for a block, runs from the producer cutting it to Canton's record time.
      </div>
      {filter === "all" ? <AllBlocks st={st} now={now} live={live} /> : <FilteredBlocks key={filter} filter={filter} st={st} now={now} live={live} />}
    </>
  );
}

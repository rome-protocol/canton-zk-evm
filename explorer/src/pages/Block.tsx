import { Link, useParams } from "react-router-dom";
import { getBlock, type ApiBlock, type ApiStatus, type BlockRow, type CantonSide, type Fact } from "../api.ts";
import { unready } from "../components/Cards.tsx";
import { Chip } from "../components/Chip.tsx";
import { CopyButton, HashLink } from "../components/HashLink.tsx";
import { Icon } from "../components/Icon.tsx";
import { Item, Kv } from "../components/Kv.tsx";
import { LEGS_THIS_BLOCK } from "../copy.ts";
import { bytesOf, count, gwei, seconds, short, units, utc, utcDate, utcMs } from "../format.ts";
import { useFollowing, useStatus } from "../useStatus.ts";
import { VERIFY_MODULE_URL, useModuleSize } from "../verify/module-size.ts";
import { VerifyPanel } from "../verify/VerifyPanel.tsx";

const PROOF_LENGTH = "This proof is not 1,344 bytes, so its facts cannot be read.";

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

function EvmSide({ b }: { b: ApiBlock }) {
  return (
    <section className="card side evm" aria-labelledby="evm-h">
      <div className="side-h"><span className="side-l" id="evm-h">On the EVM</span><span className="muted small">from reth</span></div>
      <Kv>
        <Item label="Hash"><HashLink value={b.hash} long /></Item>
        <Item label="Parent">
          {b.number > 0 ? <><Link className="num" to={`/block/${b.number - 1}`}>Block {b.number - 1}</Link> · <HashLink value={b.parentHash} to={`/block/${b.parentHash}`} /></> : "none"}
        </Item>
        <Item label="Time"><span className="mono">{utc(b.timestamp * 1000)}</span> <span className="muted">· {utcDate(b.timestamp * 1000)}</span></Item>
        <Item label="Transactions">{b.txCount}</Item>
        <Item label="Gas used"><span className="mono">{count(b.gasUsed)}</span> <span className="muted">of {count(b.gasLimit)}</span></Item>
        <Item label="Base fee">{b.baseFee === null ? "none" : gwei(b.baseFee)}</Item>
        <Item label="Fee recipient"><HashLink value={b.miner} to={`/address/${b.miner}`} /></Item>
        <Item label="State root"><HashLink value={b.stateRoot} /></Item>
      </Kv>
    </section>
  );
}

const Good = ({ children }: { children: string }) => <span className="fact-ok"><Icon name="check" size={13} />{children}</span>;
const Bad = ({ children }: { children: React.ReactNode }) => <span className="fact-bad"><Icon name="cross" size={13} />{children}</span>;

/** One fact read from the proof, with the value that was read and whether it matches. The value is always shown. */
function FactRows({ label, fact, match, mismatch }: { label: string; fact: Fact; match: string; mismatch: React.ReactNode }) {
  return (
    <>
      <dt className="f-k">{label}</dt>
      <dd className="f-v">{fact.value === null ? <span className="muted">none in its public values</span> : <HashLink value={fact.value} />}</dd>
      <dd className="f-s">{fact.ok ? <Good>{match}</Good> : <Bad>{mismatch}</Bad>}</dd>
    </>
  );
}

function ProofFacts({ c, pins }: { c: CantonSide; pins: ApiStatus["pins"] | undefined }) {
  if (!c.proof) return <div className="alert bad-alert flat facts-gap"><Icon name="cross" size={15} /><div>{PROOF_LENGTH}</div></div>;
  const { programVK, rootC, blockHash } = c.proof;
  const pin = (v: string | undefined) => <>does not match this explorer's pin{v && <> <span className="mono">{short(v)}</span></>}</>;
  const red = !(programVK.ok && rootC.ok && blockHash.ok);
  return (
    <>
      <dl className={`facts${red ? " facts-bad" : ""}`} role="group" aria-label="Facts read from the proof">
        <FactRows label="Program key" fact={programVK} match="ours" mismatch={pin(pins?.programVK)} />
        <FactRows label="ZisK release" fact={rootC} match="ZisK 1.3.1" mismatch={pin(pins?.rootC)} />
        <FactRows label="Block hash" fact={blockHash} match="this block" mismatch="not this block's hash" />
      </dl>
      <div className="facts-note small muted">
        Read from the proof's own bytes and compared with this explorer's pins{pins?.file && <>, from <span className="mono">{pins.file}</span></>}. Reading a value is not verifying it: Canton's confirmers verified the proof when the block committed.
      </div>
      {red && <div className="facts-note small muted">The status word stays Final: Canton's confirmers checked the proof against their own pins when the block committed. A red fact means the proof differs from the pins this explorer was given.</div>}
    </>
  );
}

function Record({ b, c, st }: { b: ApiBlock; c: CantonSide; st: ApiStatus | undefined }) {
  const signers = st?.signers;
  return (
    <>
      <Kv>
        <Item label="Canton update"><HashLink value={c.updateId} kind="update" /></Item>
        <Item label="Committed"><span className="mono">{utcMs(c.recordTime)}</span> <span className="muted">· {seconds(b.timestamp, c.recordTime)} after the block was made</span></Item>
        <Item label="Record"><span className="mono">{c.template}</span></Item>
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
        <Item label="Proof"><span className="mono">{count(c.proofBytes)}</span> bytes</Item>
      </Kv>
      <ProofFacts c={c} pins={st?.pins} />
    </>
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

function CantonPanel({ b, st }: { b: ApiBlock; st: ApiStatus | undefined }) {
  const pending = b.status === "proving";
  return (
    <section className={`card side canton${pending ? " pending" : ""}`} aria-labelledby="canton-h">
      <div className="side-h"><span className="side-l" id="canton-h">On Canton</span>{b.canton && <span className="muted small">the block record, read as the reader party</span>}</div>
      {b.canton ? <Record b={b} c={b.canton} st={st} />
        : b.status === "genesis" ? <GenesisSide b={b} st={st} />
        : <div className="empty-side"><b>Not on Canton yet.</b><p>reth has made this block and it is being proven. It becomes final when Canton commits it. It can still disappear if Canton refuses it.</p></div>}
    </section>
  );
}

const STEPS: { text: React.ReactNode; later: string }[] = [
  { text: "reth made the block.", later: "" },
  { text: "ZisK proved it.", later: "ZisK proves it." },
  { text: <>It went to Canton as one transaction, <span className="mono">ZkChain.Advance</span>.</>, later: "" },
  { text: "The sidecars of both confirming participants checked the proof (the check the Verify button runs below).", later: "The sidecars of both confirming participants checked the proof." },
  { text: "The commit created this block record, and any Daml legs settled in the same transaction.", later: "" },
];

/** The same five steps for every block. Only two times are shown, the two that are measured: the block's own time and Canton's record time. */
function HowItHappened({ b }: { b: ApiBlock }) {
  const done = b.canton !== null;
  const time = (i: number) => (i === 0 ? utc(b.timestamp * 1000) : i === 4 && b.canton ? utcMs(b.canton.recordTime) : "");
  return (
    <section className="card" aria-labelledby="how-h">
      <div className="sec-h"><h3 id="how-h">How it happened</h3><span className="muted small">The same five steps for every block. Only two times are shown, the two that are measured: the block's own time at step 1 and Canton's record time at step 5.</span></div>
      <ol className="steps">
        {STEPS.map((s, i) => {
          const happened = i === 0 || done;
          return (
            <li key={i} className={happened ? "done" : "todo"}>
              <span className="st-t mono">{time(i)}</span>
              <span className="st-n">{i + 1}</span>
              <span className="st-x">{happened ? s.text : s.later ? <>{s.later}</> : s.text}{!happened && <span className="pending-t">Not on Canton yet</span>}</span>
            </li>
          );
        })}
      </ol>
    </section>
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
                  <td className="c-hash"><HashLink value={r.hash} to={`/tx/${r.hash}`} /></td>
                  <td className="c-from"><HashLink value={r.from} to={`/address/${r.from}`} /></td>
                  <td className="c-to">{r.to ? <><HashLink value={r.to} to={`/${r.transfer ? "token" : "address"}/${r.to}`} />{r.transfer && <span className="tag">{r.transfer.symbol}</span>}</> : <span className="muted">none</span>}</td>
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
        <span className="rec-k">The record's data</span><span className="muted small">What Verify checks, as the record holds it, to copy.</span>
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
  return <VerifyPanel block={record} blockHash={b.hash} pins={st.pins} proving={b.status === "proving"} moduleUrl={VERIFY_MODULE_URL} moduleSize={moduleSize} />;
}

export function Block() {
  const { id = "" } = useParams();
  const st = useStatus().data;
  const q = useFollowing(["block", id], () => getBlock(id), (b) => b.status === "final" || (b.status === "genesis" && b.genesisReferenced === true));
  const wait = unready(q, "Reading the block…");
  if (wait) return wait;
  const b = q.data!;
  return (
    <>
      <div className="ptitle">
        <h1>Block <span className="num">{b.number}</span></h1>
        <Chip status={b.status} />
        <span className="grow" />
        <Neighbours b={b} st={st} />
      </div>
      {b.canton && !b.canton.hashesMatch && (
        <div className="alert bad-alert" role="alert">
          <Icon name="warn" size={15} />
          <div><b>The hashes do not match.</b> reth's hash for this block, the hash in its block record and the hash of the record's header are not all the same. The explorer's status is red until this is explained.</div>
        </div>
      )}
      <div className="sides"><EvmSide b={b} /><CantonPanel b={b} st={st} /></div>
      {b.status !== "genesis" && (
        <>
          <div className="legs"><Icon name="lock" size={14} /><span>{LEGS_THIS_BLOCK}</span></div>
          <HowItHappened b={b} />
          <Transactions rows={b.transactions} />
          <Verify b={b} st={st} />
          {b.canton && <RecordData c={b.canton} />}
        </>
      )}
    </>
  );
}

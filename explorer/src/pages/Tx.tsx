import { useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getBlockSummary, getTx, getTxDetail, getTxTransfers, type BlockSummary, type ApiStatus, type ApiTx, type ApiTxDetail, type ApiTxSeen, type ApiTxUnseen } from "../api.ts";
import { AddressCell, addressPath } from "../components/AddressCell.tsx";
import { Amount } from "../components/Amount.tsx";
import { usePaged } from "../components/Pager.tsx";
import { unready } from "../components/Cards.tsx";
import { Chip } from "../components/Chip.tsx";
import { HashLink } from "../components/HashLink.tsx";
import { Icon } from "../components/Icon.tsx";
import { Item, Kv } from "../components/Kv.tsx";
import { ago } from "../block-times.ts";
import { count, dateTime, exact, feeOf, gwei, short } from "../format.ts";
import { labelName, useLabels } from "../labels.ts";
import { useFollowing, useStatus } from "../useStatus.ts";
import { InputData } from "./TxDecoded.tsx";
import { TxFinal, type BlockRead } from "./TxFinal.tsx";
import { CantonRecord, ProofSide } from "./TxSides.tsx";
import { LogsTab } from "./TxLogs.tsx";
import { InternalTab } from "./TxCalls.tsx";
import { Panel, Tabs, type TabId, type TabSpec } from "./TxTabs.tsx";
import { RawTab, TreeTab } from "./TxTrace.tsx";
import { AmountCell, TransfersCard } from "./TxTransfers.tsx";
import "./tx.css";

const TYPES: Record<number, string> = { 0: "legacy", 1: "EIP-2930", 2: "EIP-1559", 3: "EIP-4844", 4: "EIP-7702" };
const CLIP = 74;

const Good = ({ children }: { children: string }) => <span className="fact-ok"><Icon name="check" size={13} />{children}</span>;
const Bad = ({ children }: { children: string }) => <span className="fact-bad"><Icon name="cross" size={13} />{children}</span>;

type Coin = { symbol: string; decimals: number };

/** A transaction that is not final yet says so, says where it is, and says that the page looks again. Only a transaction page reached by its hash can say Waiting. */
function NotFinal({ t }: { t: ApiTxSeen }) {
  // Final on Canton, only not written down by the explorer yet: it must not say "not final".
  if (t.status === "unindexed") {
    return (
      <div className="alert wait-alert" role="status">
        <Icon name="info" size={15} />
        <div><b>Final on Canton, not indexed yet.</b> Canton holds this transaction's block; the explorer has not read its record, so the update id is not shown. This page looks again every 2 s.</div>
      </div>
    );
  }
  const where = t.status === "waiting" ? "It is in reth's pool, and no block holds it yet." : "Its block is being proven.";
  return (
    <div className="alert wait-alert" role="status">
      <Icon name="info" size={15} />
      <div><b>Not final yet.</b> It becomes final when its block is proven and committed on Canton. {where} This page looks again every 2 s.</div>
    </div>
  );
}

/** An amount in the chain's coin. Until the server has named the coin there is no amount to show. */
const InCoin = ({ raw, coin }: { raw: string; coin: Coin | undefined }) =>
  coin ? <Amount raw={raw} decimals={coin.decimals} symbol={coin.symbol} /> : <span className="muted">…</span>;

/** A fee in the chain's coin to ten decimals, cut and never rounded (the exact fee in the tooltip). */
const FeeIn = ({ raw, coin }: { raw: string; coin: Coin | undefined }) =>
  coin ? <span title={`${exact(raw, coin.decimals)} ${coin.symbol}`}><span className="num">{feeOf(raw, coin.decimals)}</span> <bdi>{coin.symbol}</bdi></span> : <span className="muted">…</span>;

/** What the transaction's ERC-20 transfer did. A reverted one moved nothing, and says so. */
function TransferItem({ t, waiting }: { t: ApiTxSeen; waiting: boolean }) {
  const tr = t.transfer;
  if (!tr) return null;
  const amount = <b><Amount raw={tr.value} decimals={tr.decimals} symbol={tr.symbol} /></b>;
  const to = <HashLink value={tr.to} to={`/address/${tr.to}`} />;
  const from = <HashLink value={t.from} to={`/address/${t.from}`} />;
  if (waiting) return <Item label="Token to move">{amount} to {to}</Item>;
  if (t.success === false) return <Item label="Token transfer">Tried to move {amount} from {from} to {to}. <span className="muted">The transaction reverted, so nothing moved.</span></Item>;
  return <Item label="Token moved">{amount} from {from} to {to}</Item>;
}

/** How many transfers the Overview row lists; the card below lists them all, a page at a time. */
const OVERVIEW_TRANSFERS = 5;

/** The transfers of a final transaction, by name with their amounts, as the Overview of the screen lists them. Where none can be read, the one transfer /api/tx decoded, if any. */
function FinalTransfersItem({ t }: { t: ApiTxSeen }) {
  const p = usePaged(["tx-transfers", t.hash], (after) => getTxTransfers(t.hash, after));
  const items = p.data?.items ?? [];
  // The same addresses as the card below asks for, so the names are one request.
  const labels = useLabels(items.flatMap((x) => [x.from, x.to, x.token]));
  if (items.length === 0 || p.data?.derived === false) return <TransferItem t={t} waiting={false} />;
  const shown = items.slice(0, OVERVIEW_TRANSFERS);
  const rest = items.length - shown.length;
  return (
    <Item label="Token transfers">
      <div className="xfer-list">
        {shown.map((x) => (
          <div key={`${x.logIndex}-${x.batchIndex}`} className="xfer-line">
            <AddressCell address={x.from} label={labels.get(x.from)} /> <span className="muted" aria-hidden="true">→</span> <AddressCell address={x.to} label={labels.get(x.to)} />{" "}
            <AmountCell x={x} label={labels.get(x.token)} /> <AddressCell address={x.token} label={labels.get(x.token)} to={`/token/${x.token}`} />
          </div>
        ))}
        {(rest > 0 || p.hasNext) && <div className="muted small">{rest > 0 && !p.hasNext ? `and ${rest} more` : "and more"} in the Token transfers list below</div>}
      </div>
    </Item>
  );
}

function TransfersItem({ t, waiting }: { t: ApiTxSeen; waiting: boolean }) {
  return t.status === "final" ? <FinalTransfersItem t={t} /> : <TransferItem t={t} waiting={waiting} />;
}

function BlockItem({ t, head }: { t: ApiTxSeen; head: number | undefined }) {
  if (!t.block) return <span className="muted">None yet</span>;
  const link = <Link className="num" to={`/block/${t.block.number}`}>{t.block.number}</Link>;
  const tail = head !== undefined && <span className="muted"> · final head is {head}</span>;
  return t.block.updateId ? <>{link}, final on Canton in update <HashLink value={t.block.updateId} kind="update" />{tail}</> : <>{link}, {t.status === "unindexed" ? "final on Canton, not indexed yet" : "not on Canton yet"}{tail}</>;
}

/** Every call the transaction made, as the trace counts them (the Internal calls tab lists every one of them). A block the explorer has not derived yet says so, and gives no count. */
function CallsItem({ t, detail }: { t: ApiTxSeen; detail: Detail }) {
  if (t.status !== "final") return null;
  const d = detail.data;
  return (
    <Item label="Calls made">
      {d ? (d.derived && d.callCount !== null ? <span className="num">{d.callCount}</span> : <span className="muted">not derived yet</span>)
        : detail.failed ? <span className="muted">cannot be read right now</span> : <span className="muted">reading…</span>}
    </Item>
  );
}

type Detail = { data: ApiTxDetail | undefined; failed: boolean };

/** A fact that comes from the transaction's block: shown when the block is read, and honest while it is not. */
function FromBlock({ read, children }: { read: BlockRead; children: ReactNode }) {
  return read === "read" ? <>{children}</> : <span className="muted">{read === "reading" ? "reading…" : "cannot be read right now"}</span>;
}

const WEI = /^\d+$/;
/** The base fee burnt: the block's base fee times the gas the transaction used. */
const burnt = (baseFee: string | null, gasUsed: number | null) => (baseFee !== null && WEI.test(baseFee) && gasUsed !== null ? (BigInt(baseFee) * BigInt(gasUsed)).toString() : null);

/** The block's time, shown after the block. It is "reading" while the block is being read, and has no row for a transaction in no block. */
function TimeItem({ t, block, read }: { t: ApiTxSeen; block: BlockSummary | undefined; read: BlockRead }) {
  if (!t.block) return null;
  const ms = block ? block.timestamp * 1000 : null;
  return <Item label="Time"><FromBlock read={read}>{ms !== null && <><span className="mono">{dateTime(ms)}</span> <span className="muted">· {ago(new Date(ms).toISOString())}</span></>}</FromBlock></Item>;
}

/** The price and the fee caps and the burnt fees: what the block and the detail route add after the gas. Each is left out when it cannot be known, and "reading" while it is being read. */
function FeeFacts({ t, coin, block, detail }: { t: ApiTxSeen; coin: Coin | undefined; block: BlockSummary | undefined; detail: Detail }) {
  if (!t.block) return null;
  const base = block?.baseFee ?? null, d = detail.data;
  const burn = burnt(base, t.gasUsed);
  const capsKnown = d && (d.maxFeePerGas !== null || d.maxPriorityFeePerGas !== null);
  const caps = !d ? (detail.failed ? <span className="muted">cannot be read right now</span> : t.status === "final" ? <span className="muted">reading…</span> : null) : null;
  return (
    <>
      {(base !== null || capsKnown || caps) && (
        <Item label="Fees">
          {caps ?? <>
            {base !== null && <>Base <span className="num">{gwei(base)}</span></>}
            {d?.maxFeePerGas != null && <>{base !== null && <span className="muted"> · </span>}Max <span className="num">{gwei(d.maxFeePerGas)}</span></>}
            {d?.maxPriorityFeePerGas != null && <><span className="muted"> · </span>Max priority <span className="num">{gwei(d.maxPriorityFeePerGas)}</span></>}
          </>}
        </Item>
      )}
      {burn !== null && <Item label="Burnt fees"><FeeIn raw={burn} coin={coin} /></Item>}
    </>
  );
}

function Facts({ t, coin, detail, block, read, head }: { t: ApiTxSeen; coin: Coin | undefined; detail: Detail; block: BlockSummary | undefined; read: BlockRead; head: number | undefined }) {
  const waiting = t.status === "waiting";
  // A named contract or token is shown by its name with a check, and its address still in full; one the index holds no name of is the address, with the server's own word for a token.
  const toLabel = useLabels([t.to]).get(t.to);
  const to = t.to && (labelName(toLabel)
    ? <span className="to-named"><AddressCell address={t.to} label={toLabel} /> <HashLink value={t.to} to={addressPath(t.to, toLabel)} full /></span>
    : <><HashLink value={t.to} to={`/${t.toToken ? "token" : "address"}/${t.to}`} full />{t.toToken && <span className="tag">{t.toToken}, a token</span>}</>);
  const index = detail.data?.index ?? null;
  const finalAt = block?.canton?.recordTime;
  return (
    <section className="card" aria-label="Transaction">
      <Kv wide>
        <Item label="Status">
          {waiting ? <span className="muted">Not run yet</span> : t.success === null ? <span className="muted">Not known</span> : t.success ? <Good>Success</Good> : <Bad>Failed (reverted)</Bad>}
        </Item>
        <Item label="Stage">
          {t.status === "final" ? <><Chip status="final" label="Final on Canton" />{finalAt && <span className="muted"> · final {ago(finalAt)} · nothing to confirm beyond final</span>}</> : <Chip status={t.status} />}
        </Item>
        <Item label="Block"><BlockItem t={t} head={t.status === "final" ? head : undefined} /></Item>
        <TimeItem t={t} block={block} read={read} />
        <Item label="From"><HashLink value={t.from} to={`/address/${t.from}`} full /></Item>
        <Item label="To">{to || <span className="muted">none, this transaction created a contract</span>}</Item>
        {t.created && <Item label="Created contract"><HashLink value={t.created} to={`/address/${t.created}`} full /></Item>}
        <TransfersItem t={t} waiting={waiting} />
        <Item label="Value"><InCoin raw={t.value} coin={coin} /></Item>
        <Item label="Transaction fee">
          {t.fee !== null ? <FeeIn raw={t.fee} coin={coin} /> : <span className="muted">Known once a block holds it</span>}
        </Item>
        {t.gasPrice !== null && <Item label="Gas price"><span className="num">{gwei(t.gasPrice)}</span></Item>}
        {t.gasUsed === null ? <Item label="Gas limit"><span className="num">{count(t.gas)}</span></Item>
          : <Item label="Gas used"><span className="num">{count(t.gasUsed)}</span> <span className="muted">of {count(t.gas)}{t.gas > 0 && ` (${((t.gasUsed / t.gas) * 100).toFixed(2)}%)`}</span></Item>}
        <FeeFacts t={t} coin={coin} block={block} detail={detail} />
        <CallsItem t={t} detail={detail} />
        <Item label="Nonce and position">
          <span className="num">{t.nonce}</span>
          {t.block && (index !== null ? <span className="muted"> · position {index} in block {t.block.number}</span>
            : t.status === "final" ? <span className="muted"> · {detail.failed ? "position cannot be read right now" : "reading the position…"}</span> : null)}
        </Item>
        <Item label="Type">{t.type} {TYPES[t.type] && <span className="muted">({TYPES[t.type]})</span>}</Item>
      </Kv>
    </section>
  );
}

function Input({ data }: { data: string }) {
  const [all, setAll] = useState(false);
  if (data === "0x") return <span className="muted">none</span>;
  const long = data.length > CLIP;
  return (
    <>
      <div className="mono small wrap clip">{all || !long ? data : `${data.slice(0, CLIP)}…`}</div>
      {long && <button type="button" className="more" onClick={() => setAll(!all)}>{all ? "Show less" : "Show all"} <Icon name={all ? "up" : "down"} size={12} /></button>}
    </>
  );
}

/** The input as it was sent, with its 4-byte method id, and its call by name when the contract called has an interface to read it with. */
const InputCard = ({ t }: { t: ApiTxSeen }) => <InputData to={t.to} input={t.input} raw={<Input data={t.input} />} />;

/** The stage in plain words. It is the first thing the page says. */
export function stageText(t: ApiTx): string {
  switch (t.state) {
    case "pending": return "Waiting to go into a block";
    case "proving": return "In a block that is being proven";
    case "unindexed": return t.block ? `Final on Canton in block ${t.block.number}, which the explorer has not indexed yet` : "Final on Canton, not indexed yet";
    case "final": return "Final on Canton";
    case "replaced": return "Replaced by another transaction with the same nonce";
    case "dropped": return `Dropped: ${t.reason ?? "no reason was given"}`;
  }
}

const settled = (t: ApiTx) => t.state === "final" || t.state === "replaced" || t.state === "dropped";

/**
 * A final transaction says so in the chip beside the title, and the page does not say it twice in sight. The live region stays in the page across
 * the change, so a screen reader hears a pending transaction become final: the words it holds then are only for the ear.
 */
function Stage({ t }: { t: ApiTx }) {
  return (
    <div className="stage-live" aria-live="polite">
      {t.state === "final" ? <span className="sr-only">This transaction is now final on Canton.</span> : <p className={`stage s-${t.state}`} data-state={t.state}>{stageText(t)}</p>}
    </div>
  );
}

/** A transaction that reth no longer holds: all that is known is who sent it, and its nonce. */
function Unseen({ t }: { t: ApiTxUnseen }) {
  return (
    <section className="card" aria-label="Transaction">
      <Kv wide>
        <Item label="From"><HashLink value={t.from} to={`/address/${t.from}`} full /></Item>
        <Item label="Nonce"><span className="num">{t.nonce}</span></Item>
        {t.reason && t.state !== "dropped" && <Item label="Note">{t.reason}</Item>}
      </Kv>
    </section>
  );
}

const Result = ({ t }: { t: ApiTx }) =>
  t.success === null ? null : t.success ? <Good>Success</Good> : <Bad>Failed</Bad>;

export function Tx() {
  const { hash = "" } = useParams();
  const st = useStatus().data;
  const coin = st?.coin;
  const q = useFollowing(["tx", hash], () => getTx(hash), settled);
  const t = q.data;
  const n = t?.block?.number;
  // The block holds the times, the proof and the record's facts; a transaction in no block has none to read.
  const blockQ = useQuery({ queryKey: ["block-summary", String(n)], queryFn: () => getBlockSummary(String(n)), enabled: n !== undefined, retry: false, staleTime: 5_000, refetchInterval: t && t.status !== "final" && n !== undefined ? 2000 : false });
  const detailQ = useQuery({ queryKey: ["tx-detail", hash], queryFn: () => getTxDetail(hash), enabled: t?.status === "final", retry: false, staleTime: 10_000 });
  const wait = unready(q, "Reading the transaction…");
  if (wait || !t) return wait;
  const read: BlockRead = n === undefined ? "none" : blockQ.isError ? "failed" : blockQ.data ? "read" : "reading";
  const detail = { data: detailQ.data, failed: detailQ.isError };
  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb"><Link to="/txs">Transactions</Link> / <span className="mono">{short(t.hash, 8, 6)}</span></nav>
      <div className="ptitle"><h1>Transaction</h1><Chip status={t.status} label={t.status === "final" ? "Final on Canton" : undefined} /><Result t={t} /></div>
      <div className="bighash"><HashLink value={t.hash} full /></div>
      <Stage t={t} />
      {t.value === null && <Unseen t={t} />}
      {t.value !== null && t.status !== "final" && <NotFinal t={t} />}
      {t.value !== null && <TxFinal t={t} block={blockQ.data} read={read} index={detail.data?.index ?? null} />}
      {t.value !== null && <Body t={t} coin={coin} detail={detail} block={blockQ.data} read={read} st={st} />}
    </>
  );
}

const TAB_IDS: TabId[] = ["overview", "logs", "internal", "tree", "raw"];

/** The facts, and for a transaction in a block the tabs: the overview, the logs, the internal calls, the call tree and the raw receipt. The tab is in the address. */
function Body({ t, coin, detail, block, read, st }: { t: ApiTxSeen; coin: Coin | undefined; detail: { data: ApiTxDetail | undefined; failed: boolean }; block: BlockSummary | undefined; read: BlockRead; st: ApiStatus | undefined }) {
  const [params, setParams] = useSearchParams();
  const final = t.status === "final";
  const tabs: TabSpec[] = t.status === "waiting" ? [] : [
    { id: "overview", label: "Overview" },
    { id: "logs", label: "Logs", count: t.logs.length },
    ...(final ? [
      { id: "internal" as const, label: "Internal calls", count: detail.data?.derived && detail.data.callCount !== null ? detail.data.callCount : null },
      { id: "tree" as const, label: "Call tree" },
      { id: "raw" as const, label: "Raw" },
    ] : []),
  ];
  const asked = params.get("tab") as TabId | null;
  const tab: TabId = asked && TAB_IDS.includes(asked) && tabs.some((x) => x.id === asked) ? asked : "overview";
  const pick = (id: TabId) => setParams((p) => { const n = new URLSearchParams(p); if (id === "overview") n.delete("tab"); else n.set("tab", id); return n; }, { replace: true });
  const overview = (
    <div className="tx-grid">
      <div className="tx-main"><Facts t={t} coin={coin} detail={detail} block={block} read={read} head={st?.final?.number} /></div>
      <aside className="tx-side"><CantonRecord t={t} block={block} read={read} /><ProofSide t={t} block={block} st={st} read={read} /></aside>
    </div>
  );
  // The transfers and the input are full-width cards under the facts and the side cards, as on the screen; on a phone they follow the Canton record and the proof.
  const below = (
    <>
      {final && <TransfersCard hash={t.hash} />}
      {t.status !== "waiting" && <InputCard t={t} />}
    </>
  );
  if (tabs.length === 0) return <>{overview}{below}</>;
  return (
    <>
      <Tabs tabs={tabs} current={tab} onPick={pick} />
      <Panel id={tab}>
        {tab === "overview" && <>{overview}{below}</>}
        {tab === "logs" && <LogsTab t={t} />}
        {tab === "internal" && <InternalTab t={t} coin={coin} callCount={detail.data?.derived ? detail.data.callCount : null} />}
        {tab === "tree" && <TreeTab hash={t.hash} coin={coin} />}
        {tab === "raw" && <RawTab hash={t.hash} />}
      </Panel>
    </>
  );
}

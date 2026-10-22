import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getBlock, getTx, getTxDetail, type ApiBlock, type ApiStatus, type ApiTx, type ApiTxDetail, type ApiTxSeen, type ApiTxUnseen } from "../api.ts";
import { Amount } from "../components/Amount.tsx";
import { unready } from "../components/Cards.tsx";
import { Chip } from "../components/Chip.tsx";
import { HashLink } from "../components/HashLink.tsx";
import { Icon } from "../components/Icon.tsx";
import { Item, Kv } from "../components/Kv.tsx";
import { count, gwei, short } from "../format.ts";
import { useFollowing, useStatus } from "../useStatus.ts";
import { TxFinal, type BlockRead } from "./TxFinal.tsx";
import { CantonRecord, ProofSide } from "./TxSides.tsx";
import { InternalTab, LogsTab, Panel, Tabs, type TabId, type TabSpec } from "./TxTabs.tsx";
import { RawTab, TreeTab } from "./TxTrace.tsx";
import { TransfersCard } from "./TxTransfers.tsx";
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

function BlockItem({ t }: { t: ApiTxSeen }) {
  if (!t.block) return <span className="muted">None yet</span>;
  const link = <Link className="num" to={`/block/${t.block.number}`}>{t.block.number}</Link>;
  return t.block.updateId ? <>{link}, final on Canton in update <HashLink value={t.block.updateId} kind="update" /></> : <>{link}, not on Canton yet</>;
}

/** The internal calls that moved value. A final transaction whose block the explorer has not derived yet says so, and gives no count. */
function CallsItem({ t, detail }: { t: ApiTxSeen; detail: { data: ApiTxDetail | undefined; failed: boolean } }) {
  if (t.status !== "final") return null;
  const d = detail.data;
  return (
    <Item label="Internal calls">
      {d ? (d.derived && d.callCount !== null ? <span className="mono">{d.callCount}</span> : <span className="muted">not derived yet</span>)
        : detail.failed ? <span className="muted">cannot be read right now</span> : <span className="muted">reading…</span>}
    </Item>
  );
}

function Facts({ t, coin, detail }: { t: ApiTxSeen; coin: Coin | undefined; detail: { data: ApiTxDetail | undefined; failed: boolean } }) {
  const waiting = t.status === "waiting";
  const to = t.to && <><HashLink value={t.to} to={`/${t.toToken ? "token" : "address"}/${t.to}`} full />{t.toToken && <span className="tag">{t.toToken}, a token</span>}</>;
  return (
    <section className="card" aria-label="Transaction">
      <Kv wide>
        <Item label="Result">
          {waiting ? <span className="muted">Not run yet</span> : t.success === null ? <span className="muted">Not known</span> : t.success ? <Good>Success</Good> : <Bad>Failed (reverted)</Bad>}
        </Item>
        <Item label="Block"><BlockItem t={t} /></Item>
        <Item label="From"><HashLink value={t.from} to={`/address/${t.from}`} full /></Item>
        <Item label="To">{to || <span className="muted">none, this transaction created a contract</span>}</Item>
        {t.created && <Item label="Created contract"><HashLink value={t.created} to={`/address/${t.created}`} full /></Item>}
        <TransferItem t={t} waiting={waiting} />
        <Item label="Value"><InCoin raw={t.value} coin={coin} /></Item>
        <Item label="Fee">
          {t.fee !== null && t.gasPrice !== null ? <><InCoin raw={t.fee} coin={coin} /> <span className="muted">at {gwei(t.gasPrice)}</span></> : <span className="muted">Known once a block holds it</span>}
        </Item>
        {t.gasUsed === null ? <Item label="Gas limit"><span className="mono">{count(t.gas)}</span></Item>
          : <Item label="Gas used"><span className="mono">{count(t.gasUsed)}</span> <span className="muted">of {count(t.gas)}</span></Item>}
        <CallsItem t={t} detail={detail} />
        <Item label="Nonce"><span className="mono">{t.nonce}</span></Item>
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

/** The input as it was sent, with its 4-byte method id. The explorer holds no verified interface for the contract, so there is no decode. */
function InputCard({ t }: { t: ApiTxSeen }) {
  const method = t.input.length >= 10 ? t.input.slice(0, 10) : null;
  return (
    <section className="card" aria-label="Input data">
      <Kv wide>
        <Item label="Input data"><Input data={t.input} /></Item>
        {method && <Item label="Method id"><span className="mono">{method}</span> <span className="muted">The verified interface is not held, so the input is not decoded.</span></Item>}
      </Kv>
    </section>
  );
}

/** The stage in plain words. It is the first thing the page says. */
export function stageText(t: ApiTx): string {
  switch (t.state) {
    case "pending": return "Waiting to go into a block";
    case "proving": return "In a block that is being proven";
    case "unindexed": return t.block ? `Final on Canton in block ${t.block.number}, which the explorer has not indexed yet` : "Final on Canton, not indexed yet";
    case "final": return t.block ? `Final on Canton in block ${t.block.number}` : "Final on Canton";
    case "replaced": return "Replaced by another transaction with the same nonce";
    case "dropped": return `Dropped: ${t.reason ?? "no reason was given"}`;
  }
}

const settled = (t: ApiTx) => t.state === "final" || t.state === "replaced" || t.state === "dropped";

function Stage({ t }: { t: ApiTx }) {
  return <p className={`stage s-${t.state}`} aria-live="polite" data-state={t.state}>{stageText(t)}</p>;
}

/** A transaction that reth no longer holds: all that is known is who sent it, and its nonce. */
function Unseen({ t }: { t: ApiTxUnseen }) {
  return (
    <section className="card" aria-label="Transaction">
      <Kv wide>
        <Item label="From"><HashLink value={t.from} to={`/address/${t.from}`} full /></Item>
        <Item label="Nonce"><span className="mono">{t.nonce}</span></Item>
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
  const blockQ = useQuery({ queryKey: ["block", String(n)], queryFn: () => getBlock(String(n)), enabled: n !== undefined, retry: false, staleTime: 5_000, refetchInterval: t && t.status !== "final" && n !== undefined ? 2000 : false });
  const detailQ = useQuery({ queryKey: ["tx-detail", hash], queryFn: () => getTxDetail(hash), enabled: t?.status === "final", retry: false, staleTime: 10_000 });
  const wait = unready(q, "Reading the transaction…");
  if (wait || !t) return wait;
  const read: BlockRead = n === undefined ? "none" : blockQ.isError ? "failed" : blockQ.data ? "read" : "reading";
  const detail = { data: detailQ.data, failed: detailQ.isError };
  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb"><Link to="/txs">Transactions</Link> / <span className="mono">{short(t.hash, 8, 6)}</span></nav>
      <div className="ptitle"><h1>Transaction</h1><Chip status={t.status} /><Result t={t} /></div>
      <div className="bighash"><HashLink value={t.hash} full /></div>
      <Stage t={t} />
      {t.value === null && <Unseen t={t} />}
      {t.value !== null && t.status !== "final" && <NotFinal t={t} />}
      {t.value !== null && <TxFinal t={t} block={blockQ.data} read={read} />}
      {t.value !== null && <Body t={t} coin={coin} detail={detail} block={blockQ.data} read={read} st={st} />}
    </>
  );
}

const TAB_IDS: TabId[] = ["overview", "logs", "internal", "tree", "raw"];

/** The facts, and for a transaction in a block the tabs: the overview, the logs, the internal calls, the call tree and the raw receipt. The tab is in the address. */
function Body({ t, coin, detail, block, read, st }: { t: ApiTxSeen; coin: Coin | undefined; detail: { data: ApiTxDetail | undefined; failed: boolean }; block: ApiBlock | undefined; read: BlockRead; st: ApiStatus | undefined }) {
  const [params, setParams] = useSearchParams();
  const final = t.status === "final";
  const tabs: TabSpec[] = t.status === "waiting" ? [] : [
    { id: "overview", label: "Overview" },
    { id: "logs", label: "Logs", count: t.logs.length },
    ...(final ? [
      { id: "internal" as const, label: "Internal calls", count: detail.data?.derived ? detail.data.callCount : null },
      { id: "tree" as const, label: "Call tree" },
      { id: "raw" as const, label: "Raw" },
    ] : []),
  ];
  const asked = params.get("tab") as TabId | null;
  const tab: TabId = asked && TAB_IDS.includes(asked) && tabs.some((x) => x.id === asked) ? asked : "overview";
  const pick = (id: TabId) => setParams((p) => { const n = new URLSearchParams(p); if (id === "overview") n.delete("tab"); else n.set("tab", id); return n; }, { replace: true });
  const overview = (
    <div className="tx-grid">
      <div className="tx-main">
        <Facts t={t} coin={coin} detail={detail} />
        {final && <TransfersCard hash={t.hash} />}
        {t.status !== "waiting" && <InputCard t={t} />}
      </div>
      <aside className="tx-side"><CantonRecord t={t} block={block} read={read} /><ProofSide t={t} block={block} st={st} read={read} /></aside>
    </div>
  );
  if (tabs.length === 0) return overview;
  return (
    <>
      <Tabs tabs={tabs} current={tab} onPick={pick} />
      <Panel id={tab}>
        {tab === "overview" && overview}
        {tab === "logs" && <LogsTab t={t} />}
        {tab === "internal" && <InternalTab t={t} coin={coin} />}
        {tab === "tree" && <TreeTab hash={t.hash} coin={coin} />}
        {tab === "raw" && <RawTab hash={t.hash} />}
      </Panel>
    </>
  );
}

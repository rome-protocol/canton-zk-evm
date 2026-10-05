import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getTx, type ApiTx, type Log } from "../api.ts";
import { Amount } from "../components/Amount.tsx";
import { unready } from "../components/Cards.tsx";
import { Chip } from "../components/Chip.tsx";
import { HashLink } from "../components/HashLink.tsx";
import { Icon } from "../components/Icon.tsx";
import { Item, Kv } from "../components/Kv.tsx";
import { count, gwei } from "../format.ts";
import { useFollowing, useStatus } from "../useStatus.ts";

const TYPES: Record<number, string> = { 0: "legacy", 1: "EIP-2930", 2: "EIP-1559", 3: "EIP-4844", 4: "EIP-7702" };
/** The first topic of an ERC-20 Transfer. */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const CLIP = 74;
const STEPS = ["Waiting", "Being proven", "Final"] as const;

const Good = ({ children }: { children: string }) => <span className="fact-ok"><Icon name="check" size={13} />{children}</span>;
const Bad = ({ children }: { children: string }) => <span className="fact-bad"><Icon name="cross" size={13} />{children}</span>;

type Coin = { symbol: string; decimals: number };

/** A transaction that is not final yet says so, says where it is, and says that the page looks again. Only a transaction page reached by its hash can say Waiting. */
function NotFinal({ t }: { t: ApiTx }) {
  const where = t.status === "waiting" ? "It is in reth's pool, and no block holds it yet." : "Its block is being proven.";
  return (
    <div className="alert wait-alert" role="status">
      <Icon name="info" size={15} />
      <div><b>Not final yet.</b> It becomes final when its block is proven and committed on Canton. {where} This page looks again every 2 s.</div>
    </div>
  );
}

/** Waiting, Being proven, Final: where this transaction is on the way. It sits below the facts. */
function Progress({ t }: { t: ApiTx }) {
  const at = t.status === "waiting" ? 0 : 1;
  return (
    <ol className="progress" aria-label="Where this transaction is">
      {STEPS.map((s, i) => <li key={s} className={i === at ? "pg on" : "pg"} aria-current={i === at ? "step" : undefined}>{s}</li>)}
    </ol>
  );
}

/** An amount in the chain's coin. Until the server has named the coin there is no amount to show. */
const InCoin = ({ raw, coin }: { raw: string; coin: Coin | undefined }) =>
  coin ? <Amount raw={raw} decimals={coin.decimals} symbol={coin.symbol} /> : <span className="muted">…</span>;

/** What the transaction's ERC-20 transfer did. A reverted one moved nothing, and says so. */
function TransferItem({ t, waiting }: { t: ApiTx; waiting: boolean }) {
  const tr = t.transfer;
  if (!tr) return null;
  const amount = <b><Amount raw={tr.value} decimals={tr.decimals} symbol={tr.symbol} /></b>;
  const to = <HashLink value={tr.to} to={`/address/${tr.to}`} />;
  const from = <HashLink value={t.from} to={`/address/${t.from}`} />;
  if (waiting) return <Item label="Token to move">{amount} to {to}</Item>;
  if (t.success === false) return <Item label="Token transfer">Tried to move {amount} from {from} to {to}. <span className="muted">The transaction reverted, so nothing moved.</span></Item>;
  return <Item label="Token moved">{amount} from {from} to {to}</Item>;
}

function BlockItem({ t }: { t: ApiTx }) {
  if (!t.block) return <span className="muted">None yet</span>;
  const link = <Link className="num" to={`/block/${t.block.number}`}>{t.block.number}</Link>;
  return t.block.updateId ? <>{link}, final on Canton in update <HashLink value={t.block.updateId} kind="update" /></> : <>{link}, not on Canton yet</>;
}

function Facts({ t, coin }: { t: ApiTx; coin: Coin | undefined }) {
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

function LogEntry({ log, n, t }: { log: Log; n: number; t: ApiTx }) {
  return (
    <dl className="log" role="group" aria-label={`Log ${n}`}>
      <dt className="log-k">Address</dt>
      <dd><HashLink value={log.address} to={`/address/${log.address}`} />{log.address === t.to && t.toToken && <span className="tag">{t.toToken}</span>}</dd>
      <dt className="log-k">Topics</dt>
      <dd>{log.topics.map((topic, i) => <div key={i}><span className="muted">{i}</span> <span className="mono wrap">{topic}</span>{i === 0 && topic === TRANSFER_TOPIC && <> <span className="muted">Transfer</span></>}</div>)}</dd>
      <dt className="log-k">Data</dt>
      <dd><span className="mono wrap">{log.data}</span></dd>
    </dl>
  );
}

function InputAndLogs({ t }: { t: ApiTx }) {
  return (
    <section className="card" aria-label="Input and logs">
      <Kv wide>
        <Item label="Input data"><Input data={t.input} /></Item>
        <Item label="Logs">{t.logs.length}{t.logs.map((l, i) => <LogEntry key={i} log={l} n={i + 1} t={t} />)}</Item>
      </Kv>
    </section>
  );
}

export function Tx() {
  const { hash = "" } = useParams();
  const coin = useStatus().data?.coin;
  const q = useFollowing(["tx", hash], () => getTx(hash), (t) => t.status === "final");
  const wait = unready(q, "Reading the transaction…");
  if (wait) return wait;
  const t = q.data!;
  return (
    <>
      <div className="ptitle"><h1>Transaction</h1><Chip status={t.status} /></div>
      <div className="bighash"><HashLink value={t.hash} full /></div>
      {t.status !== "final" && <NotFinal t={t} />}
      <Facts t={t} coin={coin} />
      {t.status !== "final" && <Progress t={t} />}
      {t.status !== "waiting" && <InputAndLogs t={t} />}
    </>
  );
}

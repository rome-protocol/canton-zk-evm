import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ApiError, getAddressDetail, getContract, getToken, type AddressDetail, type ContractDetail } from "../api.ts";
import { ago } from "../block-times.ts";
import { ErrorCard, LoadingCard, unready } from "../components/Cards.tsx";
import { HashLink } from "../components/HashLink.tsx";
import { Icon } from "../components/Icon.tsx";
import { Item, Kv } from "../components/Kv.tsx";
import { count, exact, plural, units } from "../format.ts";
import { useFollowing, useNow, useStatus } from "../useStatus.ts";
import { TransfersTab, TxsTab } from "./AddressTabs.tsx";
import { CodeTab } from "./ContractCode.tsx";
import { ReadTab } from "./ContractRead.tsx";
import { EventsTab } from "./ContractEvents.tsx";
import { WriteTab } from "./ContractWrite.tsx";
import { howVerified, matchMeans, MatchChip } from "./ContractParts.tsx";
import { Transfers } from "./Token.tsx";
import "./address.css";
import "./block.css";
import "./contract.css";
import "./tx.css";

const Dash = () => <span className="muted">—</span>;
const utcStamp = (iso: string) => `${new Date(iso).toISOString().replace("T", " ").slice(0, 19)} UTC`;

/** The balance is reth's at the final block, from the address route; the counts are the explorer's. */
function Overview({ c, read }: { c: ContractDetail; read: UseQueryResult<AddressDetail> }) {
  const coin = useStatus().data?.coin;
  const a = read.data;
  // A token's own page holds its holder count; a token that route does not know simply shows none.
  const holders = useQuery({ queryKey: ["token-detail", c.address], queryFn: () => getToken(c.address), enabled: !!a?.token, retry: false, staleTime: 30_000 }).data?.holderCount;
  return (
    <section className="card" aria-label="Overview">
      <h2>Overview</h2>
      <Kv>
        <Item label={coin ? `${coin.symbol} balance` : "Balance"}>
          {read.isPending ? <span className="muted" aria-busy="true">Reading…</span>
            : !a || a.balance === null || !coin ? <span className="muted" title="Read from reth at the final block">Not known yet</span>
            : <span title={`${exact(a.balance, coin.decimals)} ${coin.symbol}, as of final block ${a.balanceBlock}, read from reth`}>{units(a.balance, coin.decimals)} {coin.symbol} <span className="muted small">as of final block {a.balanceBlock}</span></span>}
        </Item>
        {a?.token && <Item label="Token tracker"><Link to={`/token/${c.address}`}>{a.token.name ?? a.token.symbol ?? "Token"}{a.token.name && a.token.symbol ? ` (${a.token.symbol})` : ""}</Link>{holders !== undefined && <span className="muted small"> · {plural(holders, "holder")}</span>}</Item>}
        {a && <Item label="Transactions"><span className="num">{count(a.sentCount + a.receivedCount)}</span></Item>}
        {a && <Item label="Internal calls"><span className="num">{count(a.internalCount)}</span></Item>}
        <Item label="Interactions"><span className="num">{count(c.interactionCount)}</span>{c.lastInteractionBlock !== null && <span className="muted small"> · last in block {c.lastInteractionBlock}</span>}</Item>
      </Kv>
    </section>
  );
}

/** A contract of the genesis was made by no transaction: it has no creator and no creation block, and says so the way Etherscan's creation answer does. */
function Creation({ c, now }: { c: ContractDetail; now: number }) {
  const genesis = c.origin === "genesis";
  return (
    <section className="card" aria-label="Creation">
      <h2>Creation</h2>
      <Kv>
        <Item label="Creator">
          {genesis ? <><span className="mono">GENESIS</span><div className="muted small">set by the chain, no creation transaction</div></>
            : c.creator ? <><HashLink value={c.creator} to={`/address/${c.creator}`} />{c.creationTxHash && <> at <HashLink value={c.creationTxHash} to={`/tx/${c.creationTxHash}`} /></>}</> : <Dash />}
        </Item>
        <Item label="Created in">
          {genesis ? "in the chain's genesis" : c.creationBlock === null ? <Dash /> : <><Link className="num" to={`/block/${c.creationBlock}`}>Block {c.creationBlock}</Link>{c.createdAt && <span className="muted small"> · {ago(c.createdAt, now)}</span>}</>}
        </Item>
        {c.destroyedBlock !== null && <Item label="Destroyed"><span className="fact-bad">Destroyed in block <Link className="num" to={`/block/${c.destroyedBlock}`}>{c.destroyedBlock}</Link></span></Item>}
        <Item label="Code"><span className="num">{count(c.codeSize)} bytes</span> · hash <HashLink value={c.codeHash} /></Item>
      </Kv>
    </section>
  );
}

function Proxy({ c }: { c: ContractDetail }) {
  const p = c.proxy;
  if (!p) return <>Not a proxy</>;
  return (
    <>
      <span className="mono">{p.kind}</span>
      {p.implementation && <> to <HashLink value={p.implementation} to={`/contract/${p.implementation}`} /></>}
      {p.beacon && <> · beacon <HashLink value={p.beacon} to={`/address/${p.beacon}`} /></>}
      <div className="muted small">as of block {p.checkedBlock}</div>
    </>
  );
}

function Verification({ c }: { c: ContractDetail }) {
  const v = c.verification;
  return (
    <section className="card" aria-label="Verification">
      <div className="list-h"><h2>Verification</h2><MatchChip matchType={c.matchType} /></div>
      <Kv>
        {v ? <Item label="Verified">{utcStamp(v.verifiedAt)}</Item> : <Item label="Verified"><span className="muted">Not verified</span></Item>}
        {v && <Item label="How">{howVerified(v.method, v.tool)}</Item>}
        <Item label="Proxy"><Proxy c={c} /></Item>
      </Kv>
      {c.matchType && c.matchType !== "full" && <p className="small muted card-note">{c.matchType === "partial" && v?.matchNote ? v.matchNote : matchMeans(c.matchType)}</p>}
    </section>
  );
}

/** The token behind a contract. A failed read tries again by itself, so a limit or an outage is never read as "no token". */
function useTokenDetail(address: string, enabled: boolean) {
  return useQuery({ queryKey: ["token-detail", address], queryFn: () => getToken(address), enabled, retry: false, staleTime: 30_000, refetchInterval: (q) => (q.state.status === "error" ? 5000 : false) });
}
const notFound = (e: unknown) => e instanceof ApiError && e.status === 404;

/** A token's Token transfers tab is the token's own transfers (every move of it), not only those that touch the contract's address. Only a token the route does not know falls back to the address's. */
function TokenTransfers({ address }: { address: string }) {
  const t = useTokenDetail(address, true);
  if (t.data) return <Transfers t={t.data} />;
  if (t.isPending) return <LoadingCard>Reading the transfers…</LoadingCard>;
  return notFound(t.error) ? <TransfersTab a={address} /> : <ErrorCard message={t.error instanceof Error ? t.error.message : "The explorer cannot read the chain right now."} retrying />;
}

type TabId = "transactions" | "token-transfers" | "code" | "read" | "write" | "events";

/** One contract: who made it, what it holds, whether its source is verified, and its code. The tab is in the link. */
export function Contract({ addr: given }: { addr?: string } = {}) {
  const { addr: routed = "" } = useParams();
  const addr = given ?? routed;
  const [params, setParams] = useSearchParams();
  const st = useStatus().data;
  const now = useNow();
  const q = useFollowing(["contract", addr], () => getContract(addr), (d) => d.derived);
  const read = useQuery({ queryKey: ["address-detail", addr], queryFn: () => getAddressDetail(addr), refetchInterval: (q) => (q.state.status === "error" ? 5000 : false) });
  const tokq = useTokenDetail(addr, !!read.data?.token);
  const tok = tokq.data;
  const wait = unready(q, "Reading the contract…");
  if (wait) return wait;
  const c = q.data!;
  const a = read.data;
  // A token's tab counts the token's own transfers; no count until that is known. Only a 404 falls back to the address's count.
  const tokenCount = !a ? undefined : !a.token ? a.tokenTransferCount : tok ? tok.transferCount : notFound(tokq.error) ? a.tokenTransferCount : undefined;
  const tabs: { id: TabId; label: string; mark?: boolean; n?: number | string }[] = [
    { id: "transactions", label: "Transactions", n: a ? a.sentCount + a.receivedCount : undefined }, { id: "token-transfers", label: "Token transfers", n: tokenCount }, { id: "code", label: "Code", mark: c.verified }, { id: "read", label: "Read" }, { id: "write", label: "Write" }, { id: "events", label: "Events", n: c.eventCountCapped ? `${count(c.eventCount)}+` : c.eventCount },
  ];
  const asked = params.get("tab");
  const tab: TabId = tabs.find((t) => t.id === asked)?.id ?? "transactions";
  const pick = (id: TabId) => setParams((p) => { const n = new URLSearchParams(p); if (id === "transactions") n.delete("tab"); else n.set("tab", id); return n; }, { replace: true });
  return (
    <>
      <nav className="small muted" aria-label="Breadcrumb"><Link to="/contracts">Contracts</Link> / {c.name ?? <span className="mono">{c.address.slice(0, 6)}…{c.address.slice(-4)}</span>}</nav>
      <div className="ptitle">
        <h1>Contract</h1>
        {c.standard && <span className="chip chip-kind">{c.standard}</span>}
        <span className={`chip ${c.verified ? "chip-final" : "chip-kind"}`}>{c.verified && <Icon name="check" size={12} />}{c.verified ? "Source code verified" : "Source code not verified"}</span>
        {c.name && <span className="muted">{c.name}</span>}
      </div>
      <div className="bighash"><HashLink value={c.address} full /></div>
      <div className="addr-cards">
        <Overview c={c} read={read} />
        <Creation c={c} now={now} />
        <Verification c={c} />
      </div>
      <div className="tabs" role="tablist" aria-label="Contract sections">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" id={`tab-${t.id}`} aria-selected={t.id === tab} aria-controls={`panel-${t.id}`} onClick={() => pick(t.id)}>
            {t.label}{t.n !== undefined && <> <span className="count">{count(t.n)}</span></>}{t.mark && <> <span aria-label="verified">✓</span></>}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "code" ? <CodeTab detail={c} chainId={st?.chainId} />
          : tab === "read" ? <ReadTab detail={c} />
          : tab === "write" ? <WriteTab detail={c} />
          : tab === "events" ? <EventsTab detail={c} />
          : !st ? null : tab === "transactions" ? <TxsTab a={c.address} st={st} now={now} /> : read.isError ? <ErrorCard message={read.error instanceof Error ? read.error.message : "The explorer cannot read the chain right now."} retrying /> : !a ? <LoadingCard>Reading the transfers…</LoadingCard> : a.token ? <TokenTransfers address={c.address} /> : <TransfersTab a={c.address} />}
      </div>
    </>
  );
}

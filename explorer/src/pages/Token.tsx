import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { getContract, getToken, getTokenHolders, getTokenTransfers, type TokenDetail, type TokenHolder } from "../api.ts";
import { Amount } from "../components/Amount.tsx";
import { CardHead, ErrorCard, LoadingCard, unready } from "../components/Cards.tsx";
import { Chip } from "../components/Chip.tsx";
import { HashLink } from "../components/HashLink.tsx";
import { Icon } from "../components/Icon.tsx";
import { Item, Kv } from "../components/Kv.tsx";
import { Pager, usePaged } from "../components/Pager.tsx";
import { count, exact, units } from "../format.ts";
import { useFollowing, useStatus } from "../useStatus.ts";
import { failedNote, NftCount, noName, Supply } from "./TokenParts.tsx";
import "./token.css";

const PER = 25;
const ZERO = "0x" + "00".repeat(20);

/** A holder's share of the supply in hundredths of a percent, rounded down. A share too small for that is "<0.01%", never 0. */
export function share(value: string, supply: string | null): { text: string; bp: number } | null {
  if (supply === null || BigInt(supply) === 0n) return null;
  const bp = Math.min(Number((BigInt(value) * 10000n) / BigInt(supply)), 10000);
  return bp === 0 ? { text: "<0.01%", bp: 0 } : { text: `${(bp / 100).toFixed(2)}%`, bp };
}

const Dash = () => <span className="muted">—</span>;
const Gap = ({ derived, n, none }: { derived: boolean | undefined; n: number; none: string }) =>
  derived !== false ? (n === 0 ? <p className="muted">{none}</p> : null)
    : <p className="muted small">{n === 0 ? "The explorer has not read these blocks yet, so this list is not known to be empty." : "The explorer is still reading blocks, so this list may be missing the newest rows."}</p>;

function Stat({ k, v, sub, hash = false }: { k: string; v: React.ReactNode; sub: React.ReactNode; hash?: boolean }) {
  return <div className="card stat"><span className="stat-k">{k}</span><span className={`stat-v${hash ? " stat-hash" : ""}`}>{v}</span><span className="small muted">{sub}</span></div>;
}

function Cards({ t }: { t: TokenDetail }) {
  const c = useQuery({ queryKey: ["token-contract", t.address], queryFn: () => getContract(t.address), retry: false, staleTime: 30_000 }).data;
  const fungible = t.standard === "ERC-20";
  const supplySub = [t.totalSupply !== null && fungible ? t.symbol : null, t.totalSupplyBlock !== null ? `as of block ${t.totalSupplyBlock}` : t.totalSupply === null ? "the contract has not told it" : null].filter(Boolean).join(" · ");
  return (
    <div className="stats six tok-stats">
      <Stat k="Total supply" v={<Supply t={t} bare={fungible && t.symbol !== null} />} sub={supplySub || " "} />
      <Stat k="Holders" v={count(t.holderCount)} sub="addresses holding any" />
      <Stat k="Transfers" v={count(t.transferCount)} sub="in final blocks" />
      <Stat k="Decimals" v={fungible && t.decimals !== null ? t.decimals : <Dash />} sub={fungible ? (t.decimals !== null ? "read from the contract" : "not read") : `${t.standard} has none`} />
      <Stat k="Contract" hash v={<HashLink value={t.address} to={`/contract/${t.address}`} />} sub={c ? (c.origin === "genesis" ? "in the genesis allocation" : c.creationBlock !== null ? `created in block ${c.creationBlock}` : " ") : " "} />
    </div>
  );
}

function HolderRow({ h, n, t }: { h: TokenHolder; n: number; t: TokenDetail }) {
  const fungible = t.standard === "ERC-20";
  const s = fungible ? share(h.value, t.totalSupply) : null;
  // An ERC-721 is keyed by id 0 with the holder's count as the value; only an ERC-1155 balance is of one id.
  const multi = t.standard === "ERC-1155";
  return (
    <tr>
      <td className="muted">{n}</td>
      <td><HashLink value={h.holder} to={`/address/${h.holder}`} /></td>
      {multi && <td><span className="mono">#{h.tokenId}</span></td>}
      <td className="r">{fungible && t.decimals !== null && t.symbol ? <Amount raw={h.value} decimals={t.decimals} symbol={t.symbol} />
        : fungible && t.decimals !== null ? <span className="num" title={exact(h.value, t.decimals)}>{units(h.value, t.decimals)}</span>
        : t.standard === "ERC-721" ? <NftCount n={h.value} />
        : <span className="num" title={fungible ? "The token's decimals are not known, so this is the raw balance" : undefined}>{count(h.value)}</span>}</td>
      {fungible && <td className="r"><span className="num">{s ? s.text : "—"}</span></td>}
      {fungible && <td><div className="share" aria-hidden="true"><span style={{ width: `${s ? Math.max(s.bp / 100, s.bp > 0 ? 1 : 0) : 0}%` }} /></div></td>}
    </tr>
  );
}

const SEG = ["var(--canton)", "#3B82B4", "#C27BA8", "#4FA58A", "#C9A227"];
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** The share of the supply the biggest holders have, from the first page of holders and the total supply. */
function Distribution({ items, t, final }: { items: TokenHolder[]; t: TokenDetail; final: number | null }) {
  const top = items.slice(0, SEG.length).map((h) => ({ h, s: share(h.value, t.totalSupply) }));
  const lead = top[0]?.s;
  if (!lead) return null;
  return (
    <section className="card holds" aria-label="Holder distribution">
      <CardHead as="h2" title="Holder distribution" sub={final !== null ? `as of final block ${final}` : undefined} />
      <div>
        <span className="muted small">Share held by the top holder</span>
        <div className="stat-v">{lead.text}</div>
        <div className="bar" aria-hidden="true">{top.map(({ h, s }, i) => s && s.bp > 0 && <span key={h.holder} style={{ width: `${s.bp / 100}%`, background: SEG[i] }} />)}</div>
        <div className="bar-key small">{top.map(({ h, s }, i) => <span key={h.holder}><span className="dot" style={{ background: SEG[i] }} aria-hidden="true" /> {short(h.holder)} {s?.text}</span>)}</div>
      </div>
    </section>
  );
}

function HoldersTab({ t }: { t: TokenDetail }) {
  const p = usePaged(["token-holders", t.address], (before) => getTokenHolders(t.address, before, PER), 5000);
  const d = p.data;
  const fungible = t.standard === "ERC-20";
  const status = useStatus().data;
  if (p.error && !d) return <ErrorCard message={p.error.message} retrying />;
  if (!d) return <LoadingCard>Reading the holders…</LoadingCard>;
  // The balances are as of the final block only while the explorer has read up to it.
  const final = d.derived !== false ? (status?.final?.number ?? null) : null;
  return (
    <>
    {fungible && t.totalSupply !== null && p.page === 1 && d.derived !== false && <Distribution items={d.items} t={t} final={final} />}
    <section className="card" aria-label="Holders">
      <div className="list-h"><span className="muted">{d.items.length ? `Showing ${count(d.items.length)} on this page, largest balance first${final !== null ? ` · as of final block ${final}` : ""}` : ""}</span><Pager p={p} label="Pages of holders" /></div>
      {d.items.length > 0 && (
        <div className="scroll">
          <table className="tbl">
            <thead><tr><th>#</th><th>Holder</th>{t.standard === "ERC-1155" && <th>Token id</th>}<th className="r">Balance{fungible && t.symbol ? ` (${t.symbol})` : ""}</th>{fungible && <th className="r">Share</th>}{fungible && <th aria-hidden="true" />}</tr></thead>
            <tbody>{d.items.map((h, i) => <HolderRow key={`${h.holder}-${h.tokenId}`} h={h} n={(p.page - 1) * PER + i + 1} t={t} />)}</tbody>
          </table>
        </div>
      )}
      <Gap derived={d.derived} n={d.items.length} none="Nobody holds this token yet." />
      <p className="muted small">
        {t.balanceMode === "derived" ? "Balances are summed from the Transfer logs of final blocks." : "Balances are read from the contract with balanceOf at the final head."}
        {fungible && t.totalSupply !== null ? " A share is the balance over the total supply above." : ""}
      </p>
    </section>
    </>
  );
}

function TransfersTab({ t }: { t: TokenDetail }) {
  const p = usePaged(["token-transfers", t.address], (before) => getTokenTransfers(t.address, before, PER), 5000);
  const d = p.data;
  if (p.error && !d) return <ErrorCard message={p.error.message} retrying />;
  if (!d) return <LoadingCard>Reading the transfers…</LoadingCard>;
  return (
    <section className="card" aria-label="Transfers">
      <div className="list-h"><span className="muted">{d.items.length ? `Showing ${count(d.items.length)} on this page, newest first` : ""}</span><Pager p={p} label="Pages of transfers" /></div>
      {d.items.length > 0 && (
        <div className="scroll">
          <table className="tbl">
            <thead><tr><th>Transaction hash</th><th>Block</th><th>From</th><th aria-hidden="true" /><th>To</th><th className="r">Amount</th><th>Stage</th></tr></thead>
            <tbody>{d.items.map((x) => (
              <tr key={`${x.txHash}-${x.logIndex}-${x.batchIndex}`}>
                <td><HashLink value={x.txHash} to={`/tx/${x.txHash}`} /></td>
                <td><Link className="num" to={`/block/${x.block}`}>{x.block}</Link></td>
                <td><HashLink value={x.from} to={`/address/${x.from}`} />{x.from === ZERO && <span className="tag">mint</span>}</td>
                <td aria-hidden="true">→</td>
                <td><HashLink value={x.to} to={`/address/${x.to}`} />{x.to === ZERO && <span className="tag">burn</span>}</td>
                <td className="r">
                  {x.tokenId !== null ? <span className="mono">{x.amount !== null ? `${count(x.amount)} · ` : ""}#{x.tokenId}</span>
                    : x.amount === null ? <Dash />
                    : t.decimals !== null && t.symbol ? <Amount raw={x.amount} decimals={t.decimals} symbol={t.symbol} />
                    : t.decimals !== null ? <span className="num" title={exact(x.amount, t.decimals)}>{units(x.amount, t.decimals)}</span>
                    : <span className="num" title="The token's decimals are not known, so this is the raw amount">{count(x.amount)}</span>}
                </td>
                <td><Chip status="final" /></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <Gap derived={d.derived} n={d.items.length} none="No transfers yet." />
      <p className="muted small">Only transfers in final blocks are listed, read from the token's Transfer logs. A reverted transaction moved nothing, so it is not a transfer; it is on the contract's Transactions tab.</p>
    </section>
  );
}

function Information({ t }: { t: TokenDetail }) {
  return (
    <section className="card" aria-label="Token information">
      <CardHead as="h2" title="Token information" sub="read from the contract" />
      <Kv>
        <Item label="Name">{t.name ?? <span className="muted">{noName(t)}</span>}</Item>
        <Item label="Symbol">{t.symbol ?? <Dash />}</Item>
        <Item label="Decimals">{t.decimals ?? <Dash />}</Item>
        <Item label="Standard">{t.standard}</Item>
        <Item label="Balances">{t.balanceMode === "derived" ? "summed from the Transfer logs" : "read with balanceOf"}</Item>
        <Item label="Contract"><HashLink value={t.address} to={`/contract/${t.address}`} /></Item>
      </Kv>
    </section>
  );
}

type TabId = "holders" | "transfers";

/** One token: what it is called and counts in, its supply, its holders with their share, and its transfers. The tab is in the link. */
export function Token() {
  const { addr = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const q = useFollowing(["token", addr], () => getToken(addr), (d) => d.derived);
  const contract = useQuery({ queryKey: ["token-contract", addr], queryFn: () => getContract(addr), retry: false, staleTime: 30_000 }).data;
  const wait = unready(q, "Reading the token…");
  if (wait) return wait;
  const t = q.data!;
  const tabs: { id: TabId; label: string; n: number }[] = [{ id: "holders", label: "Holders", n: t.holderCount }, { id: "transfers", label: "Transfers", n: t.transferCount }];
  const tab: TabId = tabs.find((x) => x.id === params.get("tab"))?.id ?? "holders";
  const pick = (id: TabId) => setParams((p) => { const n = new URLSearchParams(p); if (id === "holders") n.delete("tab"); else n.set("tab", id); return n; }, { replace: true });
  return (
    <>
      <nav className="small muted" aria-label="Breadcrumb"><Link to="/tokens">Tokens</Link> / {t.name ?? <span className="mono">{t.address.slice(0, 6)}…{t.address.slice(-4)}</span>}</nav>
      <div className="ptitle">
        <h1>{t.name ?? <span className="muted">{noName(t)}</span>}{t.symbol && <> <small className="muted">{t.symbol}</small></>}</h1>
        <span className="chip chip-kind">{t.standard}</span>
        {contract && <span className={`chip ${contract.verified ? "chip-final" : "chip-kind"}`}>{contract.verified && <Icon name="check" size={12} />}{contract.verified ? "Source code verified" : "Source code not verified"}</span>}
        {t.gatewayWrapped && <span className="chip chip-kind" title="The gateway made this wrapped token for a Canton token">From Canton</span>}
      </div>
      <div className="bighash"><HashLink value={t.address} full /></div>
      {t.metadataStatus !== "read" && (
        <aside className="card note" role="note"><p className="small">{t.metadataStatus === "failed" ? failedNote(t)
          : "The explorer has not read this token's name, symbol or decimals from the contract yet, so amounts are shown raw until it has."}</p></aside>
      )}
      <Cards t={t} />
      <div className="tabs" role="tablist" aria-label="Token sections">
        {tabs.map((x) => (
          <button key={x.id} type="button" role="tab" id={`tab-${x.id}`} aria-selected={x.id === tab} aria-controls={`panel-${x.id}`} onClick={() => pick(x.id)}>
            {x.label} <span className="count">{count(x.n)}</span>
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>{tab === "holders" ? <HoldersTab t={t} /> : <TransfersTab t={t} />}</div>
      <Information t={t} />
      {t.derived === false && <p className="muted small">The explorer is still reading blocks, so the counts here may be short.</p>}
    </>
  );
}

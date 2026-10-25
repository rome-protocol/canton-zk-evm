import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { ApiError, getContract, getToken, getTokenHolders, getTokenTransfers, tokenTransfersCsvPath, type AddressTransferItem, type TokenDetail, type TokenHolder } from "../api.ts";
import { CardHead, DownloadLink, ErrorCard, LoadingCard, unready } from "../components/Cards.tsx";
import { Chip } from "../components/Chip.tsx";
import { HashLink } from "../components/HashLink.tsx";
import { Icon } from "../components/Icon.tsx";
import { Item, Kv } from "../components/Kv.tsx";
import { Pager, usePaged } from "../components/Pager.tsx";
import { count, duration, exact, units } from "../format.ts";
import { useLabels, type Labels } from "../labels.ts";
import { methodOf } from "../method.ts";
import { listPoll } from "../stats.ts";
import { useNow, useStatus } from "../useStatus.ts";
import { CantonCustody } from "./CantonCustody.tsx";
import { Avatar, failedNote, Mint, NftCount, noName, Supply } from "./TokenParts.tsx";
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

const hasSymbol = (t: TokenDetail) => t.standard === "ERC-20" && t.decimals !== null && t.symbol !== null;

function Cards({ t }: { t: TokenDetail }) {
  const c = useQuery({ queryKey: ["token-contract", t.address], queryFn: () => getContract(t.address), retry: false, staleTime: 30_000 }).data;
  const fungible = t.standard === "ERC-20";
  // The symbol names a supply only when the decimals are known: a raw count is never labelled with it. An ERC-1155 has no total supply by standard.
  const supplySub = t.standard === "ERC-1155" ? "ERC-1155 has no total supply" : [hasSymbol(t) && t.totalSupply !== null ? t.symbol : null, t.totalSupplyBlock !== null ? `as of block ${t.totalSupplyBlock}` : t.totalSupply === null ? "the contract has not told it" : null].filter(Boolean).join(" · ");
  return (
    <div className="stats six tok-stats">
      <Stat k="Total supply" v={<Supply t={t} bare={hasSymbol(t)} />} sub={supplySub || " "} />
      <Stat k="Holders" v={count(t.holderCount)} sub="addresses with a balance above 0" />
      <Stat k="Transfers" v={count(t.transferCount)} sub="in final blocks" />
      <Stat k="Decimals" v={fungible && t.decimals !== null ? t.decimals : <Dash />} sub={fungible ? (t.decimals !== null ? "read from the contract" : "not read") : `${t.standard} has none`} />
      <Stat k="Contract" hash v={<HashLink value={t.address} to={`/contract/${t.address}`} />} sub={c ? (c.origin === "genesis" ? "in the genesis allocation" : c.creationBlock !== null ? `created in block ${c.creationBlock}` : " ") : " "} />
    </div>
  );
}

const SEG = ["var(--canton)", "#3B82B4", "#C27BA8", "#4FA58A", "#C9A227"];
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const raw = (t: TokenDetail) => t.standard === "ERC-20" && t.decimals === null;

/** A number in this token's whole units, with no symbol: the column header names the unit as screen 09b does, and the tooltip has the exact amount with the symbol. */
function Bare({ raw, t, decimals }: { raw: string; t: TokenDetail; decimals: number }) {
  return <span className="num" title={`${exact(raw, decimals)}${hasSymbol(t) ? ` ${t.symbol}` : ""}`}>{units(raw, decimals)}</span>;
}

function HolderRow({ h, n, t, dot }: { h: TokenHolder; n: number; t: TokenDetail; dot?: string }) {
  const fungible = t.standard === "ERC-20";
  const s = fungible ? share(h.value, t.totalSupply) : null;
  // An ERC-721 is keyed by id 0 with the holder's count as the value; only an ERC-1155 balance is of one id.
  const multi = t.standard === "ERC-1155";
  return (
    <tr>
      <td className="muted">{n}</td>
      <td>
        {dot && <span className="dot sq" style={{ background: dot }} aria-hidden="true" />}
        <HashLink value={h.holder} to={`/address/${h.holder}`} plain />
        {t.creator !== null && h.holder.toLowerCase() === t.creator.toLowerCase() && <span className="tag">creator</span>}
      </td>
      {multi && <td><span className="mono">#{h.tokenId}</span></td>}
      <td className="r">{fungible && t.decimals !== null ? <Bare raw={h.value} t={t} decimals={t.decimals} />
        : t.standard === "ERC-721" ? <NftCount n={h.value} />
        : <span className="num" title={fungible ? "The token's decimals are not known, so this is the raw balance" : undefined}>{count(h.value)}</span>}</td>
      {fungible && <td className="r"><span className="num">{s ? s.text : "—"}</span></td>}
      {fungible && <td><div className="share" aria-hidden="true"><span style={{ width: `${s ? Math.max(s.bp / 100, s.bp > 0 ? 1 : 0) : 0}%` }} /></div></td>}
    </tr>
  );
}

/** The share of the supply the biggest holders have, from the first page of holders and the total supply; null when it cannot be told. */
function distribution(items: TokenHolder[], t: TokenDetail) {
  const top = items.slice(0, SEG.length).map((h) => ({ h, s: share(h.value, t.totalSupply) }));
  const lead = top[0]?.s;
  return lead ? { top, lead } : null;
}

function Distribution({ dist, note }: { dist: NonNullable<ReturnType<typeof distribution>>; note: string }) {
  const { top, lead } = dist;
  return (
    <div className="holds-side">
      <span className="muted small">Share held by the top holder</span>
      <div className="stat-v">{lead.text}</div>
      <div className="bar" aria-hidden="true">{top.map(({ h, s }, i) => s && s.bp > 0 && <span key={h.holder} style={{ width: `${s.bp / 100}%`, background: SEG[i] }} />)}</div>
      <div className="bar-key small">{top.map(({ h, s }, i) => <span key={h.holder}><span className="dot" style={{ background: SEG[i] }} aria-hidden="true" /> {short(h.holder)} {s?.text}</span>)}</div>
      <p className="muted small">{note}</p>
    </div>
  );
}

/** The holders, largest first. With the share of the supply the biggest hold, they are the right column beside it; without, they are one card. */
function Holders({ t }: { t: TokenDetail }) {
  const p = usePaged(["token-holders", t.address], (before) => getTokenHolders(t.address, before, PER), listPoll(false));
  const d = p.data;
  const fungible = t.standard === "ERC-20";
  const read = t.balanceMode !== "derived";
  const status = useStatus().data;
  if (p.error && !d) return <ErrorCard message={p.error.message} retrying />;
  if (!d) return <LoadingCard>Reading the holders…</LoadingCard>;
  // Summed balances are as of the final block only while the explorer has read up to it; a balance read with balanceOf is as of the block that last moved it.
  const final = !read && d.derived !== false ? (status?.deriveCursor ?? null) : null;
  const dist = fungible && t.totalSupply !== null && p.page === 1 && d.derived !== false ? distribution(d.items, t) : null;
  const how = read ? "each balance is read at the last block that moved it" : final !== null ? `as of final block ${final}` : null;
  const foot = read ? "Balances are read from the contract with balanceOf, each at the last block that moved it." : "Balances are summed from the Transfer logs of final blocks.";
  const shareNote = fungible && t.totalSupply !== null ? " A share is the balance over the total supply above." : "";
  const table = (
    <div className="holds-tbl">
      <div className="list-h"><span className="muted">{d.items.length ? `Showing ${count(d.items.length)} on this page, largest balance first` : ""}</span><Pager p={p} label="Pages of holders" /></div>
      {d.items.length > 0 && (
        <div className="scroll">
          <table className="tbl" aria-label="Token holders">
            <thead><tr><th>#</th><th>Holder</th>{t.standard === "ERC-1155" && <th>Token id</th>}<th className="r">Balance{hasSymbol(t) ? ` (${t.symbol})` : ""}</th>{fungible && <th className="r">Share</th>}{fungible && <th aria-hidden="true" />}</tr></thead>
            <tbody>{d.items.map((h, i) => <HolderRow key={`${h.holder}-${h.tokenId}`} h={h} n={(p.page - 1) * PER + i + 1} t={t} dot={dist && i < SEG.length ? SEG[i] : undefined} />)}</tbody>
          </table>
        </div>
      )}
      <Gap derived={d.derived} n={d.items.length} none="Nobody holds this token yet." />
      {!dist && <p className="muted small holds-foot">{foot}{shareNote}{raw(t) ? " The decimals are not known, so balances are raw." : ""}</p>}
    </div>
  );
  if (!dist) return <section className="card" aria-label="Holders"><CardHead as="h2" title="Holders" sub={how ?? undefined} />{table}</section>;
  return (
    <section className="card holds-card" aria-label="Holder distribution">
      <CardHead as="h2" title={<>Holder distribution{" "}</>} sub={how ?? undefined} />
      <div className="holds-cols">
        <Distribution dist={dist} note={foot + shareNote} />
        {table}
      </div>
    </section>
  );
}

/** What moved, in the token's own units: whole tokens with the symbol where the decimals are known, the raw count (and said so) where they are not, `#id` for an NFT. */
function Moved({ x, t }: { x: AddressTransferItem; t: TokenDetail }) {
  if (x.tokenId !== null) return <span className="mono">{x.amount !== null ? `${count(x.amount)} · ` : ""}#{x.tokenId}</span>;
  if (x.amount === null) return <Dash />;
  if (t.decimals !== null) return <Bare raw={x.amount} t={t} decimals={t.decimals} />;
  return <span className="num" title="The token's decimals are not known, so this is the raw amount">{count(x.amount)}</span>;
}

function TransferRow({ x, t, now, labels }: { x: AddressTransferItem; t: TokenDetail; now: number; labels: Labels }) {
  return (
    <tr>
      <td>
        <HashLink value={x.txHash} to={`/tx/${x.txHash}`} plain />
        <div className="small muted">block <Link className="num" to={`/block/${x.block}`}>{x.block}</Link> · <span title={new Date(x.timestamp * 1000).toISOString()}>{duration(now - x.timestamp * 1000)} ago</span></div>
      </td>
      <td><span className="tag method">{methodOf({ methodId: x.methodId, to: x.creation ? null : x.to, created: x.creation ? x.token : null, value: "0" })}</span></td>
      <td><Mint address={x.from} labels={labels} />{x.from === ZERO && <span className="tag">mint</span>}</td>
      <td className="arrow muted" aria-hidden="true">→</td>
      <td><Mint address={x.to} labels={labels} />{x.to === ZERO && <span className="tag">burn</span>}</td>
      <td className="r"><Moved x={x} t={t} /></td>
      <td><Chip status="final" /></td>
    </tr>
  );
}

export function Transfers({ t }: { t: TokenDetail }) {
  const p = usePaged(["token-transfers", t.address], (before) => getTokenTransfers(t.address, before, PER), listPoll(false));
  const now = useNow();
  const d = p.data;
  const labels = useLabels((d?.items ?? []).flatMap((x) => [x.from, x.to]));
  if (p.error && !d) return <ErrorCard message={p.error.message} retrying />;
  if (!d) return <LoadingCard>Reading the transfers…</LoadingCard>;
  return (
    <section className="card" aria-label="Transfers">
      <CardHead as="h2" title="Transfers" sub="newest first, final blocks only" action={<DownloadLink href={tokenTransfersCsvPath(t.address)} file="token-transfers.csv">CSV</DownloadLink>} />
      <div className="list-h"><span className="muted">{d.items.length ? `Showing ${count(d.items.length)} on this page, newest first` : ""}</span><Pager p={p} label="Pages of transfers" /></div>
      {d.items.length > 0 && (
        <div className="scroll">
          <table className="tbl" aria-label="Token transfers">
            <thead><tr><th>Transaction</th><th>Method</th><th>From</th><th aria-hidden="true" /><th>To</th><th className="r">Amount</th><th>Stage</th></tr></thead>
            <tbody>{d.items.map((x) => <TransferRow key={`${x.txHash}-${x.logIndex}-${x.batchIndex}`} x={x} t={t} now={now} labels={labels} />)}</tbody>
          </table>
        </div>
      )}
      <Gap derived={d.derived} n={d.items.length} none="No transfers yet." />
      <p className="muted small">Only transfers in final blocks are listed, read from the token's Transfer logs; one in a block that is not final yet is not shown, so a row never changes. A reverted transaction moved nothing, so it is not a transfer; it is on the contract's Transactions tab.</p>
    </section>
  );
}

/** What the contract and its creation say of the token, in three columns. Nothing the API does not serve (an owner, a description, who may mint) is shown. */
function Information({ t }: { t: TokenDetail }) {
  const c = useQuery({ queryKey: ["token-contract", t.address], queryFn: () => getContract(t.address), retry: false, staleTime: 30_000 }).data;
  const block = c?.creationBlock ?? t.creationBlock;
  const genesis = (c ? c.origin === "genesis" : false) || (!c && t.creationBlock === null && t.createdAt === null && t.creator === null);
  const creator = c?.creator ?? t.creator;
  return (
    <section className="card" aria-label="Token information">
      <CardHead as="h2" title="Token information" sub="read from the contract and its creation" />
      <div className="kv-3">
        <Kv>
          <Item label="Name">{t.name ?? <span className="muted">{noName(t)}</span>}</Item>
          <Item label="Symbol">{t.symbol ?? <Dash />}</Item>
          <Item label="Decimals">{t.standard === "ERC-20" ? (t.decimals ?? <Dash />) : <span className="muted">{t.standard} has none</span>}</Item>
        </Kv>
        <Kv>
          <Item label="Standard">{t.standard}</Item>
          <Item label="Balances">{t.balanceMode === "derived" ? "summed from the Transfer logs" : "read with balanceOf"}</Item>
          <Item label="Creator">{creator ? <HashLink value={creator} to={`/address/${creator}`} plain /> : <span className="muted">{genesis ? "no transaction made it" : "—"}</span>}</Item>
        </Kv>
        <Kv>
          <Item label="Contract"><HashLink value={t.address} to={`/contract/${t.address}`} plain /></Item>
          <Item label="Created">
            {genesis ? <span className="muted" title="A contract of the genesis state, which no transaction made">Genesis state</span>
              : block === null ? <Dash />
              : <><Link className="num" to={`/block/${block}`}>Block {block}</Link>{c?.creationTxHash && <> · <HashLink value={c.creationTxHash} to={`/tx/${c.creationTxHash}`} plain lead={8} tail={4} /></>}</>}
          </Item>
          <Item label="Source code">{c ? (c.verified ? "verified" : "not verified") : <Dash />}</Item>
        </Kv>
      </div>
    </section>
  );
}

/** One token, one page: what it is called and counts in, its supply, its holders with their share, its transfers, and what its contract says of it. It is read again as the lists are. */
export function Token() {
  const { addr = "" } = useParams();
  const q = useQuery({
    queryKey: ["token", addr],
    queryFn: () => getToken(addr),
    refetchInterval: (r) => (r.state.error instanceof ApiError && (r.state.error.status === 404 || r.state.error.status === 400) ? false : listPoll(false)),
  });
  const contract = useQuery({ queryKey: ["token-contract", addr], queryFn: () => getContract(addr), retry: false, staleTime: 30_000 }).data;
  const wait = unready(q, "Reading the token…");
  if (wait) return wait;
  const t = q.data!;
  return (
    <>
      <nav className="small muted" aria-label="Breadcrumb"><Link to="/tokens">Tokens</Link> / {t.name ?? <span className="mono">{t.address.slice(0, 6)}…{t.address.slice(-4)}</span>}</nav>
      <div className="ptitle">
        <Avatar t={t} />
        <h1>{t.name ?? <span className="muted">{noName(t)}</span>}{t.symbol && <> <small className="muted">{t.symbol}</small></>}</h1>
        <span className="chip chip-kind">{t.standard}</span>
        {contract && <span className={`chip ${contract.verified ? "chip-final" : "chip-kind"}`}>{contract.verified && <Icon name="check" size={12} />}{contract.verified ? "Source code verified" : "Source code not verified"}</span>}
        {t.gatewayWrapped && <span className="chip chip-kind" title="The gateway made this wrapped token for a Canton token">From Canton</span>}
      </div>
      {t.metadataStatus !== "read" && (
        <aside className="card note" role="note"><p className="small">{t.metadataStatus === "failed" ? failedNote(t)
          : "The explorer has not read this token's name, symbol or decimals from the contract yet, so amounts are shown raw until it has."}</p></aside>
      )}
      <Cards t={t} />
      {t.canton && <CantonCustody t={t} canton={t.canton} />}
      <Holders t={t} />
      <Transfers t={t} />
      <Information t={t} />
      {t.derived === false && <p className="muted small">The explorer is still reading blocks, so the counts here may be short.</p>}
    </>
  );
}

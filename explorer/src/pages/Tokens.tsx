import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { getAllTokenTransfers, type AddressTransferItem, type TokenListItem, type TokenListPage, type TokenSort, type TokenStandard } from "../api.ts";
import { ago } from "../block-times.ts";
import { AddressCell } from "../components/AddressCell.tsx";
import { CardHead, ErrorCard, LoadingCard } from "../components/Cards.tsx";
import { Chip } from "../components/Chip.tsx";
import { HashLink } from "../components/HashLink.tsx";
import { Icon } from "../components/Icon.tsx";
import { NumberedPager } from "../components/Numbered.tsx";
import { count, duration, plural, short, units } from "../format.ts";
import { useLabels, type Labels } from "../labels.ts";
import { methodOf } from "../method.ts";
import { listPoll } from "../stats.ts";
import { useNow, useStatus } from "../useStatus.ts";
import { Avatar, Mint, noName, Supply, useTokenList } from "./TokenParts.tsx";
import "./token.css";

const PER = 25;
const FEED = 10;
const ZERO = "0x" + "00".repeat(20);
const SORTS: { id: TokenSort; label: string }[] = [{ id: "holders", label: "Holders" }, { id: "transfers", label: "Transfers" }, { id: "newest", label: "Newest" }];
type Tab = "all" | TokenStandard | "canton";
const TABS: { id: Tab; label: string }[] = [{ id: "all", label: "All" }, { id: "ERC-20", label: "ERC-20" }, { id: "ERC-721", label: "ERC-721" }, { id: "ERC-1155", label: "ERC-1155" }, { id: "canton", label: "From Canton" }];

function tabCount(id: Tab, d: TokenListPage | undefined): number | null {
  if (!d?.counts) return null;
  if (id === "canton") return d.gatewayCount;
  return id === "all" ? d.counts["ERC-20"] + d.counts["ERC-721"] + d.counts["ERC-1155"] : d.counts[id];
}

function Row({ t, n, now }: { t: TokenListItem; n: number; now: number }) {
  const to = `/token/${t.address}`;
  return (
    <tr>
      <td className="muted">{n}</td>
      <td>
        <div className="tok-cell">
          <Avatar t={t} />
          <div className="tok-id">
            <div>
              {t.name ? <Link to={to}>{t.name}</Link> : <span className="muted">{noName(t)}</span>}
              {t.symbol && <span className="muted tok-sym">{t.symbol}</span>}
              {t.verified && <span className="verified" role="img" aria-label="Verified" title="Its source code is verified"><Icon name="check" size={13} /></span>}
              {t.gatewayWrapped && <span className="chip chip-kind" title="The gateway made this wrapped token for a Canton token">From Canton</span>}
            </div>
            <HashLink value={t.address} to={t.name ? undefined : to} plain lead={10} tail={6} />
          </div>
        </div>
      </td>
      <td><span className="chip chip-kind">{t.standard}</span></td>
      <td className="r"><Supply t={t} /></td>
      <td className="r"><span className="num">{count(t.holderCount)}</span></td>
      <td className="r"><span className="num">{count(t.transferCount)}</span></td>
      <td>
        {t.creationBlock === null ? <span className="muted" title="A contract of the genesis state, which no transaction made">Genesis state</span> : (
          <><Link className="num" to={`/block/${t.creationBlock}`}>Block {t.creationBlock}</Link>{t.createdAt && <div className="small muted">{ago(t.createdAt, now)}</div>}</>
        )}
      </td>
      <td>{t.creator ? <HashLink value={t.creator} to={`/address/${t.creator}`} plain lead={8} tail={4} /> : <span className="muted">—</span>}</td>
    </tr>
  );
}

function listLabel(shown: number, from: number, total: number | undefined, derived: boolean | undefined): string {
  if (shown === 0) return derived === false ? "The explorer has not read this far yet." : "No tokens yet.";
  if (total === undefined || total <= shown) return `Showing all ${plural(shown, "token")}`;
  return `Showing ${count(from + 1)}–${count(from + shown)} of ${count(total)} tokens`;
}

/** What moved, in the token's own units: whole tokens where its decimals are known, the raw count (and said so) where they are not, `#id` for an NFT. */
function Moved({ x, labels }: { x: AddressTransferItem; labels: Labels }) {
  if (x.tokenId !== null) return <span className="num">{x.amount !== null && x.amount !== "1" ? `${count(x.amount)} × ` : ""}#{x.tokenId.length > 12 ? short(x.tokenId, 6, 4) : x.tokenId}</span>;
  if (x.amount === null) return <span className="muted" title="The amount is not in the logs">—</span>;
  const decimals = labels.get(x.token)?.decimals ?? null;
  return decimals === null ? <span className="num" title="The token's decimals are not known, so this is the raw amount">{count(x.amount)}</span> : <span className="num" title={`${x.amount} in the token's smallest unit`}>{units(x.amount, decimals)}</span>;
}

function FeedRow({ x, now, labels }: { x: AddressTransferItem; now: number; labels: Labels }) {
  return (
    <tr>
      <td><HashLink value={x.txHash} to={`/tx/${x.txHash}`} plain lead={10} tail={6} /></td>
      <td><span className="tag method">{methodOf({ methodId: x.methodId, to: x.creation ? null : x.to, created: x.creation ? x.token : null, value: "0" })}</span></td>
      <td><Link className="num" to={`/block/${x.block}`}>{x.block}</Link></td>
      <td title={new Date(x.timestamp * 1000).toISOString()}>{duration(now - x.timestamp * 1000)} ago</td>
      <td><Mint address={x.from} labels={labels} />{x.from === ZERO && <span className="tag">mint</span>}</td>
      <td className="arrow muted" aria-hidden="true">→</td>
      <td><Mint address={x.to} labels={labels} />{x.to === ZERO && <span className="tag">burn</span>}</td>
      <td className="r"><Moved x={x} labels={labels} /></td>
      <td><AddressCell address={x.token} label={labels.get(x.token)} to={`/token/${x.token}`} /></td>
      <td><Chip status="final" /></td>
    </tr>
  );
}

const FEED_FILTERS: { id: TokenStandard | "all"; label: string }[] = [{ id: "all", label: "All" }, { id: "ERC-20", label: "ERC-20" }, { id: "ERC-721", label: "ERC-721" }];

/** The newest token transfers of every token, from the Transfer logs of final blocks. */
function Feed({ now }: { now: number }) {
  const [only, setOnly] = useState<TokenStandard | "all">("all");
  const q = useQuery({ queryKey: ["token-feed", only], queryFn: () => getAllTokenTransfers(null, FEED, only === "all" ? undefined : only), refetchInterval: listPoll(false) });
  const items = q.data?.items;
  const labels = useLabels((items ?? []).flatMap((x) => [x.from, x.to, x.token]));
  return (
    <section className="card panel" aria-label="Latest token transfers">
      <CardHead title="Latest token transfers" sub={`${only === "all" ? "all tokens" : `${only} tokens`}, newest first`}
        action={<div className="seg" role="group" aria-label="Show token transfers">{FEED_FILTERS.map((f) => <button key={f.id} type="button" aria-pressed={only === f.id} onClick={() => setOnly(f.id)}>{f.label}</button>)}</div>} />
      {q.error && !items ? <p className="muted small card-note">{q.error.message}</p> : !items ? <p className="muted small card-note">Reading the transfers…</p> : items.length === 0 ? (
        <p className="muted card-note">{q.data?.derived === false ? "The explorer has not read this far yet, so this list is not known to be empty." : "No token transfers yet."}</p>
      ) : (
        <div className="scroll">
          <table className="tbl" aria-label="Latest token transfers">
            <thead><tr><th>Transaction</th><th>Method</th><th>Block</th><th>Age</th><th>From</th><th aria-hidden="true" /><th>To</th><th className="r">Amount</th><th>Token</th><th>Stage</th></tr></thead>
            <tbody>{items.map((x) => <FeedRow key={`${x.txHash}-${x.logIndex}-${x.batchIndex}`} x={x} now={now} labels={labels} />)}</tbody>
          </table>
        </div>
      )}
      <p className="muted small card-note">Read from the Transfer logs of final blocks. A transfer in a block that is not final yet is not listed here, so a row never changes.</p>
    </section>
  );
}

/** Every token the explorer has seen move, by standard, and the newest token transfers. */
export function Tokens() {
  const [tab, setTab] = useState<Tab>("all");
  const [sort, setSort] = useState<TokenSort>("holders");
  const now = useNow();
  const st = useStatus().data;
  const p = useTokenList({ sort, standard: tab === "all" || tab === "canton" ? undefined : tab, gateway: tab === "canton" }, PER, listPoll(false));
  const d = p.data;
  const all = tabCount("all", d);
  const chain = st?.chainName;
  const asOf = d?.derived === false ? "the explorer is still reading blocks" : st?.deriveCursor != null ? `counts as of final block ${st.deriveCursor}` : null;
  return (
    <>
      <div className="ptitle">
        <h1>Tokens</h1>
        {all !== null && <span className="muted">{[plural(all, "token"), asOf].filter(Boolean).join(" · ")}</span>}
        <span className="grow" />
        <div className="seg" role="group" aria-label="Show tokens">
          {TABS.map((t) => { const n = tabCount(t.id, d); return <button key={t.id} type="button" aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>{t.label}{n !== null && <> <span className="num">{count(n)}</span></>}</button>; })}
        </div>
        <div className="seg" role="group" aria-label="Sort tokens by">
          {SORTS.map((s) => <button key={s.id} type="button" aria-pressed={sort === s.id} onClick={() => setSort(s.id)}>{s.label}</button>)}
        </div>
      </div>
      {p.error && !p.items ? <ErrorCard message={p.error.message} retrying /> : !p.items ? <LoadingCard>Reading the tokens…</LoadingCard> : (
        <section className="card" aria-label="Tokens">
          <div className="list-h"><span className="muted">{listLabel(p.items.length, p.from, d?.total, d?.derived)}</span><NumberedPager p={p} label="Pages of tokens" always /></div>
          {p.items.length > 0 && (
            <div className="scroll">
              <table className="tbl" aria-label="Tokens">
                <thead><tr><th>#</th><th>Token</th><th>Standard</th><th className="r">Total supply</th><th className="r">Holders</th><th className="r">Transfers</th><th>Created</th><th>Creator</th></tr></thead>
                <tbody>{p.items.map((t, i) => <Row key={t.address} t={t} n={p.from + i + 1} now={now} />)}</tbody>
              </table>
            </div>
          )}
          <p className="muted small">Holders, transfers and supply are the explorer's copy, read from the Transfer logs of final blocks and the contract. A token with no name here did not answer, and is still listed.</p>
          {d?.derived === false && <p className="muted small">The explorer is still reading blocks, so this list may be missing the newest tokens and their counts.</p>}
        </section>
      )}
      <Feed now={now} />
      <div className="tok-notes">
        <div className="legs" role="note">
          <Icon name="info" size={14} />
          <span><b>From Canton.</b> The gateway makes a wrapped ERC-20 for a Canton token, with 10 decimals like a Canton amount, and mints it only in a block whose Canton side settled the deposit. {d && d.gatewayCount > 0 ? `${count(d.gatewayCount)} ${d.gatewayCount === 1 ? "has" : "have"} been made on this chain; they are listed under From Canton.` : "None has been made on this chain yet; when one is, it is listed under From Canton with its gateway."}</span>
        </div>
        <div className="legs" role="note">
          <Icon name="lock" size={14} />
          <span><b>What a token page shows.</b> Holders and transfers on {chain ?? "this chain"}, read from final blocks. A token's Canton holdings stay private to their parties, so they are never shown here.</span>
        </div>
      </div>
    </>
  );
}

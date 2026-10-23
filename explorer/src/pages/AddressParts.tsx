import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { getAddressTxs, getFaucetAddress, getHoldings, type AddressDetail, type ApiStatus, type Holding, type Label } from "../api.ts";
import { AddressCell } from "../components/AddressCell.tsx";
import { Amount } from "../components/Amount.tsx";
import { CardHead } from "../components/Cards.tsx";
import { HashLink } from "../components/HashLink.tsx";
import { Item, Kv } from "../components/Kv.tsx";
import { Pager, usePaged } from "../components/Pager.tsx";
import { count, duration, exact, units } from "../format.ts";
import { useLabels, type Labels } from "../labels.ts";
import { useNow, useStatus } from "../useStatus.ts";
import { NftCount } from "./TokenParts.tsx";

const Dash = () => <span className="muted">—</span>;

/** The chip under the title: how many contracts the address made, "100,000+" when the count stopped at its ceiling. Nothing when it made none. */
export function CreatedChip({ a, to }: { a: AddressDetail; to: string }) {
  if (!(a.createdCount > 0)) return null;
  const n = `${count(a.createdCount)}${a.createdCountCapped ? "+" : ""}`;
  return <Link className="chip chip-made" to={to} title="The contracts this address made">Created {n} {a.createdCount === 1 && !a.createdCountCapped ? "contract" : "contracts"}</Link>;
}

/** An address by its name or short address; the faucet by its name. */
export function Who({ address, faucet, chain, labels }: { address: string; faucet: string | null | undefined; chain: string; labels: Labels }) {
  const named = !!faucet && faucet.toLowerCase() === address.toLowerCase();
  return named ? <Link className="hx" to={`/address/${address}`} title={address}>{chain} faucet</Link> : <AddressCell address={address} label={labels.get(address)} />;
}

/** A holder's share of a token's supply as a percent cut to two places ("99.50%"); null when the supply is not known, or is smaller than the value (a stale supply). */
export function shareOf(value: string, supply: string | null): string | null {
  if (supply === null) return null;
  const v = BigInt(value), s = BigInt(supply);
  if (s === 0n || v > s) return null;
  const bp = (v * 10000n) / s;
  if (bp === 0n) return v === 0n ? "0%" : "<0.01%";
  return bp === 10000n ? "100%" : `${bp / 100n}.${String(bp % 100n).padStart(2, "0")}%`;
}

/**
 * What a holding is worth in its own units: the amount with its symbol when the decimals and the symbol are known, in whole units with the exact amount in the title
 * when only the decimals are, and the raw count (with the note that its decimals are not known) when they are not. An NFT is a count; ERC-1155 values are grouped.
 */
export function HoldingAmount({ h }: { h: Holding }) {
  if (h.standard === "ERC-721") return <NftCount n={h.value} />;
  if (h.standard === "ERC-1155") return <span className="num">{count(h.value)}</span>;
  if (h.decimals !== null && h.symbol) return <Amount raw={h.value} decimals={h.decimals} symbol={h.symbol} />;
  if (h.decimals !== null) return <span className="num" title={exact(h.value, h.decimals)}>{units(h.value, h.decimals)}</span>;
  return <span className="num" title="The token's decimals are not known, so this is the raw value">{count(h.value)}</span>;
}

const asLabel = (h: Holding): Label => ({ address: h.token, name: h.name, symbol: h.symbol, kind: "token", standard: h.standard, decimals: h.decimals, verified: false });

function HoldingRow({ h, labels }: { h: Holding; labels: Labels }) {
  const name = h.name ?? h.symbol;
  const known = labels.get(h.token);
  const share = h.standard === "ERC-20" ? shareOf(h.value, h.totalSupply) : null;
  return (
    <div className="hold">
      <div className="hold-main">
        {name ? <Link className="hold-name" to={`/token/${h.token}`} title={name}><bdi>{name}</bdi></Link> : <HashLink value={h.token} to={`/token/${h.token}`} />}
        {h.symbol && h.name && h.symbol !== h.name && <> <bdi className="muted small hold-sym" title={h.symbol}>{h.symbol}</bdi></>}
        <div className="muted small hold-line">{h.standard}{h.standard === "ERC-1155" && <> · <bdi className="hold-id" title={`#${h.tokenId}`}>#{h.tokenId}</bdi></>} · <AddressCell address={h.token} label={known?.kind === "token" ? known : asLabel(h)} to={`/token/${h.token}`} /></div>
      </div>
      <div className="r hold-amt" title={`Last moved in block ${h.updatedBlock}`}>
        <HoldingAmount h={h} />
        {share && <div className="muted small">{share} of supply</div>}
      </div>
    </div>
  );
}

/** What the address holds, token by token. The list is the explorer's, derived from final blocks up to the block in the header, so while it is behind it says it may be short. */
export function Holdings({ addr }: { addr: string }) {
  const st = useStatus().data;
  const p = usePaged(["address-tokens", addr], (after) => getHoldings(addr, after), 5000);
  const d = p.data;
  const labels = useLabels(d?.items.map((h) => h.token) ?? []);
  const tokens = d ? new Set(d.items.map((h) => h.token)).size : 0;
  const atLeast = !!d && (p.hasPrev || p.hasNext || d.derived === false);
  return (
    <section className="card" aria-label="Token holdings">
      <CardHead as="h2" title="Token holdings" sub={st?.deriveCursor != null ? `as of block ${st.deriveCursor}` : undefined} action={d && tokens > 0 ? <span className="chip chip-kind chip-count">{count(tokens)}{atLeast ? "+" : ""} {tokens === 1 && !atLeast ? "token" : "tokens"}</span> : undefined} />
      {p.error && !d ? <p className="muted">{p.error.message}</p> : !d ? <p className="muted">Reading the token holdings…</p> : (
        <>
          {d.items.map((h) => <HoldingRow key={`${h.token}-${h.tokenId}`} h={h} labels={labels} />)}
          {d.items.length === 0 && d.derived !== false && <p className="muted">This address holds no tokens.</p>}
          {d.derived === false && <p className="small muted">The explorer is still reading blocks, so this list may be missing tokens.</p>}
          <Pager p={p} label="Pages of token holdings" />
        </>
      )}
    </section>
  );
}

const Ago = ({ ts, now }: { ts: number | null; now: number }) => (ts == null ? null : <span className="muted small" title={new Date(ts * 1000).toISOString()}> · {duration(now - ts * 1000)} ago</span>);

/** When it last sent a transaction: read from its newest sent one, as "last active" counts what it received too. */
function LastSent({ a, now }: { a: AddressDetail; now: number }) {
  const q = useQuery({ queryKey: ["address-last-sent", a.address], queryFn: () => getAddressTxs(a.address, null, 1, "sent"), enabled: a.sentCount > 0 || !a.derived, refetchInterval: 5000, retry: false });
  const t = q.data?.items[0];
  if (!t && a.sentCount === 0 && a.derived) return <span className="muted">never</span>;
  // The sent list is read from final blocks, so a loaded answer with no row is an answer; only the counters lag.
  if (!t) return q.error ? <span className="muted">Not known</span> : q.data ? <span className="muted" title="The explorer is still reading blocks">{a.derived ? "Not known" : "none counted yet"}</span> : <span className="muted">…</span>;
  return <><Link className="num" to={`/block/${t.block}`}>Block {t.block}</Link><Ago ts={t.timestamp} now={now} /></>;
}

export function More({ a, st }: { a: AddressDetail; st: ApiStatus | undefined }) {
  const now = useNow();
  const faucet = useQuery({ queryKey: ["faucet-address"], queryFn: getFaucetAddress, staleTime: 60_000, retry: false }).data;
  const f = a.fundedBy;
  const labels = useLabels([f?.from]);
  return (
    <section className="card" aria-label="More information">
      <CardHead as="h2" title="More information" />
      <Kv wide>
        <Item label="Transactions sent"><span className="num">{count(a.sentCount)}</span></Item>
        <Item label="Transactions received"><span className="num">{count(a.receivedCount)}</span></Item>
        <Item label="Funded by">
          {f ? <><Who address={f.from} faucet={faucet} chain={st?.chainName ?? ""} labels={labels} /> <span className="muted">in</span> <Link className="num" to={`/block/${f.block}`}>block {f.block}</Link> <span className="muted">·</span> <HashLink value={f.txHash} to={`/tx/${f.txHash}`} plain /></>
            : <span className="muted" title="No transaction that sent it its first coin is held, or a token transfer reached it first">not known</span>}
        </Item>
        <Item label="First seen">{a.firstSeenBlock === null ? <Dash /> : <><Link className="num" to={`/block/${a.firstSeenBlock}`}>Block {a.firstSeenBlock}</Link><Ago ts={a.firstSeenTimestamp} now={now} /></>}</Item>
        <Item label="Last sent"><LastSent a={a} now={now} /></Item>
      </Kv>
      {!a.derived && <p className="small muted card-note">The explorer is still reading blocks, so these counts may be short.</p>}
    </section>
  );
}

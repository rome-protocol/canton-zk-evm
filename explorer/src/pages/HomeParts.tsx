import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { ApiTx, BlockListItem, InFlightTx, StatsSeries, StatsSpread, StatsSummary, TokenMove, TxListItem } from "../api.ts";
import { AddressCell } from "../components/AddressCell.tsx";
import { Amount, TokenChip } from "../components/Amount.tsx";
import { Chip } from "../components/Chip.tsx";
import { Icon } from "../components/Icon.tsx";
import { Spark } from "../components/Spark.tsx";
import { Info } from "../components/Info.tsx";
import { HashLink } from "../components/HashLink.tsx";
import { SearchBox } from "../components/SearchBox.tsx";
import { compactCount, count, duration, pct, peakCount, plural, rateShort, sec, span, trim } from "../format.ts";
import { useLabels, type Labels } from "../labels.ts";
import type { Fetched, Read, Summary } from "../stats.ts";
import { useNow } from "../useStatus.ts";

/** What the home page says it is, with a search box of its own and a few things to try, which are the newest the explorer holds. */
/** `words`: the label is the contract's own text (a token symbol), so it is set apart, cut short by the style, and whole in the tooltip. */
export function Hero({ tries }: { tries: Array<{ label: string; q: string; words?: boolean }> }) {
  return (
    <section className="card hero" aria-labelledby="hero-h">
      <h1 id="hero-h">Ostia block explorer</h1>
      <p>An EVM chain on Canton: every block proven, then final on Canton.</p>
      <SearchBox hero />
      {tries.length > 0 && (
        <div className="try"><span>Try</span>{tries.map((t) => <Link key={t.q} className="mono" to={`/search?q=${encodeURIComponent(t.q)}`} title={t.words ? t.label : undefined}>{t.words ? <bdi className="tname">{t.label}</bdi> : t.label}</Link>)}</div>
      )}
    </section>
  );
}

/** The final transactions since launch in short, with the blocks of the day; "total not counted yet" when the server cannot say, never 0. */
export const SinceLaunch = ({ t, blocks }: { t: StatsSummary["txs"]["allTime"]; blocks: number }) =>
  t ? <>{compactCount(t.total)} since launch · {plural(blocks, "block")}</> : <>total not counted yet · {plural(blocks, "block")}</>;
/** What the "i" of the day's transactions says: the count of all time and the block it stands at, the test runs in it, and that each block is one Canton transaction. */
export const SinceLaunchNote = ({ t, blocks }: { t: StatsSummary["txs"]["allTime"]; blocks: number }) =>
  <>{t ? `${count(t.total)} final in all, as of block ${t.asOfBlock}; runs marked as tests are counted. ` : ""}{`In ${plural(blocks, "block")}, each one Canton transaction.`}</>;

type IconName = Parameters<typeof Icon>[0]["name"];
/** The picture before each card's label, as screen 01 has it. It is decoration: the label says what the card is. */
const Key = ({ icon, children, info, about }: { icon: IconName; children: ReactNode; info?: ReactNode; about?: string }) => <span className="stat-k"><Icon name={icon} size={14} /><span>{children}</span>{info && <Info about={about ?? ""}>{info}</Info>}</span>;

/** A card: its title, its number and one short line (`foot`); what else there is to say goes behind the "i" (`info`). */
export function Stat({ icon, label, note, children, foot, sub, tone, info, valueClass }: { icon: IconName; label: string; note?: string; children: ReactNode; foot?: ReactNode; sub?: ReactNode; tone?: "ok"; info?: ReactNode; valueClass?: string }) {
  return (
    <div className={`card stat${tone ? ` stat-${tone}` : ""}`}>
      <Key icon={icon} info={info} about={label}>{label}{note && <span className="faint"> · {note}</span>}</Key>
      <span className={`stat-v num${valueClass ? ` ${valueClass}` : ""}`}>{children}</span>
      {sub}
      {foot ? <span className="muted small">{foot}</span> : null}
    </div>
  );
}

/** What is not final yet. Unknown is shown as unknown: a dash while the route is read or cannot be, and no waiting count with no sample of the pool. */
function NotFinal({ n, read, stuck }: { n: Summary["notFinal"]; read: Read; stuck: number | null }) {
  if (!n) return <Stat icon="clock" label="Not final yet" foot={read === "loading" ? "Reading…" : "what is in flight cannot be read right now"}>—</Stat>;
  // "Stuck" is the stats' own count of transactions waiting past the time they are given; where the stats are unread, nothing is said of it.
  return <Stat icon="clock" label="Not final yet" info={`${n.inBlocks} in blocks being made or proven, and the rest waiting in the pool for the next block.`} foot={`${n.waiting === null ? "pool count not known" : `${n.waiting} waiting`}${stuck === null ? "" : ` · ${count(stuck)} stuck`}`}>{n.waiting === null ? n.inBlocks : n.inBlocks + n.waiting}</Stat>;
}

export const DASH_WHY = (read: Read) => (read === "loading" ? "Reading…" : "the stats cannot be read right now");
/** "09:18 UTC", with a no-break space so the time and "UTC" never part across two lines. */
const ago = (iso: string) => `${iso.slice(11, 16)}\u00a0UTC`;

/** A time from a summary: the middle and the 95th percentile, "8.5 s p95 8.7 s", or a dash and why. */
export function Time({ icon, label, note, s, read, foot, none, info }: { icon: IconName; label: string; note: string; s: StatsSpread | null | undefined; read: Read; foot: string; none: string; info?: ReactNode }) {
  if (s === undefined) return <Stat icon={icon} label={label} note={note} info={info} foot={DASH_WHY(read)}>—</Stat>;
  return <Stat icon={icon} label={label} note={note} info={info} foot={s ? foot : none}>{s ? <><span className="hl">{sec(s.median)}</span> <small className="hl">p95 {sec(s.p95)}</small></> : "—"}</Stat>;
}

/**
 * The cards of screen 01 in its order. The height and what is not final come from the status and the in-flight route; every other number from the
 * stats routes: the times of the last hour, the rate, transactions, lost ones and success of the last 24 hours, and the median time to final by the
 * hour over 72. A number the stats cannot give is a dash and says so; none is made up.
 */
export function Stats({ summary: s, flight = "ok", hour, day, spark }: { summary: Summary; flight?: Read; hour: Fetched<StatsSummary>; day: Fetched<StatsSummary>; spark: Fetched<StatsSeries> }) {
  const h = hour.data, d = day.data;
  const hr = (v: StatsSpread | null | undefined) => (h ? v ?? null : undefined);
  const points = spark.data ? spark.data.points.filter((p) => Date.parse(p.at) >= Date.parse(spark.data!.to) - 72 * 3_600_000) : null;
  const noDay = DASH_WHY(day.read);
  const peak = d && d.tps.peak !== null && d.txs.count > 0 ? d.tps : null;
  return (
    <section className="stats" aria-label="Numbers">
      <Stat icon="cube" label="Block height" info="The newest block that is final on Canton." foot={s.height === null ? "No final block yet." : s.proving !== null ? `${s.proving} being proven` : "final on Canton"}>{s.height ?? "—"}</Stat>
      <Time icon="clock" label="Time to final" note="last hour" s={hr(h?.timeToFinal)} read={hour.read} info={`From a transaction being accepted to its block being final on Canton, over ${plural(h?.timeToFinal?.samples ?? 0, "transaction")}. p95 is the time that 95 in 100 stay under.`} foot="accepted → final" none="no transaction in the last hour" />
      <Time icon="shield" label="Proof time" note="last hour" s={hr(h?.proofTime)} read={hour.read} info={`Proved with ZisK, ${plural(h?.proofTime?.samples ?? 0, "block")} in the last hour.`} foot="one proof per block" none="no block in the last hour" />
      <Time icon="link" label="Canton commit time" note="last hour" s={hr(h?.commitTime)} read={hour.read} info="From the block being sent to Canton to Canton's record time." foot="sent → recorded" none="no block in the last hour" />
      {d ? (
        <Stat icon="bolt" label="Transactions per second" info={peak ? `Peak is the busiest minute in 24 h${peak.peak! < 1 ? ` (${peakCount(peak.peak!)})` : ""}, at ${ago(peak.peakAt!)}.` : undefined} foot={peak ? undefined : "no transaction in 24 h"}>{trim(d.tps.now, 2)} <small>now</small>{peak && <> <small className="hl stat-peak"><b>peak {rateShort(peak.peak!)}</b> ({ago(peak.peakAt!)})</small></>}</Stat>
      ) : <Stat icon="bolt" label="Transactions per second" foot={noDay}>—</Stat>}
      {d ? (
        <Stat icon="doc" label="Transactions" note="24 h" info={<SinceLaunchNote t={d.txs.allTime} blocks={d.blocks.count} />} foot={<SinceLaunch t={d.txs.allTime} blocks={d.blocks.count} />}>{count(d.txs.count)}</Stat>
      ) : <Stat icon="doc" label="Transactions" note="24 h" foot={noDay}>—</Stat>}
      <NotFinal n={s.notFinal} read={flight} stuck={(hour.data ?? day.data)?.acceptedNotFinal.stuck ?? null} />
      {d ? (
        <Stat icon="shield" label="Lost transactions" tone={d.lost.total ? undefined : "ok"} valueClass={d.lost.total ? "bad" : "ok"} info={d.lost.total ? "Accepted by Ostia and never made final. Stats lists each with its reason." : "Accepted by Ostia and never made final. Any such transaction would be listed here with its reason."} foot={d.lost.total ? <Link to="/stats">each with its reason</Link> : "none lost"}>
          {count(d.lost.total)}
        </Stat>
      ) : <Stat icon="shield" label="Lost transactions" foot={noDay}>—</Stat>}
      {d ? (
        <Stat icon="check" label="Success rate" note="24 h, RPC and faucet" info={d.txs.successRate === null ? undefined : `${count(d.txs.acceptedFinal + d.txs.lost + d.txs.droppedByChain)} accepted and settled in 24 h; each is final, lost or dropped by the chain.`} foot={d.txs.successRate === null ? "no accepted transaction settled in 24 h" : `${count(d.txs.lost)} lost · ${count(d.txs.droppedByChain)} dropped`}>{d.txs.successRate === null ? "—" : pct(d.txs.successRate)}</Stat>
      ) : <Stat icon="check" label="Success rate" note="24 h" foot={noDay}>—</Stat>}
      <Stat icon="activity" label="Time to final" note="72 h" info={points ? "Median per hour; gaps are hours with no blocks." : undefined} foot={points ? undefined : DASH_WHY(spark.read)}>
        {points ? <Spark points={points} label="Median time to final for each hour of the last 72 hours" /> : "—"}
      </Stat>
    </section>
  );
}

const Foot = ({ to, children }: { to: string; children: string }) => <div className="tbl-foot"><Link to={to}>{children} →</Link></div>;

/** The newest final blocks, each with the time Canton took to commit it. */
export function LatestBlocks({ blocks, error }: { blocks: BlockListItem[] | undefined; error?: string }) {
  const now = useNow();
  return (
    <section className="card panel" aria-labelledby="latest-h">
      <div className="sec-h"><h3 id="latest-h">Latest final blocks</h3><Info about="the latest final blocks">Each block is one Canton transaction.</Info></div>
      {error ? <p className="muted">{error}</p> : !blocks ? <p className="muted">Reading the blocks…</p> : blocks.length ? (
        <>
          <div className="scroll">
            <table className="tbl">
              <thead><tr><th>Block</th><th className="r">Txs</th><th className="r">Time to final</th><th>Canton update</th><th>Stage</th></tr></thead>
              <tbody>
                {blocks.map((b) => (
                  <tr key={b.number}>
                    <td><span className="idcell blk"><Icon name="cube" size={14} /><span><Link className="num" to={`/block/${b.number}`}>{b.number}</Link><span className="ago">{duration(now - b.timestamp * 1000)} ago</span></span></span></td>
                    <td className="r">{count(b.txCount)}</td>
                    <td className="r" title="from the producer's cut to Canton's record time">{b.finalSeconds === null ? <span className="muted">—</span> : span(b.finalSeconds)}</td>
                    <td><HashLink value={b.updateId} kind="update" to={`/canton/${b.updateId}`} plain lead={8} tail={4} /></td>
                    <td><Chip status="final" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Foot to="/blocks">View all blocks</Foot>
        </>
      ) : <p className="muted">No final blocks yet.</p>}
    </section>
  );
}

/** What is known of a transaction that is not final yet: its details from the transaction route, or that they are being read or cannot be. */
export type Details = ApiTx | "reading" | "error";

/** Who sent a transaction and to whom: the faucet by its name, a contract or token by its name, anything else by its short address; a creation names what it made. */
function Parties({ from, to, created, labels, faucet, chain }: { from: string; to: string | null; created: string | null; labels: Labels; faucet?: string | null; chain?: string }) {
  const named = !!faucet && faucet.toLowerCase() === from.toLowerCase();
  return (
    <>
      <span className="who">{named ? <Link className="hx" to={`/address/${from}`} title={from}>{chain ?? "Ostia"} faucet</Link> : <AddressCell address={from} label={labels.get(from)} />}</span>
      {to ? <span className="who muted">to <AddressCell address={to} label={labels.get(to)} /></span> : created ? <span className="who muted">Create: <AddressCell address={created} label={labels.get(created)} /></span> : null}
    </>
  );
}

/** What a final transaction moved: the first token move as a chip (with how many more there are), and the coin when any was sent. */
export function Moved({ t, coin, labels, compact = false }: { t: TxListItem; coin: { symbol: string; decimals: number }; labels: Labels; compact?: boolean }) {
  const first = t.tokenMoves?.first ?? null, more = t.tokenMoves ? t.tokenMoves.count - 1 : 0;
  const sent = BigInt(t.value) > 0n;
  if (!first) return <Amount raw={t.value} decimals={coin.decimals} symbol={coin.symbol} compact={compact} />;
  return (
    <span className="moved">
      <TokenChip move={first} label={labels.get(first.token)} compact={compact} />
      {more > 0 && <span className="muted small" title={`${more}${t.tokenMoves!.more ? " or more" : ""} more token moves in this transaction`}>+{more}{t.tokenMoves!.more ? "+" : ""}</span>}
      {sent && <Amount raw={t.value} decimals={coin.decimals} symbol={coin.symbol} compact={compact} />}
    </span>
  );
}

/** The first topic of an ERC-20 or ERC-721 Transfer. */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * The first Transfer in a receipt's logs as a move, with the shapes the indexer takes (server `decodeTransfers`): three topics and exactly one 32-byte data word is an
 * ERC-20 (the amount is the data), four topics and no data is an NFT (the token id is the last topic). A log shaped otherwise is not a move and is skipped.
 * ERC-1155 moves (TransferSingle, TransferBatch) are not read here: they show once the block is final, when the index has them.
 */
function moveOfLogs(logs: ApiTx["logs"]): TokenMove | null {
  const l = logs.find((x) => x.topics[0]?.toLowerCase() === TRANSFER_TOPIC
    && ((x.topics.length === 3 && x.data.length === 66) || (x.topics.length === 4 && x.data === "0x")));
  if (!l) return null;
  try {
    if (l.topics.length === 4) return { token: l.address, amount: "1", tokenId: BigInt(l.topics[3]!).toString(), standard: "ERC-721", decimals: null };
    return { token: l.address, amount: BigInt(l.data).toString(), tokenId: null, standard: "ERC-20", decimals: null };
  } catch { return null; }
}

/** The token of a receipt's first Transfer, so a row can ask the labels route for its name even when the token is not the transaction's `to`. */
export const provingToken = (d: Pick<ApiTx, "logs">): string | undefined => moveOfLogs(d.logs)?.token;

/**
 * What a transaction that is not final yet moves, as far as its own page says. A transaction in a block being proven has reth's receipt: when it reverted nothing
 * moved, so it shows no chip and says so; otherwise the chip is built from the Transfer in the receipt's logs (an ERC-20 amount or an NFT id), as the final lists do.
 * A transaction still waiting has no receipt: when `to` is a known token and the input is a transfer, the transaction route decodes it (`transfer`), and that is
 * the chip. The coin is beside the chip when any is sent. `d.value` is not null (the caller checks).
 */
export function ProvingMoved({ d, coin, labels, compact = false }: { d: ApiTx & { value: string }; coin: { symbol: string; decimals: number }; labels: Labels; compact?: boolean }) {
  if (d.success === false) return <span className="muted" title="The transaction reverted, so it moved nothing">reverted</span>;
  const coinAmount = BigInt(d.value) > 0n && <Amount raw={d.value} decimals={coin.decimals} symbol={coin.symbol} compact={compact} />;
  if (d.success === true) {
    const m = moveOfLogs(d.logs);
    if (!m) return <Amount raw={d.value} decimals={coin.decimals} symbol={coin.symbol} compact={compact} />;
    const known = labels.get(m.token);
    // The transaction route read the symbol and decimals of the token it was sent to from the contract; they stand in for a token the index does not know yet.
    const own = d.transfer && d.to && d.to.toLowerCase() === m.token.toLowerCase() ? d.transfer : null;
    const label = known?.symbol || !own ? known : { address: m.token, name: known?.name ?? null, symbol: own.symbol, kind: known?.kind ?? "token" as const, standard: known?.standard ?? null, decimals: own.decimals, verified: known?.verified ?? false };
    return <span className="moved"><TokenChip move={{ ...m, decimals: own?.decimals ?? null }} label={label} compact={compact} />{coinAmount}</span>;
  }
  const t = d.transfer;
  if (!t || !d.to) return <Amount raw={d.value} decimals={coin.decimals} symbol={coin.symbol} compact={compact} />;
  const move = { token: d.to, amount: t.value, tokenId: null, standard: null, decimals: t.decimals };
  // The index may not know a token yet that was just made; its own symbol, as the transaction route read it from the contract, then stands in.
  const known = labels.get(d.to);
  const label = known?.symbol ? known : { address: d.to, name: known?.name ?? null, symbol: t.symbol, kind: known?.kind ?? "token" as const, standard: known?.standard ?? null, decimals: t.decimals, verified: known?.verified ?? false };
  return <span className="moved"><TokenChip move={move} label={label} compact={compact} />{coinAmount}</span>;
}

/** The cell of a transaction: its icon, its hash cut as the screen cuts it (8 and 4), and how long ago. */
const TxCell = ({ hash, ago }: { hash: string; ago: string }) => (
  <td><span className="idcell"><Icon name="doc" size={14} /><span><HashLink value={hash} to={`/tx/${hash}`} plain lead={8} tail={4} /><span className="ago">{ago} ago</span></span></span></td>
);

/**
 * The newest transactions: those that are not final yet come first, each with the stage the journal gives it, then the final ones. A transaction
 * that is not final can still change, so what is shown of it is what reth holds; where that cannot be read, the row says so and keeps its stage.
 * Names and token moves come from the labels route, read once for the whole list; without them a row shows the short address and the coin.
 */
export function LatestTxs({ txs, coin, error, pending = [], pendingRead = "ok", details = {}, faucet = null, chain, perSecond = null }: {
  txs: TxListItem[] | undefined; coin: { symbol: string; decimals: number }; error?: string; pending?: InFlightTx[]; pendingRead?: Read; details?: Record<string, Details>; faucet?: string | null; chain?: string; perSecond?: number | null;
}) {
  const now = useNow();
  const waiting = pending.filter((p) => !txs?.some((t) => t.hash === p.hash));
  const final = txs ?? [];
  const labels = useLabels([
    ...final.flatMap((t) => [t.from, t.to, t.created, t.tokenMoves?.first?.token]),
    ...waiting.flatMap((p) => { const d = details[p.hash]; return typeof d === "object" ? [d.from, d.to, d.created, provingToken(d)] : []; }),
  ]);
  return (
    <section className="card panel" aria-labelledby="txs-h">
      <div className="sec-h"><h3 id="txs-h">Latest transactions</h3>{perSecond !== null && perSecond > 0 && <span className="muted small">the newest of ~{rateShort(perSecond)} per second</span>}<Info about="the latest transactions">Including those not final yet.</Info></div>
      {pendingRead === "error" && <p className="muted small">Transactions not final yet cannot be read right now.</p>}
      {waiting.length || final.length ? (
        <>
          <div className="scroll">
            <table className="tbl home-txs">
              <colgroup><col className="c-tx" /><col className="c-who" /><col className="c-val" /><col className="c-stage" /></colgroup>
              <thead><tr><th>Transaction</th><th>From / to</th><th className="r">Value</th><th>Stage</th></tr></thead>
              <tbody>
                {waiting.map((p) => {
                  const d = details[p.hash] ?? "reading";
                  return (
                    <tr key={p.hash}>
                      <TxCell hash={p.hash} ago={duration(now - Date.parse(p.at))} />
                      <td className="small who-cell">{d === "reading" ? <span className="muted" title="reading…">reading…</span> : d === "error" ? <span className="muted" title="cannot be read right now">cannot be read right now</span> : <Parties from={d.from} to={d.to} created={d.created} labels={labels} faucet={faucet} chain={chain} />}</td>
                      <td className="r val-cell">{typeof d === "object" && d.value !== null ? <ProvingMoved d={{ ...d, value: d.value }} coin={coin} labels={labels} compact /> : <span className="muted">—</span>}</td>
                      <td><Chip status={p.stage} /></td>
                    </tr>
                  );
                })}
                {final.map((t) => (
                  <tr key={t.hash}>
                    <TxCell hash={t.hash} ago={duration(now - t.timestamp * 1000)} />
                    <td className="small who-cell"><Parties from={t.from} to={t.to} created={t.created} labels={labels} faucet={faucet} chain={chain} /></td>
                    <td className="r val-cell"><Moved t={t} coin={coin} labels={labels} compact /></td>
                    <td><Chip status="final" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {error ? <p className="muted">{error}</p> : !txs ? <p className="muted">Reading the transactions…</p> : !txs.length && <p className="muted">No final transactions yet.</p>}
          {final.length > 0 && <Foot to="/txs">View all transactions</Foot>}
        </>
      ) : error ? <p className="muted">{error}</p> : !txs ? <p className="muted">Reading the transactions…</p> : <p className="muted">No final transactions yet.</p>}
    </section>
  );
}

/** One link to the page that says what the explorer shows and what it does not, and why. */
export function LockBanner() {
  return (
    <section className="lock-banner" aria-label="About this explorer">
      <Icon name="lock" size={15} />
      <p><Link to="/about">What this explorer shows →</Link></p>
    </section>
  );
}

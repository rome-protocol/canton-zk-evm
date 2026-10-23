import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { ApiTx, BlockListItem, InFlightTx, StatsSeries, StatsSpread, StatsSummary, TxListItem } from "../api.ts";
import { AddressCell } from "../components/AddressCell.tsx";
import { Amount, TokenChip } from "../components/Amount.tsx";
import { Chip } from "../components/Chip.tsx";
import { Icon } from "../components/Icon.tsx";
import { Spark } from "../components/Spark.tsx";
import { HashLink } from "../components/HashLink.tsx";
import { SearchBox } from "../components/SearchBox.tsx";
import { count, duration, pct, plural, sec, span, trim } from "../format.ts";
import { useLabels, type Labels } from "../labels.ts";
import type { Fetched, Read, Summary } from "../stats.ts";
import { useNow } from "../useStatus.ts";

/** What the home page says it is, with a search box of its own and a few things to try, which are the newest the explorer holds. */
export function Hero({ tries }: { tries: Array<{ label: string; q: string }> }) {
  return (
    <section className="card hero" aria-labelledby="hero-h">
      <h1 id="hero-h">Ostia block explorer</h1>
      <p>Ostia is an EVM chain on Canton. Every block is proven with ZisK and then committed to Canton as one transaction, so a transaction is final when its block is final on Canton.</p>
      <SearchBox hero />
      {tries.length > 0 && (
        <div className="try"><span>Try</span>{tries.map((t) => <Link key={t.q} className="mono" to={`/search?q=${encodeURIComponent(t.q)}`}>{t.label}</Link>)}</div>
      )}
    </section>
  );
}

/** The final transactions in all, all time, with the block the server counted to in plain sight; "not counted yet" when it cannot say, never 0. */
export const AllTime = ({ t }: { t: StatsSummary["txs"]["allTime"] }) =>
  t ? <span className="muted small" title={`All time, as of block ${t.asOfBlock}; runs marked as tests are counted`}>{count(t.total)} final in all · as of block {t.asOfBlock}<span> · test runs included</span></span> : <span className="muted small">total not counted yet</span>;

type IconName = Parameters<typeof Icon>[0]["name"];
/** The picture before each card's label, as screen 01 has it. It is decoration: the label says what the card is. */
const Key = ({ icon, children }: { icon: IconName; children: ReactNode }) => <span className="stat-k"><Icon name={icon} size={14} /><span>{children}</span></span>;

export function Stat({ icon, label, note, children, foot, sub, tone }: { icon: IconName; label: string; note?: string; children: ReactNode; foot: ReactNode; sub?: ReactNode; tone?: "ok" }) {
  return (
    <div className={`card stat${tone ? ` stat-${tone}` : ""}`}>
      <Key icon={icon}>{label}{note && <span className="faint"> · {note}</span>}</Key>
      <span className="stat-v num">{children}</span>
      {sub}
      <span className="muted small">{foot}</span>
    </div>
  );
}

/** What is not final yet. Unknown is shown as unknown: a dash while the route is read or cannot be, and no waiting count with no sample of the pool. */
function NotFinal({ n, read, stuck }: { n: Summary["notFinal"]; read: Read; stuck: number | null }) {
  if (!n) return <Stat icon="clock" label="Not final yet" foot={read === "loading" ? "Reading…" : "what is in flight cannot be read right now"}>—</Stat>;
  // "Stuck" is the stats' own count of transactions waiting past the time they are given; where the stats are unread, nothing is said of it.
  return <Stat icon="clock" label="Not final yet" foot={`${n.inBlocks} in blocks being made or proven · ${n.waiting === null ? "pool count not known" : `${n.waiting} waiting`}${stuck === null ? "" : ` · ${count(stuck)} stuck`}`}>{n.waiting === null ? n.inBlocks : n.inBlocks + n.waiting}</Stat>;
}

export const DASH_WHY = (read: Read) => (read === "loading" ? "Reading…" : "the stats cannot be read right now");
const ago = (iso: string) => `${iso.slice(11, 16)} UTC`;

/** A time from a summary: the middle and the 95th percentile, "8.5 s p95 8.7 s", or a dash and why. */
export function Time({ icon, label, note, s, read, foot, none }: { icon: IconName; label: string; note: string; s: StatsSpread | null | undefined; read: Read; foot: string; none: string }) {
  if (s === undefined) return <Stat icon={icon} label={label} note={note} foot={DASH_WHY(read)}>—</Stat>;
  return <Stat icon={icon} label={label} note={note} foot={s ? foot : none}>{s ? <>{sec(s.median)} <small>p95 {sec(s.p95)}</small></> : "—"}</Stat>;
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
      <Stat icon="cube" label="Block height" foot={s.height === null ? "No final block yet." : `final on Canton${s.proving !== null ? ` · block ${s.proving} is being proven` : ""}`}>{s.height ?? "—"}</Stat>
      <Time icon="clock" label="Time to final" note="last hour" s={hr(h?.timeToFinal)} read={hour.read} foot={`accepted to final on Canton, ${plural(h?.timeToFinal?.samples ?? 0, "transaction")}`} none="no transaction in the last hour" />
      <Time icon="shield" label="Proof time" note="last hour" s={hr(h?.proofTime)} read={hour.read} foot={`ZisK, one proof per block, ${plural(h?.proofTime?.samples ?? 0, "block")}`} none="no block in the last hour" />
      <Time icon="link" label="Canton commit time" note="last hour" s={hr(h?.commitTime)} read={hour.read} foot="sent to Canton's record time" none="no block in the last hour" />
      {d ? (
        <Stat icon="bolt" label="Transactions per second" foot={peak ? `peak: the busiest minute in 24 h, ${ago(peak.peakAt!)}` : "no transaction in 24 h"}>{trim(d.tps.now, 2)} <small>now{peak && <> <b>peak {trim(peak.peak!, 1)}</b></>}</small></Stat>
      ) : <Stat icon="bolt" label="Transactions per second" foot={noDay}>—</Stat>}
      {d ? (
        <Stat icon="doc" label="Transactions" note="24 h" sub={<AllTime t={d.txs.allTime} />} foot={`in ${plural(d.blocks.count, "block")}, each one Canton transaction`}>{count(d.txs.count)}</Stat>
      ) : <Stat icon="doc" label="Transactions" note="24 h" foot={noDay}>—</Stat>}
      <NotFinal n={s.notFinal} read={flight} stuck={(hour.data ?? day.data)?.acceptedNotFinal.stuck ?? null} />
      {d ? (
        <div className={`card stat${d.lost.total ? "" : " stat-ok"}`}>
          <Key icon="shield">Lost transactions</Key>
          <span className={`stat-v num ${d.lost.total ? "bad" : "ok"}`}>{count(d.lost.total)}</span>
          <span className="muted small">{d.lost.total ? <>Accepted by Ostia and never made final. <Link to="/stats">Stats</Link> lists each with its reason.</> : "Accepted by Ostia and never made final. Any such transaction would be listed here with its reason."}</span>
        </div>
      ) : <Stat icon="shield" label="Lost transactions" foot={noDay}>—</Stat>}
      {d ? (
        <Stat icon="check" label="Success rate" note="24 h" foot={d.txs.successRate === null ? "no transaction in 24 h" : `${count(d.txs.count - d.txs.failed)} of ${count(d.txs.count)} final transactions; ${count(d.txs.failed)} reverted`}>{d.txs.successRate === null ? "—" : pct(d.txs.successRate)}</Stat>
      ) : <Stat icon="check" label="Success rate" note="24 h" foot={noDay}>—</Stat>}
      <Stat icon="activity" label="Time to final" note="72 h" foot={points ? "median per hour; gaps are hours with no blocks" : DASH_WHY(spark.read)}>
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
    <section className="card" aria-labelledby="latest-h">
      <div className="sec-h"><h3 id="latest-h">Latest final blocks</h3><span className="muted small">One Canton transaction each</span></div>
      {error ? <p className="muted">{error}</p> : !blocks ? <p className="muted">Reading the blocks…</p> : blocks.length ? (
        <>
          <div className="scroll">
            <table className="tbl">
              <thead><tr><th>Block</th><th className="r">Txs</th><th className="r">Time to final</th><th>Canton update</th><th>Stage</th></tr></thead>
              <tbody>
                {blocks.map((b) => (
                  <tr key={b.number}>
                    <td><Link className="num" to={`/block/${b.number}`}>{b.number}</Link><span className="ago">{duration(now - b.timestamp * 1000)} ago</span></td>
                    <td className="r">{b.txCount}</td>
                    <td className="r" title="from the producer's cut to Canton's record time">{b.finalSeconds === null ? <span className="muted">—</span> : span(b.finalSeconds)}</td>
                    <td><HashLink value={b.updateId} kind="update" to={`/canton/${b.updateId}`} /></td>
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
export function Moved({ t, coin, labels }: { t: TxListItem; coin: { symbol: string; decimals: number }; labels: Labels }) {
  const first = t.tokenMoves?.first ?? null, more = t.tokenMoves ? t.tokenMoves.count - 1 : 0;
  const sent = BigInt(t.value) > 0n;
  if (!first) return <Amount raw={t.value} decimals={coin.decimals} symbol={coin.symbol} />;
  return (
    <span className="moved">
      <TokenChip move={first} label={labels.get(first.token)} />
      {more > 0 && <span className="muted small" title={`${more}${t.tokenMoves!.more ? " or more" : ""} more token moves in this transaction`}>+{more}{t.tokenMoves!.more ? "+" : ""}</span>}
      {sent && <Amount raw={t.value} decimals={coin.decimals} symbol={coin.symbol} />}
    </span>
  );
}

/**
 * What a transaction that is not final yet moves, as far as its own page says: when `to` is a known token and the input is a transfer, the transaction route
 * decodes it (`transfer`), and that is the chip, with the coin beside it when any is sent. A mint or a transfer of an NFT is not read here: the lists build their
 * summary from final logs only, and the receipt logs of a block being proven are not decoded in the browser. `d.value` is not null (the caller checks).
 */
export function ProvingMoved({ d, coin, labels }: { d: ApiTx & { value: string }; coin: { symbol: string; decimals: number }; labels: Labels }) {
  const t = d.transfer;
  if (!t || !d.to) return <Amount raw={d.value} decimals={coin.decimals} symbol={coin.symbol} />;
  const move = { token: d.to, amount: t.value, tokenId: null, standard: null, decimals: t.decimals };
  // The index may not know a token yet that was just made; its own symbol, as the transaction route read it from the contract, then stands in.
  const known = labels.get(d.to);
  const label = known?.symbol ? known : { address: d.to, name: known?.name ?? null, symbol: t.symbol, kind: known?.kind ?? "token" as const, standard: known?.standard ?? null, decimals: t.decimals, verified: known?.verified ?? false };
  return (
    <span className="moved">
      <TokenChip move={move} label={label} />
      {BigInt(d.value) > 0n && <Amount raw={d.value} decimals={coin.decimals} symbol={coin.symbol} />}
    </span>
  );
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
export function LatestTxs({ txs, coin, error, pending = [], pendingRead = "ok", details = {}, faucet = null, chain }: {
  txs: TxListItem[] | undefined; coin: { symbol: string; decimals: number }; error?: string; pending?: InFlightTx[]; pendingRead?: Read; details?: Record<string, Details>; faucet?: string | null; chain?: string;
}) {
  const now = useNow();
  const waiting = pending.filter((p) => !txs?.some((t) => t.hash === p.hash));
  const final = txs ?? [];
  const labels = useLabels([
    ...final.flatMap((t) => [t.from, t.to, t.created, t.tokenMoves?.first?.token]),
    ...waiting.flatMap((p) => { const d = details[p.hash]; return typeof d === "object" ? [d.from, d.to, d.created] : []; }),
  ]);
  return (
    <section className="card" aria-labelledby="txs-h">
      <div className="sec-h"><h3 id="txs-h">Latest transactions</h3><span className="muted small">Including those not final yet</span></div>
      {pendingRead === "error" && <p className="muted small">Transactions not final yet cannot be read right now.</p>}
      {waiting.length || final.length ? (
        <>
          <div className="scroll">
            <table className="tbl">
              <thead><tr><th>Transaction</th><th>From / to</th><th className="r">Value</th><th>Stage</th></tr></thead>
              <tbody>
                {waiting.map((p) => {
                  const d = details[p.hash] ?? "reading";
                  return (
                    <tr key={p.hash}>
                      <TxCell hash={p.hash} ago={duration(now - Date.parse(p.at))} />
                      <td className="small">{d === "reading" ? <span className="muted">reading…</span> : d === "error" ? <span className="muted">cannot be read right now</span> : <Parties from={d.from} to={d.to} created={d.created} labels={labels} faucet={faucet} chain={chain} />}</td>
                      <td className="r">{typeof d === "object" && d.value !== null ? <ProvingMoved d={{ ...d, value: d.value }} coin={coin} labels={labels} /> : <span className="muted">—</span>}</td>
                      <td><Chip status={p.stage} /></td>
                    </tr>
                  );
                })}
                {final.map((t) => (
                  <tr key={t.hash}>
                    <TxCell hash={t.hash} ago={duration(now - t.timestamp * 1000)} />
                    <td className="small"><Parties from={t.from} to={t.to} created={t.created} labels={labels} faucet={faucet} chain={chain} /></td>
                    <td className="r"><Moved t={t} coin={coin} labels={labels} /></td>
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

/** What the explorer shows and what it does not, and why: Canton shows each party only what it is a party to. One line, as on screen 01. */
export function LockBanner() {
  return (
    <section className="lock-banner" aria-label="What this explorer can and cannot show">
      <Icon name="lock" size={15} />
      <p>
        <b>What this explorer can and cannot show.</b> Shown: every EVM block, transaction and address, and for each final block its record on Canton (update id, record time, synchronizer, offset and the proof).
        {" "}Not shown: anything else on Canton. Daml legs settled with a block are seen only by their parties, the chain's operator, confirmer, gateway and builder, and each token's registry.
      </p>
    </section>
  );
}

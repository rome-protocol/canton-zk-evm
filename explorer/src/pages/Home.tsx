import { Link } from "react-router-dom";
import { useQueries, useQuery } from "@tanstack/react-query";
import { getTokenList, getTx, getTxs, type ApiHealth, type ApiStatus } from "../api.ts";
import { ErrorCard, LoadingCard } from "../components/Cards.tsx";
import { InFlightPanel } from "../components/InFlight.tsx";
import { Icon } from "../components/Icon.tsx";
import { duration, short, utcMs } from "../format.ts";
import { listPoll, readOf, summarize, useBlocks, useFaucetAddress, useHomeStats, useInFlight, usualProof } from "../stats.ts";
import { usePainted } from "../painted.tsx";
import { useLiveState } from "../useLive.ts";
import { checksWord, stripItems } from "../strip.ts";
import { useHealth, useNow, useStatus } from "../useStatus.ts";
import "./home.css";
import { type Details, Hero, LatestBlocks, LatestTxs, LockBanner, Stats } from "./HomeParts.tsx";

function Strip({ status: s, health }: { status: ApiStatus; health: ApiHealth | undefined }) {
  const now = useNow(), word = checksWord(s, health), starting = s.starting;
  return (
    <section className="card strip" aria-label="Chain status">
      <div className="strip-row">
        <div className="strip-dots">
          <span className={`sd lead ${word.dot}`}><i />{word.text}</span>
          {stripItems(s, health).map((i) => <span key={i.key} className={`sd ${i.dot}`} title={i.title}><i />{i.text}</span>)}
        </div>
        <div className="strip-last">
          {s.final && !starting ? (
            <>Last final block <Link className="num" to={`/block/${s.final.number}`}>{s.final.number}</Link> · <b>{duration(now - Date.parse(s.final.recordTime))} ago</b> · {utcMs(s.final.recordTime)}</>
          ) : <span className="muted">{starting ? `Reading the chain for the first time…${s.final ? ` · block ${s.final.number} so far` : ""}` : "No final block yet."}</span>}
        </div>
      </div>
      {s.problems.map((p) => <div key={p} className="alert bad-alert flat"><Icon name="warn" size={15} /><div className="mono small wrap">{p}</div></div>)}
      {!s.canton && <div className="alert bad-alert flat"><Icon name="warn" size={15} /><div>Canton cannot be read right now. The blocks below are what the explorer last read.</div></div>}
      {!s.evm && <div className="alert bad-alert flat"><Icon name="warn" size={15} /><div>The EVM node cannot be read right now. The blocks below are what the explorer last read.</div></div>}
      {!starting && s.evm && s.canton && !s.ok && !s.problems.length && <div className="alert bad-alert flat"><Icon name="warn" size={15} /><div>The explorer could not finish its last look at the chain.</div></div>}
    </section>
  );
}

const NO_LIST = "The explorer cannot read this list right now.";

export function Home() {
  const { data, error } = useStatus();
  const stream = useLiveState(["blocks", "txs", "inflight", "stats"]);
  const live = stream === "live";
  // What the first view needs is the status and the hour of stats; the lists and the rest are read once the first frame is drawn.
  const painted = usePainted();
  const health = useHealth(painted);
  const blocks = useBlocks(10, live, painted);
  const txs = useQuery({ queryKey: ["txs", 10], queryFn: () => getTxs(10), refetchInterval: listPoll(live), enabled: painted });
  const flight = useInFlight(live, painted);
  const homeStats = useHomeStats(painted);
  const flightRead = readOf(flight);
  // The details of a transaction that is not final (who, to whom, how much) do not change while it waits, so each is read once.
  const faucet = useFaucetAddress(painted);
  const pending = flight.data?.transactions ?? [];
  const detail = useQueries({ queries: pending.map((p) => ({ queryKey: ["tx", p.hash], queryFn: () => getTx(p.hash), staleTime: Infinity, retry: false })) });
  const details: Record<string, Details> = Object.fromEntries(pending.map((p, i) => [p.hash, detail[i]!.data ?? (detail[i]!.isError ? "error" : "reading")]));
  const newest = blocks.data?.items[0], first = txs.data?.items[0];
  // The token with the most holders, for a last thing to try; the list is read once the first frame is drawn, and without one there is no chip.
  const tokens = useQuery({ queryKey: ["tokens", "try"], queryFn: () => getTokenList("holders", null, 1), enabled: painted, staleTime: 60_000, retry: false });
  const token = tokens.data?.items?.[0];
  const tries = [
    ...(newest ? [{ label: String(newest.number), q: String(newest.number) }] : []),
    ...(first ? [{ label: short(first.hash, 8, 4), q: first.hash }, { label: short(first.from, 8, 4), q: first.from }] : []),
    ...(newest ? [{ label: `${newest.updateId.slice(0, 12)}…`, q: newest.updateId }] : []),
    ...(token ? [{ label: token.symbol ?? short(token.address, 8, 4), q: token.address, words: token.symbol !== null }] : []),
  ];
  // The search box stays whatever the status says: a visitor can look for a block while the chain cannot be read.
  if (error || !data) return <><Hero tries={[]} />{error ? <ErrorCard message={error.message} retrying /> : <LoadingCard>Reading the chain…</LoadingCard>}</>;
  return (
    <>
      <Hero tries={tries} />
      <Strip status={data} health={health.data} />
      <Stats summary={summarize(data, flightRead === "ok" ? flight.data! : null)} flight={flightRead} {...homeStats} />
      <InFlightPanel attempts={flight.data?.attempts ?? []} waiting={flight.data?.poolWaiting?.waiting ?? null} stream={stream} read={flightRead} usual={usualProof(blocks.data?.items ?? [])} later={pending} />
      <div className="cols home-cols">
        <LatestBlocks blocks={blocks.data?.items} error={blocks.isError ? NO_LIST : undefined} />
        <LatestTxs txs={txs.data?.items} coin={data.coin} error={txs.isError ? NO_LIST : undefined} pending={pending} pendingRead={flightRead} details={details} faucet={faucet} chain={data.chainName} />
      </div>
      <LockBanner />
    </>
  );
}

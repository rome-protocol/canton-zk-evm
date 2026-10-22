import { Link } from "react-router-dom";
import { useQueries, useQuery } from "@tanstack/react-query";
import { getTx, getTxs, type ApiStatus } from "../api.ts";
import { AddToWallet } from "../components/AddToWallet.tsx";
import { ErrorCard, LoadingCard } from "../components/Cards.tsx";
import { InFlightPanel } from "../components/InFlight.tsx";
import { Icon } from "../components/Icon.tsx";
import { commitTime, duration, short, utc } from "../format.ts";
import { listPoll, readOf, summarize, useBlocks, useFaucetAddress, useHomeStats, useInFlight, usualProof } from "../stats.ts";
import { useLiveState } from "../useLive.ts";
import { useNow, useStatus } from "../useStatus.ts";
import { type Details, Hero, LatestBlocks, LatestTxs, Stats } from "./HomeParts.tsx";

const LEGS = "Daml legs settled with a block are not shown to the public. Only the parties to each leg and the chain's operator, confirmer, gateway and builder see them, and each token's registry sees its own token move.";

type Dot = "ok" | "bad" | "off";

/** The three dots: the EVM node, Canton, and the explorer's own checks. The checks are only as good as what could be read, so they are off when a node cannot be, and while the first look is still going. */
function dots(s: ApiStatus): { evm: Dot; canton: Dot; checks: Dot; checksText: string } {
  const evm = s.evm ? "ok" : "bad", canton = s.canton ? "ok" : "bad";
  if (s.starting && !s.problems.length) return { evm, canton, checks: "off", checksText: "Starting" };
  if (!s.evm || !s.canton) return { evm, canton, checks: "off", checksText: "Checks" };
  if (s.problems.length) return { evm, canton, checks: "bad", checksText: "A check failed" };
  return s.ok ? { evm, canton, checks: "ok", checksText: "Checks pass" } : { evm, canton, checks: "off", checksText: "Checks" };
}

function Strip({ status: s }: { status: ApiStatus }) {
  const now = useNow(), d = dots(s), starting = s.starting;
  return (
    <section className="card strip" aria-label="Chain status">
      <div className="strip-dots">
        <span className={`sd ${d.evm}`}><i />EVM node</span>
        <span className={`sd ${d.canton}`}><i />Canton</span>
        <span className={`sd ${d.checks}`}><i />{d.checksText}</span>
        {s.indexLag !== null && <span className={`sd ${s.indexLag > 0 ? "off" : "ok"}`}><i />Index lag {s.indexLag} block{s.indexLag === 1 ? "" : "s"}</span>}
      </div>
      <div className="strip-lines">
        <div className="sl">
          <span className="sl-k">Final on Canton</span>
          {s.final && !starting ? (
            <span className="sl-v">
              <Link className="num" to={`/block/${s.final.number}`}>Block {s.final.number}</Link> · committed {commitTime(s.final.timestamp, s.final.recordTime)} after it was made · {utc(Date.parse(s.final.recordTime))}
            </span>
          ) : <span className="sl-v muted">{starting ? `Reading the chain for the first time…${s.final ? ` · block ${s.final.number} so far` : ""}` : "No final block yet."}</span>}
        </div>
        {!starting && (
          <div className="sl">
            <span className="sl-k">Being proven</span>
            {s.proving ? (
              <span className="sl-v"><Link className="num" to={`/block/${s.proving.number}`}>Block {s.proving.number}</Link> · made {duration(now - s.proving.timestamp * 1000)} ago</span>
            ) : <span className="sl-v muted">None right now.</span>}
          </div>
        )}
      </div>
      {s.problems.map((p) => <div key={p} className="alert bad-alert flat"><Icon name="warn" size={15} /><div className="mono small wrap">{p}</div></div>)}
      {!s.canton && <div className="alert bad-alert flat"><Icon name="warn" size={15} /><div>Canton cannot be read right now. The blocks below are what the explorer last read.</div></div>}
      {!s.evm && <div className="alert bad-alert flat"><Icon name="warn" size={15} /><div>The EVM node cannot be read right now. The blocks below are what the explorer last read.</div></div>}
      {!starting && s.evm && s.canton && !s.ok && !s.problems.length && <div className="alert bad-alert flat"><Icon name="warn" size={15} /><div>The explorer could not finish its last look at the chain.</div></div>}
    </section>
  );
}

/** What the explorer shows and what it does not, and why: Canton shows each party only what it is a party to. */
function CanCannot() {
  return (
    <section className="card can" aria-labelledby="can-h">
      <h3 id="can-h">What this explorer can and cannot show</h3>
      <div className="can-grid">
        <div>
          <div className="can-h ok-h"><Icon name="check" />Shown</div>
          <p>Every EVM block, transaction and address, and for each final block its record on Canton: the update id, the commit time and the proof.</p>
        </div>
        <div>
          <div className="can-h no-h"><Icon name="lock" />Not shown</div>
          <p>Anything else on Canton. {LEGS}</p>
        </div>
      </div>
      <p className="can-proof">Every block is proven with ZisK 1.3.1 (a 1,344-byte proof) and checked by Canton's confirmers before it commits. Each block page can run that same check again, in your browser.</p>
    </section>
  );
}

const NO_LIST = "The explorer cannot read this list right now.";

export function Home() {
  const { data, error } = useStatus();
  const stream = useLiveState(["blocks", "txs", "inflight", "stats"]);
  const live = stream === "live";
  const blocks = useBlocks(10, live);
  const txs = useQuery({ queryKey: ["txs", 10], queryFn: () => getTxs(10), refetchInterval: listPoll(live) });
  const flight = useInFlight(live);
  const homeStats = useHomeStats();
  const flightRead = readOf(flight);
  // The details of a transaction that is not final (who, to whom, how much) do not change while it waits, so each is read once.
  const faucet = useFaucetAddress();
  const pending = flight.data?.transactions ?? [];
  const detail = useQueries({ queries: pending.map((p) => ({ queryKey: ["tx", p.hash], queryFn: () => getTx(p.hash), staleTime: Infinity, retry: false })) });
  const details: Record<string, Details> = Object.fromEntries(pending.map((p, i) => [p.hash, detail[i]!.data ?? (detail[i]!.isError ? "error" : "reading")]));
  const newest = blocks.data?.items[0], first = txs.data?.items[0];
  const tries = [
    ...(newest ? [{ label: String(newest.number), q: String(newest.number) }] : []),
    ...(first ? [{ label: short(first.hash, 6, 4), q: first.hash }, { label: short(first.from, 6, 4), q: first.from }] : []),
    ...(newest ? [{ label: short(newest.updateId, 10, 4), q: newest.updateId }] : []),
  ];
  // The search box stays whatever the status says: a visitor can look for a block while the chain cannot be read.
  if (error || !data) return <><Hero tries={[]} />{error ? <ErrorCard message={error.message} retrying /> : <LoadingCard>Reading the chain…</LoadingCard>}</>;
  return (
    <>
      <Hero tries={tries} />
      <Strip status={data} />
      <Stats summary={summarize(data, flightRead === "ok" ? flight.data! : null)} flight={flightRead} {...homeStats} />
      <InFlightPanel attempts={flight.data?.attempts ?? []} waiting={flight.data?.poolWaiting?.waiting ?? null} stream={stream} read={flightRead} usual={usualProof(blocks.data?.items ?? [])} later={pending} />
      <AddToWallet status={data} />
      <div className="cols">
        <LatestBlocks blocks={blocks.data?.items} error={blocks.isError ? NO_LIST : undefined} />
        <LatestTxs txs={txs.data?.items} coin={data.coin} error={txs.isError ? NO_LIST : undefined} pending={pending} pendingRead={flightRead} details={details} faucet={faucet} chain={data.chainName} />
      </div>
      <CanCannot />
    </>
  );
}

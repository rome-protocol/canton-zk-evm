import { Link } from "react-router-dom";
import type { ApiStatus, LatestBlock } from "../api.ts";
import { ErrorCard, LoadingCard } from "../components/Cards.tsx";
import { Chip } from "../components/Chip.tsx";
import { HashLink } from "../components/HashLink.tsx";
import { Icon } from "../components/Icon.tsx";
import { commitTime, duration, utc } from "../format.ts";
import { useNow, useStatus } from "../useStatus.ts";

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

function Row({ b }: { b: LatestBlock }) {
  return (
    <tr>
      <td><Link className="num" to={`/block/${b.number}`}>{b.number}</Link></td>
      <td><HashLink value={b.hash} to={`/block/${b.hash}`} /></td>
      <td className="r">{b.txCount}</td>
      <td><HashLink value={b.updateId} kind="update" /></td>
      <td className="mono muted">{utc(b.timestamp * 1000)}</td>
      <td className="r">{commitTime(b.timestamp, b.recordTime)}</td>
      <td><Chip status="final" /></td>
    </tr>
  );
}

function Latest({ blocks }: { blocks: LatestBlock[] }) {
  return (
    <section className="card" aria-labelledby="latest-h">
      <div className="sec-h"><h3 id="latest-h">Latest final blocks</h3><span className="muted small">Each block is one transaction on Canton, so this is also the list of the chain's Canton updates.</span></div>
      {blocks.length ? (
        <>
          <div className="scroll">
            <table className="tbl">
              <thead><tr><th>Block</th><th>Hash</th><th className="r">Txs</th><th>Canton update</th><th>Made</th><th className="r">Committed after</th><th></th></tr></thead>
              <tbody>{blocks.map((b) => <Row key={b.number} b={b} />)}</tbody>
            </table>
          </div>
          <div className="tbl-foot muted small">{blocks.length >= 10 ? "Showing the newest ten final blocks." : `Showing all ${blocks.length} final block${blocks.length === 1 ? "" : "s"} so far.`}</div>
        </>
      ) : <p className="muted">No final blocks yet.</p>}
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

export function Home() {
  const { data, error } = useStatus();
  if (error) return <ErrorCard message={error.message} retrying />;
  if (!data) return <LoadingCard>Reading the chain…</LoadingCard>;
  return (
    <>
      <Strip status={data} />
      <Latest blocks={data.latest} />
      <CanCannot />
    </>
  );
}

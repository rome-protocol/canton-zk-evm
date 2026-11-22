import { handoffView } from "../bridge/other/handoff.ts";
import type { HandoffRow, OstiaChain } from "../bridge/other/setup.ts";
import { notAvailable } from "../bridge/other/words.ts";

/** A route through Solgate: a card, not a form. The page signs nothing and connects no wallet here; it names the steps and opens Solgate, where every step is made. */
export function OtherHandoff({ row, chain, ostiaCoin }: { row: HandoffRow; chain: OstiaChain; ostiaCoin: string }) {
  const v = handoffView(row, chain, ostiaCoin);
  return (
    <section className="card route-form handoff" aria-label={`${chain.name} and ${row.name} through Solgate`}>
      <p><b>{v.intro}</b></p>
      <ol>{v.steps.map((s, i) => <li key={i}>{i + 1} {s.label}{s.detail && <> <span className="muted small">({s.detail})</span></>}</li>)}</ol>
      {row.assets.length > 0
        ? <p className="small muted">You can move {row.assets.map((t) => t.symbol).join(", ")}. In Solgate, pick From {chain.name}, To {row.id === "solana-devnet" ? "Solana" : row.name} and the token.</p>
        : <p className="small muted">No token is offered on this route yet.</p>}
      {v.times.length > 0 && <div className="small muted"><p>Time until it is ready to claim</p><ul>{v.times.map((t) => <li key={t}>{t}</li>)}</ul></div>}
      {v.places.map((t) => <p key={t} className="small muted">{t}</p>)}
      {v.trust.map((t) => <p key={t} className="small muted">{t}</p>)}
      <p className="small muted">{v.back} Solgate's Activity shows the whole trip.</p>
      {row.available
        ? <p><a className="btn go" href={v.open} target="_blank" rel="noopener noreferrer">Open Solgate</a> <a href={v.claim} target="_blank" rel="noopener noreferrer" className="small">Already sent? Go to Claim</a></p>
        : <><p className="small bad" role="status">{notAvailable(row.name)}</p><button type="button" className="btn go" disabled>Not available right now</button></>}
    </section>
  );
}

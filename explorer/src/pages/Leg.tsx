import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { getBlockSummary, getLeg, type LegListItem } from "../api.ts";
import { unready } from "../components/Cards.tsx";
import { Chip } from "../components/Chip.tsx";
import { HashLink } from "../components/HashLink.tsx";
import { Item, Kv } from "../components/Kv.tsx";
import { useFollowing } from "../useStatus.ts";
import { LegAmount, LegsPrivacy, LegToken } from "./LegParts.tsx";

/** The Canton update that carries the leg's block. It is the block's update, read from the block route; the leg's own settlement on Canton is not public. */
function BlockUpdate({ block }: { block: number }) {
  const b = useQuery({ queryKey: ["block-summary", String(block)], queryFn: () => getBlockSummary(String(block)), retry: false, staleTime: 30_000 });
  if (b.isPending) return <span className="muted">…</span>;
  const id = b.data?.canton?.updateId;
  return id ? <HashLink value={id} kind="update" to={`/canton/${id}`} full /> : <span className="muted" title="The explorer has not read this block's record from Canton yet">not read yet</span>;
}

function Facts({ l }: { l: LegListItem }) {
  return (
    <section className="card" aria-label="Leg">
      <div className="list-h"><h2>What the EVM recorded</h2><span className="muted small">the gateway's Leg event</span></div>
      <Kv>
        <Item label="Kind"><span className="tag">{l.kind}</span></Item>
        <Item label="Leg id"><HashLink value={l.legId} full /></Item>
        <Item label="Position">Leg {l.legIndex}, transaction {l.txIndex}, log {l.logIndex}</Item>
        <Item label="Block"><Link className="num" to={`/block/${l.block}`}>{l.block}</Link></Item>
        <Item label="Transaction">{l.txHash ? <HashLink value={l.txHash} to={`/tx/${l.txHash}`} full /> : <span className="muted">the explorer has not stored this transaction</span>}</Item>
        <Item label="Canton update"><BlockUpdate block={l.block} /></Item>
        <Item label="Token"><LegToken token={l.token} full /></Item>
        <Item label="Account"><HashLink value={l.account} to={`/address/${l.account}`} full /></Item>
        <Item label="Amount"><LegAmount l={l} /></Item>
      </Kv>
    </section>
  );
}

/** One gateway leg, by its id: only what the EVM recorded, linked to its block, its transaction and the block's Canton update. */
export function Leg() {
  const { id = "" } = useParams();
  const q = useFollowing(["leg", id], () => getLeg(id), () => true);
  const wait = unready(q, "Reading the leg…");
  if (wait) return wait;
  const l = q.data!;
  return (
    <>
      <nav className="small muted" aria-label="Breadcrumb"><Link to="/legs">Gateway legs</Link> / <span className="mono">{l.legId.slice(0, 6)}…{l.legId.slice(-4)}</span></nav>
      <div className="ptitle"><h1>Gateway leg <small className="muted">{l.kind}</small></h1><Chip status="final" /></div>
      <Facts l={l} />
      <LegsPrivacy />
    </>
  );
}

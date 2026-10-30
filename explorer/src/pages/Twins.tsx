import { Link } from "react-router-dom";
import type { TwinCanton, TwinLeg, TwinsOverview } from "../api.ts";
import { CardHead, ErrorCard, LoadingCard } from "../components/Cards.tsx";
import { HashLink } from "../components/HashLink.tsx";
import { Icon } from "../components/Icon.tsx";
import { Info } from "../components/Info.tsx";
import { Item, Kv } from "../components/Kv.tsx";
import { count, exact, plural, short, units } from "../format.ts";
import { ago } from "../block-times.ts";
import { useNow } from "../useStatus.ts";
import { compareCustody } from "./CantonCustody.tsx";
import { cantonMark, Mark, Tok, useTwins } from "./TwinParts.tsx";
import { TwinSupply } from "./TwinSupply.tsx";
import "./twins.css";

const ABOUT = "A twin is an ERC-20 locked in the chain's vaults and issued on Canton. Its supply is the locks less the releases, set against what the vaults hold at the same block. A Canton token is wrapped on Ostia and backed by what the gateway holds on Canton. Only totals are public: no Canton party, holding or contract.";

/** The chain record: its vaults (with their code hash) and the twins it pins (with their decimals). */
function Registry({ d }: { d: TwinsOverview }) {
  return (
    <section className="card" aria-label="Registry">
      <CardHead as="h2" title="Registry" sub="the vaults and twins the chain record names" info="The chain record lists the vaults that hold the locked tokens, each named by its code hash, and pins each twin token with its decimals." />
      <Kv>
        <Item label="Vaults">
          {d.vaults.length === 0 ? <span className="muted">No vaults are registered yet.</span>
            : <ul className="twin-list">{d.vaults.map((v) => <li key={v.address}><HashLink value={v.address} to={`/address/${v.address}`} /> <span className="muted small">code hash</span> <HashLink value={v.codeHash} /></li>)}</ul>}
        </Item>
        <Item label="Twins">
          {d.twins.length === 0 ? <span className="muted">No twins are pinned yet.</span>
            : <ul className="twin-list">{d.twins.map((t) => <li key={t.token}><Link to={`/token/${t.token}`}>{t.symbol ?? short(t.token, 8, 4)}</Link> <span className="muted small">{t.decimals} decimals</span></li>)}</ul>}
        </Item>
      </Kv>
    </section>
  );
}

/** What backs each Canton token: the custody on Canton next to the wrapped supply, both read at one block. */
function Custody({ rows }: { rows: TwinCanton[] }) {
  const now = useNow();
  return (
    <section className="card" aria-label="Canton tokens">
      <CardHead as="h2" title="Canton tokens" sub="what the gateway holds on Canton against the wrapped supply" info="Both numbers are read at the same block, the custody at the ledger offset of that block's record, so a difference is a difference at that block." />
      {rows.length === 0 ? <p className="muted small chart-msg">No Canton tokens are on Ostia yet.</p> : (
        <div className="scroll"><table className="tbl" aria-label="Canton token custody">
          <thead><tr><th>Token</th><th className="r">Held on Canton</th><th className="r">Wrapped supply</th><th>Check</th><th>Read</th></tr></thead>
          <tbody>{rows.map((c) => {
            const gap = compareCustody(c.decimals, c);
            return (
              <tr key={c.token}>
                <td><Link to={`/token/${c.token}`}>{c.symbol ?? short(c.token, 8, 4)}</Link><span className="tag">{c.instrumentId}</span></td>
                <td className="r"><span className="num" title={`${exact(c.custody, c.custodyDecimals)} ${c.instrumentId}`}>{units(c.custody, c.custodyDecimals)}</span> {c.instrumentId} <span className="muted small">{plural(c.holdings, "holding")}</span></td>
                <td className="r">{c.supply === null ? <span className="muted">not known</span> : <Tok raw={c.supply} decimals={c.decimals} symbol={c.symbol} />}</td>
                <td><Mark state={cantonMark(c)} />{gap.state === "custody-higher" || gap.state === "supply-higher" ? <span className="muted small"> by <span className="num" title={exact(gap.diff, gap.scale)}>{units(gap.diff, gap.scale)}</span></span> : null}</td>
                <td className="muted small">block {count(c.supplyBlock)} · {ago(c.readAt, now)}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      )}
    </section>
  );
}

/** The newest lock and release legs, each linking its leg, transaction, block and the block's Canton update. */
function Legs({ legs, d }: { legs: TwinLeg[]; d: TwinsOverview }) {
  return (
    <section className="card" aria-label="Locks and releases">
      <CardHead as="h2" title="Locks and releases" sub="the newest legs" info="A payment of a pinned token into a registered vault is a lock; one a vault paid out is a release. The update is the Canton record of the leg's block." />
      {legs.length === 0 ? <p className="muted small chart-msg">No locks or releases yet.</p> : (
        <div className="scroll"><table className="tbl" aria-label="Lock and release legs">
          <thead><tr><th>Leg</th><th>Kind</th><th>Transaction</th><th>Block</th><th className="r">Amount</th><th>Canton update</th></tr></thead>
          <tbody>{legs.map((l) => (
            <tr key={l.legId}>
              <td><HashLink value={l.legId} to={`/leg/${l.legId}`} /></td>
              <td><span className="tag">{l.twin === "lock" ? "Lock" : "Release"}</span></td>
              <td>{l.txHash ? <HashLink value={l.txHash} to={`/tx/${l.txHash}`} /> : <span className="muted" title="The explorer has not stored this transaction">—</span>}</td>
              <td><Link className="num" to={`/block/${l.block}`}>{l.block}</Link></td>
              <td className="r"><Tok raw={l.amount} decimals={d.twins.find((t) => t.token === l.token)?.decimals ?? null} symbol={l.symbol} /></td>
              <td>{l.updateId ? <HashLink value={l.updateId} kind="update" to={`/canton/${l.updateId}`} /> : <span className="muted" title="The explorer has not read this block's record from Canton yet">not read yet</span>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </section>
  );
}

/** The twins page: the registry, one card per twin, the Canton tokens' custody and the newest locks and releases. */
export function Twins() {
  const q = useTwins();
  const d = q.data;
  return (
    <>
      <div className="list-h">
        <div><h1>Twins</h1> <span className="muted stats-sub">{d?.through != null ? `counted to block ${count(d.through)}` : ""}</span><Info about="the twins">{ABOUT}</Info></div>
      </div>
      {d?.registryService && <p className="small muted twins-service">Registry service: <a href={`${d.registryService}/healthz`} target="_blank" rel="noreferrer">{`${d.registryService}/healthz`}</a></p>}
      {q.isError && !d ? <ErrorCard message={(q.error as Error).message} retrying /> : !d ? <LoadingCard>Reading the twins…</LoadingCard> : (
        <>
          <Registry d={d} />
          {d.twins.length > 0 && (
            <div className="cols">{d.twins.map((t) => (
              <TwinSupply key={t.token} t={t} twin={t} name={`${t.symbol ?? short(t.token, 8, 4)} twin`} action={<Link className="csv" to={`/token/${t.token}`}>Token <Icon name="next" /></Link>} />
            ))}</div>
          )}
          <Custody rows={d.canton} />
          <Legs legs={d.legs} d={d} />
        </>
      )}
    </>
  );
}

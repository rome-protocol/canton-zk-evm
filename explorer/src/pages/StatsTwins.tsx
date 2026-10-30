import { Link } from "react-router-dom";
import { CardHead } from "../components/Cards.tsx";
import { Icon } from "../components/Icon.tsx";
import { plural, short, units } from "../format.ts";
import { cantonMark, Mark, twinMark, Tok, useTwins } from "./TwinParts.tsx";

const WHAT = "A twin is an ERC-20 locked in the chain's vaults and issued on Canton: what it has in issue (locks less releases) should equal what the vaults hold. A Canton token is wrapped on Ostia: its supply should equal what the gateway holds on Canton. Each pair is read at the same block.";

/** The Stats page's "Canton assets" card: one row per pinned twin and per Canton token, each linking its token page, and a link to the twins page. Nothing until the twins answer is read. */
export function CantonAssets() {
  const d = useTwins().data;
  if (!d) return null;
  const none = d.twins.length === 0 && d.canton.length === 0;
  return (
    <section className="card panel" aria-label="Canton assets">
      <CardHead title="Canton assets" sub="twins and Canton tokens" info={WHAT} action={<Link className="csv" to="/twins">Open the twins page <Icon name="next" /></Link>} />
      {none ? <p className="muted small chart-msg">No twins are pinned and no Canton tokens are on Ostia yet.</p> : (
        <>
          <div className="scroll"><table className="tbl" aria-label="Canton assets">
            <thead><tr><th>Token</th><th className="r">In issue</th><th className="r">Backing</th><th>Check</th><th>Legs</th></tr></thead>
            <tbody>
              {d.twins.map((t) => (
                <tr key={`twin-${t.token}`}>
                  <td><Link to={`/token/${t.token}`}>{t.symbol ?? short(t.token, 8, 4)}</Link><span className="tag">twin</span></td>
                  <td className="r"><Tok raw={t.supply} decimals={t.decimals} symbol={null} /></td>
                  <td className="r">{t.vaultBalance === null ? <span className="muted">not read</span> : <><Tok raw={t.vaultBalance} decimals={t.decimals} symbol={null} /> <span className="muted small">in vaults</span></>}</td>
                  <td><Mark state={twinMark(t)} /></td>
                  <td className="muted">{plural(t.locks, "lock")} · {plural(t.releases, "release")}</td>
                </tr>
              ))}
              {d.canton.map((c) => (
                <tr key={`canton-${c.token}`}>
                  <td><Link to={`/token/${c.token}`}>{c.symbol ?? short(c.token, 8, 4)}</Link><span className="tag">on Canton</span></td>
                  <td className="r">{c.supply === null ? <span className="muted">not known</span> : <Tok raw={c.supply} decimals={c.decimals} symbol={null} />}</td>
                  <td className="r"><span className="num">{units(c.custody, c.custodyDecimals)}</span> {c.instrumentId} <span className="muted small">on Canton</span></td>
                  <td><Mark state={cantonMark(c)} /></td>
                  <td className="muted">{plural(c.holdings, "holding")}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
          {d.twins.length === 0 && <p className="tbl-foot small muted">No twins are pinned yet.</p>}
          {d.canton.length === 0 && <p className="tbl-foot small muted">No Canton tokens are on Ostia yet.</p>}
        </>
      )}
    </section>
  );
}

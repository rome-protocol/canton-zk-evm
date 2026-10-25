import type { TokenDetail } from "../api.ts";
import { CardHead } from "../components/Cards.tsx";
import { Item, Kv } from "../components/Kv.tsx";
import { ago } from "../block-times.ts";
import { count, exact, units } from "../format.ts";
import { useNow } from "../useStatus.ts";

export type CustodyState = "equal" | "custody-higher" | "supply-higher" | "unknown";

/**
 * Canton's custody set against the wrapped supply, both brought to the finer of the two scales so that nothing is rounded: a state and the difference
 * (in whole units, the same on both sides), or "unknown" when the wrapped supply or its decimals are not known.
 */
export function compareCustody(t: Pick<TokenDetail, "totalSupply" | "decimals" | "canton">): { state: CustodyState; diff: string; scale: number } {
  const c = t.canton;
  if (!c || t.totalSupply === null || t.decimals === null) return { state: "unknown", diff: "0", scale: 0 };
  const scale = Math.max(t.decimals, c.custodyDecimals);
  const supply = BigInt(t.totalSupply) * 10n ** BigInt(scale - t.decimals), custody = BigInt(c.custody) * 10n ** BigInt(scale - c.custodyDecimals);
  if (supply === custody) return { state: "equal", diff: "0", scale };
  return custody > supply ? { state: "custody-higher", diff: (custody - supply).toString(), scale } : { state: "supply-higher", diff: (supply - custody).toString(), scale };
}

function Verdict({ t }: { t: TokenDetail }) {
  const { state, diff, scale } = compareCustody(t);
  const gap = <span className="num" title={exact(diff, scale)}>{units(diff, scale)}</span>;
  return (
    <>
      <dt className="kv-k">Check</dt>
      <dd className="kv-v" data-state={state}>
        {state === "equal" ? "Equal: Canton holds exactly the wrapped supply."
          : state === "custody-higher" ? <>Canton holds {gap} more than the wrapped supply.</>
          : state === "supply-higher" ? <>The wrapped supply is {gap} more than Canton holds.</>
          : "The wrapped supply or its decimals are not known, so there is nothing to compare."}
      </dd>
    </>
  );
}

/**
 * What backs a token the gateway registered: the instrument on Canton, what the gateway holds of it (read as the gateway at a stated ledger offset) next to
 * the wrapped token's supply. The two are read at different moments, so each says when. Only the instrument and two totals are public: no holding, owner or
 * contract of the Daml side.
 */
export function CantonCustody({ t }: { t: TokenDetail }) {
  const now = useNow();
  const c = t.canton;
  return (
    <section className="card" aria-label="Backed on Canton">
      <CardHead as="h2" title="Backed on Canton" sub="what the gateway holds of the token's instrument, read as the gateway" />
      {!c ? <p className="muted small">The gateway's custody on Canton is not read yet.</p> : (
        <Kv>
          <Item label="Held on Canton"><span className="num" title={`${exact(c.custody, c.custodyDecimals)} ${c.instrumentId}`}>{units(c.custody, c.custodyDecimals)}</span> {c.instrumentId}</Item>
          <Item label="Wrapped supply">
            {t.totalSupply === null ? <span className="muted">not known</span>
              : t.decimals === null ? <span className="num">{count(t.totalSupply)}</span>
              : <><span className="num" title={exact(t.totalSupply, t.decimals)}>{units(t.totalSupply, t.decimals)}</span>{t.symbol ? ` ${t.symbol}` : ""}</>}
            {t.totalSupplyBlock !== null && <span className="muted small"> · as of block {t.totalSupplyBlock}</span>}
          </Item>
          <Verdict t={t} />
          <Item label="Instrument"><span className="mono">{c.instrumentId}</span> <span className="muted small">registered by</span> <span className="mono">{c.instrumentAdmin}</span></Item>
          <Item label="Read">Canton offset {count(c.ledgerOffset)} · {ago(c.readAt, now)}</Item>
        </Kv>
      )}
    </section>
  );
}

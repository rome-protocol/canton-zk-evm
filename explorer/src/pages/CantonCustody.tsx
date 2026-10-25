import type { CantonCustody as Custody, TokenDetail } from "../api.ts";
import { CardHead } from "../components/Cards.tsx";
import { Item, Kv } from "../components/Kv.tsx";
import { ago } from "../block-times.ts";
import { count, exact, units } from "../format.ts";
import { useNow } from "../useStatus.ts";

export type CustodyState = "equal" | "custody-higher" | "supply-higher" | "unknown";

/**
 * Canton's custody set against the wrapped supply, both brought to the finer of the two scales so that nothing is rounded: a state and the difference
 * (in whole units, the same on both sides), or "unknown" when the supply or the token's decimals are not known. Both numbers are the ones stored with the
 * custody, read at the same block, never the token's live supply.
 */
export function compareCustody(decimals: number | null, c: Pick<Custody, "custody" | "custodyDecimals" | "supply">): { state: CustodyState; diff: string; scale: number } {
  if (c.supply === null || decimals === null) return { state: "unknown", diff: "0", scale: 0 };
  const scale = Math.max(decimals, c.custodyDecimals);
  const supply = BigInt(c.supply) * 10n ** BigInt(scale - decimals), custody = BigInt(c.custody) * 10n ** BigInt(scale - c.custodyDecimals);
  if (supply === custody) return { state: "equal", diff: "0", scale };
  return custody > supply ? { state: "custody-higher", diff: (custody - supply).toString(), scale } : { state: "supply-higher", diff: (supply - custody).toString(), scale };
}

function Verdict({ decimals, c }: { decimals: number | null; c: Custody }) {
  const { state, diff, scale } = compareCustody(decimals, c);
  const gap = <span className="num" title={exact(diff, scale)}>{units(diff, scale)}</span>;
  return (
    <>
      <dt className="kv-k">Check</dt>
      <dd className="kv-v" data-state={state}>
        {state === "equal" ? `Equal at block ${count(c.supplyBlock)}: Canton holds exactly the wrapped supply.`
          : state === "custody-higher" ? <>At block {count(c.supplyBlock)}, Canton holds {gap} more than the wrapped supply.</>
          : state === "supply-higher" ? <>At block {count(c.supplyBlock)}, the wrapped supply is {gap} more than Canton holds.</>
          : "The wrapped supply or its decimals are not known, so there is nothing to compare."}
      </dd>
    </>
  );
}

/**
 * What backs a token the gateway registered on Canton: the instrument, what the gateway holds of it (read as the gateway) next to the wrapped token's supply.
 * The two numbers are read at the same block (the custody at the ledger offset of that block's record), so a difference is a difference at that block and not
 * a deposit that landed between two reads. Only the instrument and two totals are public: no holding, owner or contract of the Daml side. Shown only for a token
 * with a custody row: a token anyone made through the gateway's public register, with no GatewayToken on Canton, is not shown as backed.
 */
export function CantonCustody({ t, canton: c }: { t: TokenDetail; canton: Custody }) {
  const now = useNow();
  return (
    <section className="card" aria-label="Backed on Canton">
      <CardHead as="h2" title="Backed on Canton" sub="what the gateway holds of the token's instrument, read as the gateway" />
      <Kv>
        <Item label="Held on Canton"><span className="num" title={`${exact(c.custody, c.custodyDecimals)} ${c.instrumentId}`}>{units(c.custody, c.custodyDecimals)}</span> {c.instrumentId}</Item>
        <Item label="Wrapped supply">
          {c.supply === null ? <span className="muted">not known</span>
            : t.decimals === null ? <span className="num">{count(c.supply)}</span>
            : <><span className="num" title={exact(c.supply, t.decimals)}>{units(c.supply, t.decimals)}</span>{t.symbol ? ` ${t.symbol}` : ""}</>}
        </Item>
        <Verdict decimals={t.decimals} c={c} />
        <Item label="Instrument"><span className="mono">{c.instrumentId}</span> <span className="muted small">registered by</span> <span className="mono">{c.instrumentAdmin}</span></Item>
        <Item label="Read">Both at block {count(c.supplyBlock)} · Canton offset {count(c.ledgerOffset)} · {ago(c.readAt, now)}</Item>
      </Kv>
    </section>
  );
}

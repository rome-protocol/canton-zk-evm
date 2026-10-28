import type { TokenDetail, TwinSupply as Twin } from "../api.ts";
import { CardHead } from "../components/Cards.tsx";
import { Item, Kv } from "../components/Kv.tsx";
import { count, exact, units } from "../format.ts";

export type TwinState = "equal" | "vault-higher" | "twin-higher" | "unknown";

/** The twin's supply set against what the vaults hold, both in the token's base units: a state and the difference, or "unknown" when the legs are too many to total. */
export function compareTwin(tw: Pick<Twin, "supply" | "vaultBalance">): { state: TwinState; diff: string } {
  if (tw.supply === null) return { state: "unknown", diff: "0" };
  const supply = BigInt(tw.supply), vault = BigInt(tw.vaultBalance);
  if (supply === vault) return { state: "equal", diff: "0" };
  return vault > supply ? { state: "vault-higher", diff: (vault - supply).toString() } : { state: "twin-higher", diff: (supply - vault).toString() };
}

/** The Canton twin of an ERC-20 a registered vault holds: the twin's supply (locks less releases, from the indexed legs) next to what the vaults hold of the token. */
export function TwinSupply({ t, twin: tw }: { t: TokenDetail; twin: Twin }) {
  const { state, diff } = compareTwin(tw);
  const d = t.decimals;
  const amount = (v: string) => d === null ? <span className="num">{count(v)}</span>
    : <><span className="num" title={exact(v, d)}>{units(v, d)}</span>{t.symbol ? ` ${t.symbol}` : ""}</>;
  return (
    <section className="card" aria-label="Canton twin">
      <CardHead as="h2" title="Canton twin" sub="the twin's supply against what the vaults hold" />
      <Kv>
        <Item label="Twin supply">{tw.supply === null ? <span className="muted">not totalled: more legs than one read counts</span> : amount(tw.supply)}</Item>
        <Item label="Held in vaults">{amount(tw.vaultBalance)}</Item>
        <dt className="kv-k">Check</dt>
        <dd className="kv-v" data-state={state}>
          {state === "equal" ? "Equal: the vaults hold exactly what the twin has in issue."
            : state === "vault-higher" ? <>The vaults hold {amount(diff)} more than the twin has in issue.</>
            : state === "twin-higher" ? <>The twin has {amount(diff)} more in issue than the vaults hold.</>
            : "The twin's supply is not totalled, so there is nothing to compare."}
        </dd>
        <Item label="Legs">{count(tw.locks)} locks · {count(tw.releases)} releases</Item>
      </Kv>
    </section>
  );
}

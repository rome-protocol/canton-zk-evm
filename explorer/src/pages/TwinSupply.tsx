import type { ReactNode } from "react";
import type { TokenDetail, TwinSupply as Twin } from "../api.ts";
import { CardHead } from "../components/Cards.tsx";
import { Item, Kv } from "../components/Kv.tsx";
import { count, exact, plural, units } from "../format.ts";

export type TwinState = "equal" | "vault-higher" | "twin-higher" | "unread";

/** The twin's supply set against what the vaults held at the same block, both in the token's base units: a state and the difference. With no vault balance at that block there is nothing to compare ("unread"). */
export function compareTwin(tw: Pick<Twin, "supply" | "vaultBalance">): { state: TwinState; diff: string } {
  if (tw.vaultBalance === null) return { state: "unread", diff: "0" };
  const supply = BigInt(tw.supply), vault = BigInt(tw.vaultBalance);
  if (supply === vault) return { state: "equal", diff: "0" };
  return vault > supply ? { state: "vault-higher", diff: (vault - supply).toString() } : { state: "twin-higher", diff: (supply - vault).toString() };
}

/**
 * The Canton twin of an ERC-20 a registered vault holds: the twin's supply (locks less releases, from the sums the indexer keeps) next to what the vaults held of the token at the same block.
 * Only the token's decimals and symbol are read from `t`. The twins page uses the card once per twin, naming it (`name`) and linking its token page (`action`).
 */
export function TwinSupply({ t, twin: tw, name = "Canton twin", action }: { t: Pick<TokenDetail, "decimals" | "symbol">; twin: Twin; name?: string; action?: ReactNode }) {
  const { state, diff } = compareTwin(tw);
  const d = t.decimals;
  const amount = (v: string) => d === null ? <span className="num">{count(v)}</span>
    : <><span className="num" title={exact(v, d)}>{units(v, d)}</span>{t.symbol ? ` ${t.symbol}` : ""}</>;
  return (
    <section className="card" aria-label={name}>
      <CardHead as="h2" title={name} sub="the twin's supply against what the vaults hold" action={action} />
      <Kv>
        <Item label="Twin supply">{amount(tw.supply)}</Item>
        <Item label="Held in vaults">{tw.vaultBalance === null ? <span className="muted">not read at this block</span> : amount(tw.vaultBalance)}</Item>
        <dt className="kv-k">Check</dt>
        <dd className="kv-v" data-state={state}>
          {state === "unread" ? "Not compared: the vaults' balance was not read at the block the twin is counted to."
            : state === "equal" ? "Equal: the vaults hold exactly what the twin has in issue."
            : state === "vault-higher" ? <>The vaults hold {amount(diff)} more than the twin has in issue.</>
            : <>The twin has {amount(diff)} more in issue than the vaults hold.</>}
        </dd>
        <Item label="Legs">{plural(tw.locks, "lock")} · {plural(tw.releases, "release")}{tw.through === null ? "" : <span className="muted"> · counted to block {count(tw.through)}</span>}</Item>
      </Kv>
    </section>
  );
}

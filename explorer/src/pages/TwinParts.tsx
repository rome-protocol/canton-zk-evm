import { useQuery } from "@tanstack/react-query";
import { getTwins, type TwinCanton, type TwinLine } from "../api.ts";
import { Amount } from "../components/Amount.tsx";
import { count, exact, units } from "../format.ts";

/** The one shared read of /api/twins: the Stats card and the twins page read through it, so they cannot disagree. */
export const useTwins = () => useQuery({ queryKey: ["twins"], queryFn: getTwins, refetchInterval: 30_000 });

export type MarkState = "matched" | "differs" | "unread";

/** A twin's mark: matched when the vaults hold what the twin has in issue; "unread" when the vaults' balance was not read at the block the twin is counted to. */
export const twinMark = (t: Pick<TwinLine, "matched" | "vaultBalance">): MarkState => (t.vaultBalance === null ? "unread" : t.matched ? "matched" : "differs");
/** A Canton token's mark: matched when Canton holds the wrapped supply; "unread" when the supply or the decimals are not known. */
export const cantonMark = (c: Pick<TwinCanton, "matched">): MarkState => (c.matched === null ? "unread" : c.matched ? "matched" : "differs");

const WORD: Record<MarkState, string> = { matched: "matched", differs: "differs", unread: "not compared" };
const TONE: Record<MarkState, string> = { matched: "ok", differs: "bad", unread: "off" };

/** The check's result as a dot and a word (the word says it, the colour only helps). */
export function Mark({ state }: { state: MarkState }) {
  return <span className={`sd ${TONE[state]}`} data-state={state}><i />{WORD[state]}</span>;
}

/** A token amount in whole units with the exact one in the tooltip. */
export function Tok({ raw, decimals, symbol }: { raw: string; decimals: number | null; symbol: string | null }) {
  if (decimals === null) return <span className="num" title="The token's decimals are not known, so this is the raw amount">{count(raw)}</span>;
  return symbol ? <Amount raw={raw} decimals={decimals} symbol={symbol} /> : <span className="num" title={exact(raw, decimals)}>{units(raw, decimals)}</span>;
}

import { useQuery } from "@tanstack/react-query";
import { getTokenInfo, type LegListItem } from "../api.ts";
import { Amount } from "../components/Amount.tsx";
import { HashLink } from "../components/HashLink.tsx";
import { Icon } from "../components/Icon.tsx";
import { LEGS_THIS_BLOCK } from "../copy.ts";

/** The token of a leg, as the token route names it. It reads no balance from reth, so a page of legs costs the database only. Null while unread or when the token cannot be read. */
export function useLegToken(token: string) {
  return useQuery({ queryKey: ["token-info", token], queryFn: () => getTokenInfo(token), retry: false, staleTime: 60_000 }).data ?? null;
}

/** The amount of a leg in whole tokens with the token's decimals; the raw amount, and nothing guessed, when they are not known. */
export function LegAmount({ l }: { l: Pick<LegListItem, "token" | "amount"> }) {
  const t = useLegToken(l.token);
  if (t?.decimals != null && t.symbol) return <Amount raw={l.amount} decimals={t.decimals} symbol={t.symbol} />;
  return <span className="mono" title="The token's decimals are not known, so this is the raw amount">{l.amount}</span>;
}

/** The token of a leg: its address as a link, with its symbol when the token has told it. */
export function LegToken({ token, full = false }: { token: string; full?: boolean }) {
  const t = useLegToken(token);
  return <><HashLink value={token} to={`/token/${token}`} full={full} />{t?.symbol && <span className="tag">{t.symbol}</span>}</>;
}

/** The line on what is not shown: the Daml side of a leg is not public. */
export function LegsPrivacy() {
  return <div className="legs" role="note"><Icon name="lock" size={14} /><span>{LEGS_THIS_BLOCK}</span></div>;
}

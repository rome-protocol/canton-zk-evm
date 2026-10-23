import type { TokenListItem } from "../api.ts";
import { Amount } from "../components/Amount.tsx";
import { count, exact, units } from "../format.ts";

/** Why a token has no name: the contract did not answer, has not been asked yet, or (an ERC-1155) has none to give. */
export function noName(t: Pick<TokenListItem, "standard" | "metadataStatus">): string {
  if (t.metadataStatus === "failed") return "Name not read";
  if (t.metadataStatus === "pending") return "Name not read yet";
  return t.standard === "ERC-1155" ? "No name (ERC-1155)" : "No name";
}

/** The total supply: in whole tokens with the token's decimals, a count for an NFT, the raw count when the decimals are not known, and a dash when the contract has not told it. */
export function Supply({ t }: { t: Pick<TokenListItem, "standard" | "decimals" | "symbol" | "totalSupply"> }) {
  const s = t.totalSupply;
  if (s === null) return <span className="muted" title="The contract has not told its supply">—</span>;
  if (t.standard === "ERC-721") return <span><span className="mono">{count(s)}</span> {s === "1" ? "token" : "tokens"}</span>;
  if (t.decimals === null) return <span className="mono" title="The token's decimals are not known, so this is the raw count">{count(s)}</span>;
  if (!t.symbol) return <span className="mono" title={exact(s, t.decimals)}>{units(s, t.decimals)}</span>;
  return <Amount raw={s} decimals={t.decimals} symbol={t.symbol} />;
}

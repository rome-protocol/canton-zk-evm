import type { TokenListItem } from "../api.ts";
import { Amount } from "../components/Amount.tsx";
import { count, exact, units } from "../format.ts";

/** Why a token has no name: the contract did not answer, has not been asked yet, or (an ERC-1155) has none to give. */
export function noName(t: Pick<TokenListItem, "standard" | "metadataStatus">): string {
  if (t.metadataStatus === "failed") return "Name not read";
  if (t.metadataStatus === "pending") return "Name not read yet";
  return t.standard === "ERC-1155" ? "No name (ERC-1155)" : "No name";
}

/** A count of NFTs: an ERC-721 holder's balance, and its supply. */
export function NftCount({ n }: { n: string }) {
  return <span><span className="mono">{count(n)}</span> {n === "1" ? "token" : "tokens"}</span>;
}

/**
 * The total supply: in whole tokens with the token's decimals, a count for an NFT, the raw count when the decimals are not known, and a dash when the contract has not told it.
 * With `bare` the symbol is left off, for a card that names it on the line under the number.
 */
export function Supply({ t, bare = false }: { t: Pick<TokenListItem, "standard" | "decimals" | "symbol" | "totalSupply">; bare?: boolean }) {
  const s = t.totalSupply;
  if (s === null) return <span className="muted" title="The contract has not told its supply">—</span>;
  if (t.standard === "ERC-721") return <NftCount n={s} />;
  if (t.decimals === null) return <span className="mono" title="The token's decimals are not known, so this is the raw count">{count(s)}</span>;
  if (!t.symbol || bare) return <span className="mono" title={`${exact(s, t.decimals)}${t.symbol ? ` ${t.symbol}` : ""}`}>{units(s, t.decimals)}</span>;
  return <Amount raw={s} decimals={t.decimals} symbol={t.symbol} />;
}

/** What the failed read left missing, in the words of the note: only the fields the contract did not give, and only those the standard has. */
export function failedNote(t: Pick<TokenListItem, "standard" | "name" | "symbol" | "decimals" | "totalSupply">): string {
  const erc20 = t.standard === "ERC-20";
  const missing = [
    t.standard !== "ERC-1155" && t.name === null ? "name" : null,
    t.standard !== "ERC-1155" && t.symbol === null ? "symbol" : null,
    erc20 && t.decimals === null ? "decimals" : null,
    t.standard !== "ERC-1155" && t.totalSupply === null ? "total supply" : null,
  ].filter((x): x is string => x !== null);
  const list = missing.length > 1 ? `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}` : (missing[0] ?? "details");
  const raw = erc20 && t.decimals === null ? ", so amounts are shown raw" : "";
  return `The explorer could not read this token's ${list} from the contract${raw}. The token and its transfers are real; only what could not be read is missing.`;
}

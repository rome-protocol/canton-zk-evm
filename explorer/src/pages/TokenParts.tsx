import { getTokenList, getTokenListOldest, type TokenListItem, type TokenListPage, type TokenSort, type TokenStandard } from "../api.ts";
import { Amount } from "../components/Amount.tsx";
import { useBothEnds } from "../components/Ends.tsx";
import { AddressCell } from "../components/AddressCell.tsx";
import { count, exact, short, units } from "../format.ts";
import type { Labels } from "../labels.ts";

/** A number that may wrap only after a comma, so a long supply never breaks in the middle of a group. */
export function Breaks({ text }: { text: string }) {
  const parts = text.split(",");
  return <>{parts.map((x, i) => <span key={i}>{x}{i < parts.length - 1 && <>,<wbr /></>}</span>)}</>;
}

const ZERO = "0x" + "00".repeat(20);
/** A party to a transfer: the zero address (a mint or a burn) in short form, anything else by its name where it has one. */
export function Mint({ address, labels }: { address: string; labels: Labels }) {
  return address === ZERO ? <span className="mono">{short(ZERO, 6, 4)}</span> : <AddressCell address={address} label={labels.get(address)} />;
}

/** Why a token has no name: the contract did not answer, has not been asked yet, or (an ERC-1155) has none to give. */
export function noName(t: Pick<TokenListItem, "standard" | "metadataStatus">): string {
  if (t.metadataStatus === "failed") return "Name not read";
  if (t.metadataStatus === "pending") return "Name not read yet";
  return t.standard === "ERC-1155" ? "No name (ERC-1155)" : "No name";
}

/** A count of NFTs: an ERC-721 holder's balance, and its supply. */
export function NftCount({ n }: { n: string }) {
  return <span><span className="num">{count(n)}</span> {n === "1" ? "token" : "tokens"}</span>;
}

/**
 * The total supply: in whole tokens with the token's decimals, a count for an NFT, the raw count when the decimals are not known, and a dash when the contract has not told it.
 * With `bare` the symbol is left off, for a card that names it on the line under the number.
 */
export function Supply({ t, bare = false }: { t: Pick<TokenListItem, "standard" | "decimals" | "symbol" | "totalSupply">; bare?: boolean }) {
  const s = t.totalSupply;
  if (s === null) return t.standard === "ERC-1155" ? <span className="muted" title="ERC-1155 has no total supply">—</span> : <span className="muted" title="The contract has not told its supply">—</span>;
  if (t.standard === "ERC-721") return <NftCount n={s} />;
  if (t.decimals === null) return <span className="num" title="The token's decimals are not known, so this is the raw count"><Breaks text={count(s)} /></span>;
  if (!t.symbol || bare) return <span className="num" title={`${exact(s, t.decimals)}${t.symbol ? ` ${t.symbol}` : ""}`}><Breaks text={units(s, t.decimals)} /></span>;
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

/** The letters in a token's avatar: the first letter of each of the first two words of its name ("Ostia Pass" is OP), or the first two of a single word, or of its symbol. */
export function initials(t: Pick<TokenListItem, "name" | "symbol">): string {
  const words = (t.name ?? t.symbol ?? "").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const chars = words.length > 1 ? words.slice(0, 2).map((w) => Array.from(w)[0]!).join("") : Array.from(words[0] ?? "").slice(0, 2).join("");
  return (chars || "?").toUpperCase();
}

/** A round avatar of a token's initials; its colour is from the address, so a token keeps its own wherever it is shown. */
export function Avatar({ t }: { t: Pick<TokenListItem, "address" | "name" | "symbol"> }) {
  const hue = (parseInt(t.address.slice(2, 6), 16) || 0) % 360;
  return <span className="tok-av" data-testid="avatar" aria-hidden="true" style={{ background: `hsl(${hue} 42% 36%)` }}>{initials(t)}</span>;
}

type ListFilter = { sort: TokenSort; standard?: TokenStandard; gateway: boolean };

/** The token list, a page at a time, with a known last page: the shared two-ended reader, over the token list's two ends. */
export function useTokenList(f: ListFilter, per: number, refetchInterval: number | false) {
  return useBothEnds<TokenListPage>(["tokens", f], per, (at, n) => getTokenList(f.sort, at, n, f.standard, f.gateway), (at, n) => getTokenListOldest(f.sort, at, n, f.standard, f.gateway), refetchInterval);
}

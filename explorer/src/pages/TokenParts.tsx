import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getTokenList, getTokenListOldest, type TokenListItem, type TokenListPage, type TokenSort, type TokenStandard } from "../api.ts";
import { Amount } from "../components/Amount.tsx";
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
  if (s === null) return <span className="muted" title="The contract has not told its supply">—</span>;
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

/**
 * The token list, a page at a time, with a known last page. The API pages by a key (the `next` of the page before), so a page is reached by walking it: from the top
 * (newest or most first) by `before`, and the last page by reading from the other end (`order=asc`) with exactly what the last page holds (the total modulo the page size, or a whole
 * page when it divides), so that the two ends never overlap. From the last page, back is further along that end's key, and the rows are drawn in the list's own order.
 * `go(n)` reaches the first and last pages and the one beside this: the ones the buttons ask for.
 */
export function useTokenList(f: ListFilter, per: number, refetchInterval: number | false) {
  const id = JSON.stringify(f);
  const [st, setSt] = useState<{ id: string; end: boolean; keys: Array<string | null>; lastN: number }>({ id, end: false, keys: [null], lastN: per });
  const cur = st.id === id ? st : { id, end: false, keys: [null], lastN: per };
  const at = cur.keys[cur.keys.length - 1] ?? null;
  const q = useQuery<TokenListPage>({
    queryKey: ["tokens", f, cur.end, at, cur.end ? cur.lastN : per],
    queryFn: () => (cur.end ? getTokenListOldest(f.sort, at, cur.keys.length === 1 ? cur.lastN : per, f.standard, f.gateway) : getTokenList(f.sort, at, per, f.standard, f.gateway)),
    placeholderData: keepPreviousData,
    refetchInterval,
  });
  const total = q.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / per));
  const page = cur.end ? Math.max(1, pages - cur.keys.length + 1) : cur.keys.length;
  const ready = !q.isPlaceholderData && !!q.data;
  const items = q.data ? (cur.end ? [...q.data.items].reverse() : q.data.items) : undefined;
  const set = (end: boolean, keys: Array<string | null>, lastN = cur.lastN) => setSt({ id, end, keys, lastN });
  const go = (n: number) => {
    if (n === 1) return set(false, [null]);
    if (!ready || n < 1 || n > pages || n === page) return undefined;
    const next = q.data?.next ?? null;
    // A page beside this one is walked to; only the last page from further off is read from the other end.
    if (n === page + 1 && (cur.end ? cur.keys.length > 1 : next !== null)) return set(cur.end, cur.end ? cur.keys.slice(0, -1) : [...cur.keys, next]);
    if (n === page - 1 && (cur.end ? next !== null : cur.keys.length > 1)) return set(cur.end, cur.end ? [...cur.keys, next] : cur.keys.slice(0, -1));
    return n === pages ? set(true, [null], total % per || per) : undefined;
  };
  return { data: q.data, items, error: q.error, page, pages, from: (page - 1) * per, go };
}

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { getContractList, getContractListOldest, type ContractListItem, type ContractListPage, type ContractSort } from "../api.ts";
import { Icon } from "../components/Icon.tsx";

/** What a partial match means, as the API words it with a contract's own verification. */
export const PARTIAL_MATCH_NOTE = "Partial match: the metadata differs from this compile. Code that reads its own or another contract's code (type(X).creationCode/runtimeCode, codecopy, extcodecopy, address(this).code) may act differently from this source's compile; only a full match is byte-for-byte.";

const MATCH = { full: "Full match", partial: "Partial match", similar: "Similar match" } as const;
const MEANS = {
  full: "The compiled code and its metadata hash match the code on chain.",
  partial: PARTIAL_MATCH_NOTE,
  similar: "The same code is verified at another address; this contract has no source of its own.",
} as const;

/** The match kind of a verified contract, or "Not verified". A partial match is marked in the amber colour, with its meaning in the hover text. */
export function MatchChip({ matchType }: { matchType: ContractListItem["matchType"] }) {
  if (!matchType) return <span className="chip chip-kind">Not verified</span>;
  return <span className={`chip ${matchType === "full" ? "chip-final" : "chip-building"}`} title={MEANS[matchType]}>{matchType === "full" && <Icon name="check" size={12} />}{MATCH[matchType]}</span>;
}

export const matchWord = (matchType: NonNullable<ContractListItem["matchType"]>) => MATCH[matchType];
export const matchMeans = (matchType: NonNullable<ContractListItem["matchType"]>) => MEANS[matchType];

/** The forge command that verifies a contract against this explorer's own Etherscan-compatible door. */
export const forgeCommand = (address: string, name: string, chainId: number) =>
  `forge verify-contract ${address} ${name} --chain-id ${chainId} --verifier etherscan --verifier-url ${window.location.origin}/api --etherscan-api-key none`;

/** The compiler of a verified source as a row's sub-line: "Solidity v0.8.28" from "v0.8.28+commit.7893614a", a Vyper or unfamiliar version as it is given. */
export function compilerLine(version: string): string {
  const solc = /^(v\d+\.\d+\.\d+)(?:\+|$)/.exec(version);
  return solc ? `Solidity ${solc[1]}` : version;
}

type ListFilter = { sort: ContractSort; verified: boolean | null };

/**
 * The contract list, a page at a time, with a known last page, the way the token list is read: the API pages by a key (the `next` of the page before), so a page is reached by walking it
 * from the top by `before`, and the last page by reading from the other end (`order=asc`) with exactly what the last page holds (the total modulo the page size, or a whole page when it
 * divides), so that the two ends never overlap. `go(n)` reaches the first and last pages and the one beside this: the ones the buttons ask for.
 */
export function useContractList(f: ListFilter, per: number, refetchInterval: number | false) {
  const id = JSON.stringify(f);
  const [st, setSt] = useState<{ id: string; end: boolean; keys: Array<string | null>; lastN: number }>({ id, end: false, keys: [null], lastN: per });
  const cur = st.id === id ? st : { id, end: false, keys: [null], lastN: per };
  const at = cur.keys[cur.keys.length - 1] ?? null;
  const q = useQuery<ContractListPage>({
    queryKey: ["contracts", f, cur.end, at, cur.end ? cur.lastN : per],
    queryFn: () => (cur.end ? getContractListOldest(f.sort, f.verified, at, cur.keys.length === 1 ? cur.lastN : per) : getContractList(f.sort, f.verified, at, per)),
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
    if (n === page + 1 && (cur.end ? cur.keys.length > 1 : next !== null)) return set(cur.end, cur.end ? cur.keys.slice(0, -1) : [...cur.keys, next]);
    if (n === page - 1 && (cur.end ? next !== null : cur.keys.length > 1)) return set(cur.end, cur.end ? [...cur.keys, next] : cur.keys.slice(0, -1));
    return n === pages ? set(true, [null], total % per || per) : undefined;
  };
  return { data: q.data, items, error: q.error, page, pages, from: (page - 1) * per, go };
}

import { useQuery } from "@tanstack/react-query";
import { getAddressDetail, getContractList, getContractListOldest, type ContractListItem, type ContractListPage, type ContractSort } from "../api.ts";
import { useBothEnds } from "../components/Ends.tsx";
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

/** The compiler of a verified source as a row's sub-line: "Solidity v0.8.28" from the stored "0.8.28+commit.7893614a" (a leading "v" is taken too), a Vyper or unfamiliar version as it is given. */
export function compilerLine(version: string): string {
  const solc = /^v?(\d+\.\d+\.\d+)(?:\+|$)/.exec(version);
  return solc ? `Solidity v${solc[1]}` : version;
}

type ListFilter = { sort: ContractSort; verified: boolean | null };

/**
 * The contract list, a page at a time, with a known last page, the way the token list is read: the API pages by a key (the `next` of the page before), so a page is reached by walking it
 * from the top by `before`, and the last page by reading from the other end (`order=asc`) with exactly what the last page holds (the total modulo the page size, or a whole page when it
 * divides), so that the two ends never overlap. `go(n)` reaches the first and last pages and the one beside this: the ones the buttons ask for.
 */
export function useContractList(f: ListFilter, per: number, refetchInterval: number | false) {
  return useBothEnds<ContractListPage>(["contracts", f], per, (at, n) => getContractList(f.sort, f.verified, at, n), (at, n) => getContractListOldest(f.sort, f.verified, at, n), refetchInterval);
}

const TOOL = { forge: "forge verify-contract", hardhat: "Hardhat", remix: "Remix", unknown: "another tool" } as const;

/** How a source was sent to be verified, as the contract records it: the door it came in by and the tool the submitter named. Forge and Hardhat name none, so no tool is guessed. */
export function howVerified(method: "etherscan" | "api" | null, tool: keyof typeof TOOL | null): string {
  if (!method) return "Not recorded";
  return `${method === "etherscan" ? "Etherscan-compatible API" : "/api/verify"} · ${tool ? TOOL[tool] : "tool not given"}`;
}

const BEFORE_PRAGUE = ["homestead", "tangerineWhistle", "spuriousDragon", "byzantium", "constantinople", "petersburg", "istanbul", "berlin", "london", "paris", "shanghai", "cancun"];

/** What the compile's EVM version means on this chain: the chain runs Prague rules, so code compiled for an earlier version runs unchanged. Null for prague, for no version, or one not known. */
export const evmVersionNote = (version: string | null, chain: string): string | null =>
  version && BEFORE_PRAGUE.includes(version) ? `${chain} runs Prague rules; ${version} code runs unchanged` : null;

/** The coin a token's amounts are written in. */
export interface Coin { symbol: string; decimals: number }

/** The coin of an ERC-20 contract, from the address record the page already read (same key as the page's own query); null for any other contract, or when the decimals are not known. */
export function useCoin(detail: { address: string; standard?: string | null }): Coin | null {
  const rec = useQuery({ queryKey: ["address-detail", detail.address], queryFn: () => getAddressDetail(detail.address) }).data?.token;
  return detail.standard === "ERC-20" && rec && rec.decimals !== null ? { symbol: rec.symbol ?? "", decimals: rec.decimals } : null;
}

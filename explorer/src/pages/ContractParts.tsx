import type { ContractListItem } from "../api.ts";
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

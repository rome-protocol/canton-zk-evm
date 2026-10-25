import type { Label, TokenMove } from "../api.ts";
import { compactUnits, count, exact, short, units } from "../format.ts";
import { labelName } from "../labels.ts";
import { Icon } from "./Icon.tsx";

/** An amount in whole coins or tokens, with the exact amount in its tooltip. The symbol is the contract's own words, set apart in a bdi. */
export function Amount({ raw, decimals, symbol, compact = false }: { raw: string; decimals: number; symbol: string; compact?: boolean }) {
  return (
    <span title={`${exact(raw, decimals)} ${symbol}`}>
      <span className="num">{compact ? compactUnits(raw, decimals) : units(raw, decimals)}</span> <bdi>{symbol}</bdi>
    </span>
  );
}

/**
 * The first token move of a transaction as a chip: "100 tUSD" for an amount of a fungible token, "OPASS #3" for a token id.
 * `label` is the token's label from `useLabels`. A token with no symbol is told by its short address, and the tooltip says so.
 * Where the decimals are not known (neither the move's nor the label's) it shows the raw count in the token's smallest unit and says that.
 */
export function TokenChip({ move, label, compact = false }: { move: TokenMove; label?: Label | null; compact?: boolean }) {
  const symbol = label?.symbol ?? null;
  const name = symbol ?? short(move.token, 8, 4);
  const notes: string[] = [];
  if (!symbol) notes.push("The name of this token is not known.");
  // The words are the contract's own: set apart (bdi) so that they cannot reorder the text beside the chip, and cut short if very long.
  const text = (words: string) => <bdi className="tname">{words}</bdi>;
  if (move.tokenId !== null) {
    const copies = move.amount !== null && move.amount !== "1" ? `${count(move.amount)} × ` : "";
    // A token id can be 78 digits: the chip keeps its ends, and the tooltip the whole id.
    // The symbol alone is in a bdi: the copies and the id stand outside it, so a right-to-left symbol cannot reorder them.
    return <span className="tchip tchip-nft" title={[labelName(label) ?? move.token, `#${move.tokenId}`, ...notes].join(" ")}><span className="tname">{copies}<bdi>{name}</bdi>{` #${short(move.tokenId, 6, 4)}`}</span></span>;
  }
  if (move.amount === null) return <span className="tchip tchip-ft" title={[...notes, "The amount is not in the logs."].join(" ")}><Icon name="coin" size={12} />{text(name)}</span>;
  const decimals = move.decimals ?? label?.decimals ?? null;
  if (decimals === null) {
    notes.push("Its decimals are not known, so this is the raw count in the token's smallest unit.");
    return <span className="tchip tchip-ft" title={[`${count(move.amount)} ${name}`, ...notes].join(" ")}><Icon name="coin" size={12} />{text(`${count(move.amount)} ${name}`)}</span>;
  }
  return <span className="tchip tchip-ft" title={[`${exact(move.amount, decimals)} ${name}`, ...notes].join(" ")}><Icon name="coin" size={12} />{text(`${compact ? compactUnits(move.amount, decimals) : units(move.amount, decimals)} ${name}`)}</span>;
}

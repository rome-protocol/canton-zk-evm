import type { Label, TokenMove } from "../api.ts";
import { count, exact, short, units } from "../format.ts";
import { labelName } from "../labels.ts";
import { Icon } from "./Icon.tsx";

/**
 * An amount in whole coins or tokens, with the exact amount in its tooltip. The symbol is the contract's own words, and so is a token id
 * beside it (when `tokenId` is given): each is set apart in its own bdi, so a hostile right-to-left symbol cannot reorder the id.
 */
export function Amount({ raw, decimals, symbol, tokenId }: { raw: string; decimals: number; symbol: string; tokenId?: string | null }) {
  return (
    <span title={`${exact(raw, decimals)} ${symbol}${tokenId ? ` #${tokenId}` : ""}`}>
      <span className="num">{units(raw, decimals)}</span> <bdi>{symbol}</bdi>{tokenId ? <> <bdi>{`#${tokenId}`}</bdi></> : null}
    </span>
  );
}

/**
 * The first token move of a transaction as a chip: "100 tUSD" for an amount of a fungible token, "OPASS #3" for a token id.
 * `label` is the token's label from `useLabels`. A token with no symbol is told by its short address, and the tooltip says so.
 * Where the decimals are not known (neither the move's nor the label's) it shows the raw count in the token's smallest unit and says that.
 */
export function TokenChip({ move, label }: { move: TokenMove; label?: Label | null }) {
  const symbol = label?.symbol ?? null;
  const name = symbol ?? short(move.token, 8, 4);
  const notes: string[] = [];
  if (!symbol) notes.push("The name of this token is not known.");
  // The words are the contract's own: set apart (bdi) so that they cannot reorder the text beside the chip, and cut short if very long.
  const text = (words: string) => <bdi className="tname">{words}</bdi>;
  if (move.tokenId !== null) {
    const copies = move.amount !== null && move.amount !== "1" ? `${count(move.amount)} × ` : "";
    // A token id can be 78 digits: the chip keeps its ends, and the tooltip the whole id.
    return <span className="tchip tchip-nft" title={[labelName(label) ?? move.token, `#${move.tokenId}`, ...notes].join(" ")}>{text(`${copies}${name} #${short(move.tokenId, 6, 4)}`)}</span>;
  }
  if (move.amount === null) return <span className="tchip tchip-ft" title={[...notes, "The amount is not in the logs."].join(" ")}><Icon name="coin" size={12} />{text(name)}</span>;
  const decimals = move.decimals ?? label?.decimals ?? null;
  if (decimals === null) {
    notes.push("Its decimals are not known, so this is the raw count in the token's smallest unit.");
    return <span className="tchip tchip-ft" title={notes.join(" ")}><Icon name="coin" size={12} />{text(`${count(move.amount)} ${name}`)}</span>;
  }
  return <span className="tchip tchip-ft" title={[`${exact(move.amount, decimals)} ${name}`, ...notes].join(" ")}><Icon name="coin" size={12} />{text(`${units(move.amount, decimals)} ${name}`)}</span>;
}

import type { Label, TokenMove } from "../api.ts";
import { count, exact, short, units } from "../format.ts";
import { labelName } from "../labels.ts";
import { Icon } from "./Icon.tsx";

/** An amount in whole coins or tokens, with the exact amount in its tooltip. */
export function Amount({ raw, decimals, symbol }: { raw: string; decimals: number; symbol: string }) {
  return <span title={`${exact(raw, decimals)} ${symbol}`}><span className="num">{units(raw, decimals)}</span> {symbol}</span>;
}

/**
 * The first token move of a transaction as a chip: "100 tUSD" for an amount of a fungible token, "OPASS #3" for a token id.
 * `label` is the token's label from `useLabels`. A token with no symbol is told by its short address, and the tooltip says so.
 * Where the decimals are not known (neither the move's nor the label's) it shows the raw count in the token's smallest unit and says that.
 */
export function TokenChip({ move, label }: { move: TokenMove; label?: Label | null }) {
  const symbol = label?.symbol ?? null;
  const name = symbol ?? short(move.token);
  const notes: string[] = [];
  if (!symbol) notes.push("The name of this token is not known.");
  if (move.tokenId !== null) {
    const copies = move.amount !== null && move.amount !== "1" ? `${count(move.amount)} × ` : "";
    return <span className="tchip tchip-nft" title={[labelName(label) ?? move.token, ...notes].join(" ")}>{copies}{name} #{move.tokenId}</span>;
  }
  if (move.amount === null) return <span className="tchip tchip-ft" title={[...notes, "The amount is not in the logs."].join(" ")}><Icon name="coin" size={12} />{name}</span>;
  const decimals = move.decimals ?? label?.decimals ?? null;
  if (decimals === null) {
    notes.push("Its decimals are not known, so this is the raw count in the token's smallest unit.");
    return <span className="tchip tchip-ft" title={notes.join(" ")}><Icon name="coin" size={12} />{count(move.amount)} {name}</span>;
  }
  return <span className="tchip tchip-ft" title={[`${exact(move.amount, decimals)} ${name}`, ...notes].join(" ")}><Icon name="coin" size={12} />{`${units(move.amount, decimals)} ${name}`}</span>;
}

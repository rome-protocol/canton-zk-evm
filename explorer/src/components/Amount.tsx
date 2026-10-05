import { exact, units } from "../format.ts";

/** An amount in whole coins or tokens, with the exact amount in its tooltip. */
export function Amount({ raw, decimals, symbol }: { raw: string; decimals: number; symbol: string }) {
  return <span title={`${exact(raw, decimals)} ${symbol}`}><span className="mono">{units(raw, decimals)}</span> {symbol}</span>;
}

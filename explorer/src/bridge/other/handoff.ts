// What the card of a route through Solgate says, as plain data: the page signs nothing on these routes, it names the steps and opens Solgate, where every step is made. The words follow the page's
// rules: "Claim" for the person's own claim, never "Receive"; no "pending", no builder words, nobody acting after the person's own transaction; "AggLayer", never "other chains".
import type { HandoffRow, HandoffToken, OstiaChain } from "./setup.ts";
import { timeWords } from "./words.ts";

/** The id of the route whose end is a Solana wallet: its claim is made there, in SOL. */
export const SOLANA_ROUTE = "solana-devnet";
/** The symbol of Canton Coin where a route offers it. */
const CANTON_COIN = "CC";

export interface HandoffStep { label: string; detail: string }
export interface HandoffView {
  intro: string;
  steps: HandoffStep[];
  /** "ETH: about 6 minutes from Ostia, about 4 minutes to Ostia": only where a measured time is set; none shows no line. */
  times: string[];
  /** Where a token has more places on Ostia than the other end holds. */
  places: string[];
  trust: string[];
  back: string;
  /** Solgate's page, and its Claim tab. Solgate reads only the tab from the address, so the card names the rest. */
  open: string;
  claim: string;
}

/** The time of a token on one leg: its own, else the route's. */
const timeOf = (t: HandoffToken, row: HandoffRow, leg: "in" | "out") => timeWords(t.times[leg] ?? row.times[leg]);

export function handoffView(row: HandoffRow, ostia: OstiaChain, ostiaCoin: string): HandoffView {
  const solana = row.id === SOLANA_ROUTE;
  const end = solana ? "Solana" : row.name;
  const claim: HandoffStep = solana
    ? { label: "Claim in your Solana wallet", detail: "your Solana wallet, a little SOL" }
    : { label: `Claim on ${row.name}`, detail: `your EVM wallet, a little ${row.coin ?? `of ${row.name}'s coin`}` };
  const has = (symbol: string) => row.assets.some((t) => t.symbol === symbol);
  const trust: string[] = [];
  if (has("ETH")) trust.push(solana ? "Ostia cannot send out more ETH than came in. On Solana it is Solgate's copy, under Solgate's terms." : "Ostia cannot send out more ETH than came in.");
  if (has(CANTON_COIN)) trust.push(`The copy of Canton Coin on ${end} rests on the coin Rome holds on Canton and on Rome's key that signs what leaves ${ostia.name}. It travels through Solgate, which has its own terms. AggLayer's balance check does not cover it.`);
  return {
    intro: `Every step to ${end} is in Solgate.`,
    steps: [{ label: `Send from your ${ostia.name} wallet`, detail: `your EVM wallet, a little ${ostiaCoin}` }, { label: "Wait until it is ready to claim", detail: "" }, claim],
    times: row.assets.flatMap((t) => {
      const parts = [[timeOf(t, row, "out"), `from ${ostia.name}`], [timeOf(t, row, "in"), `to ${ostia.name}`]].filter((p): p is [string, string] => p[0] !== null).map(([w, where]) => `${w} ${where}`);
      return parts.length ? [`${t.symbol}: ${parts.join(", ")}`] : [];
    }),
    places: solana ? row.assets.filter((t) => t.places < t.decimals).map((t) => `${t.symbol} has ${t.decimals} decimal places on ${ostia.name} and ${t.places} on Solana. The places past ${t.places} are dropped on the way.`) : [],
    trust,
    back: `To come back, send from ${solana ? "your Solana wallet" : `your wallet on ${row.name}`} in Solgate, then claim on ${ostia.name} there.`,
    open: `${row.solgate}/`,
    claim: `${row.solgate}/?tab=claim`,
  };
}

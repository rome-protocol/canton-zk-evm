// The tokens the move card offers: what this build's bridge configuration supports and nothing more. Each token is one half of a pair: a twin (an ERC-20 of Ostia and the same token on Canton), or
// a wrapped token (a Canton token and its ERC-20 on Ostia). A move goes from one half to the other. This file holds no list of tokens of its own.
import type { Address } from "viem";
import type { BridgeConfig } from "./evm/config.ts";
import type { MoveInput, MoveKind } from "./moves/state.ts";

export type Side = "ostia" | "canton";

export interface Pair {
  key: string;
  kind: "twin" | "wrapped";
  /** The chain's own coin: it is wrapped (WtROME) as it moves. */
  native: boolean;
  /** For the chain's coin, the symbol of its wrapped form (WtROME): what arrives on the chain when the coin comes back from Canton. Null for every other token. */
  wrapped: string | null;
  /** The ERC-20 on Ostia: the twin, or the wrapped token. For the chain's coin, its wrapped form. */
  erc20: Address;
  ostia: { symbol: string; decimals: number };
  /** The token on Canton: the instrument (its registry's party and its id) and its decimals (always 10). */
  canton: { symbol: string; admin: string; id: string; decimals: number };
}

/** One row of the picker: a token on one side. */
export interface Token { key: string; pair: string; side: Side; symbol: string; decimals: number }

const bare = (a: string) => a.replace(/^0x/, "").toLowerCase();
/** Canton's own coin is an instrument called "Amulet": people know it as Canton Coin. */
export const CANTON_COIN = "Canton Coin";
/** A wrapped token's name on Canton: Canton Coin for the Amulet instrument, otherwise "wTKB" is "TKB" (or the instrument's id when the symbol does not start with w). */
const cantonName = (wrapped: string, id: string) => (id === "Amulet" ? CANTON_COIN : /^w[A-Z]/.test(wrapped) ? wrapped.slice(1) : id);

/** The pairs this build can move. `gateway` is the Canton party that issues the twins on Canton (the build's chain gateway). */
export function pairsOf(config: BridgeConfig, gateway: string): Pair[] {
  const twins = config.twins.map((t): Pair => {
    const native = config.wrapper !== null && t.address === config.wrapper;
    const symbol = native ? config.chain.coin.symbol : t.symbol;
    return { key: `twin:${t.address}`, kind: "twin", native, wrapped: native ? t.symbol : null, erc20: t.address, ostia: { symbol, decimals: t.decimals }, canton: { symbol, admin: gateway, id: `erc20:${bare(t.address)}`, decimals: 10 } };
  });
  twins.sort((a, b) => Number(b.native) - Number(a.native));
  const wrapped = config.wrapped.filter((w) => w.instrument).map((w): Pair => ({
    key: `wrapped:${w.address}`, kind: "wrapped", native: false, wrapped: null, erc20: w.address, ostia: { symbol: w.symbol, decimals: w.decimals },
    canton: { symbol: cantonName(w.symbol, w.instrument!.id), admin: w.instrument!.admin, id: w.instrument!.id, decimals: 10 },
  }));
  return [...twins, ...wrapped];
}

/** What a token is called where it arrives: the chain's own coin coming back from Canton arrives as its wrapped form. */
export const arrivesAs = (pair: Pair, from: Side): string => (from === "ostia" ? pair.canton.symbol : pair.wrapped ?? pair.ostia.symbol);

/** The picker's two groups, in order. */
export function groupsOf(pairs: Pair[]): { ostia: Token[]; canton: Token[] } {
  const row = (p: Pair, side: Side): Token => ({ key: `${p.key}@${side}`, pair: p.key, side, symbol: side === "ostia" ? p.ostia.symbol : p.canton.symbol, decimals: side === "ostia" ? p.ostia.decimals : p.canton.decimals });
  return { ostia: pairs.map((p) => row(p, "ostia")), canton: pairs.map((p) => row(p, "canton")) };
}

/** The tokens whose symbol, address or id has `query` in it (case does not matter). */
export function search(list: Token[], pairs: Pair[], query: string): Token[] {
  const q = query.trim().toLowerCase();
  if (q === "") return list;
  return list.filter((t) => {
    const p = pairs.find((x) => x.key === t.pair)!;
    return [t.symbol, t.side === "ostia" ? p.erc20 : p.canton.id, t.side === "canton" ? p.canton.admin : ""].some((s) => s.toLowerCase().includes(q));
  });
}

/** Which of the four moves takes this pair from `from`. */
export function moveOf(pair: Pair, from: Side): MoveKind {
  return pair.kind === "twin" ? (from === "ostia" ? "lock" : "redeem") : from === "canton" ? "deposit" : "withdraw";
}

/** The move's input for the library. `receiver` is the person's Canton account (only a lock names it). */
export function inputOf(pair: Pair, from: Side, amount: string, receiver: string): MoveInput {
  switch (moveOf(pair, from)) {
    case "lock": return { kind: "lock", asset: pair.erc20, amount, receiver, ...(pair.native ? { wrapNative: true } : {}) };
    case "redeem": return { kind: "redeem", asset: pair.erc20, amount };
    case "deposit": return { kind: "deposit", asset: pair.erc20, amount };
    case "withdraw": return { kind: "withdraw", asset: pair.erc20, amount };
  }
}

/** The facts the picker shows for a token. Labels are plain: an Ostia token has an address, a Canton token an id. */
export function factsOf(row: Token, pairs: Pair[], chainName: string): { label: string; value: string }[] {
  const p = pairs.find((x) => x.key === row.pair)!;
  const here = row.side === "ostia";
  const other = here ? p.canton.symbol : p.ostia.symbol, otherChain = here ? "Canton" : chainName;
  const facts = [{ label: here ? "Address" : "Token id", value: here ? p.erc20 : p.canton.id }, { label: "Decimals", value: String(row.decimals) }];
  if (here && p.native) facts[0] = { label: "Wrapped form's address", value: p.erc20 };
  facts.push({ label: "Twin of", value: p.kind === "twin" ? `${other} on ${otherChain}` : here ? `${other} on Canton (wrapped here)` : `${other} on ${otherChain} (its wrapped form)` });
  return facts;
}

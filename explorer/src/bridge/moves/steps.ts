// The steps of each move, in words, for the folded line under the move button: who signs each one, and how many pop-ups the wallet shows.
import type { MoveKind } from "./state.ts";

/** wallet: a pop-up of the wallet. page: this page signs with the person's Canton account, with no pop-up. auto: nothing to sign. */
export interface StepLine { text: string; by: "wallet" | "page" | "auto" }

export function stepsOf(kind: MoveKind, symbol: string, native: boolean, chainName: string): StepLine[] {
  switch (kind) {
    case "lock": return [
      ...(native ? [{ text: `Wrap ${symbol}`, by: "wallet" as const }] : []),
      { text: `Approve ${symbol}`, by: "wallet" }, { text: `Pay ${symbol} in`, by: "wallet" }, { text: "Canton shows it in your account", by: "auto" },
    ];
    case "redeem": return [{ text: `Sign the move back on Canton`, by: "page" }, { text: "Canton shows it", by: "auto" }, { text: `Release ${symbol} on ${chainName}`, by: "wallet" }];
    case "deposit": return [{ text: "Sign the deposit on Canton (two signatures)", by: "page" }, { text: "Canton shows it", by: "auto" }, { text: `Claim ${symbol} on ${chainName}`, by: "wallet" }];
    case "withdraw": return [{ text: `Withdraw ${symbol} to Canton`, by: "wallet" }, { text: "Canton shows it in your account", by: "auto" }];
  }
}

/** How many pop-ups the wallet shows for the move. */
export const popups = (steps: StepLine[]) => steps.filter((s) => s.by === "wallet").length;
/** How many signatures the Canton account makes for the move. */
export const cantonSignatures = (kind: MoveKind) => (kind === "redeem" ? 1 : kind === "deposit" ? 2 : 0);

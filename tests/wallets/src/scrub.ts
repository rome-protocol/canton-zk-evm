// Takes the throwaway seed's words and the unlock password out of any text that is logged or written to a result: a wallet's failing screen may show them. Every whole word of the phrase is removed,
// so a few ordinary words that are also in the phrase are removed from a reason too (that is the price of never letting a word through).
export interface Secret { mnemonic: string; unlock: string }

export function scrubber(secret: Secret): (text: string) => string {
  const words = [...new Set(secret.mnemonic.split(/\s+/).filter((w) => w.length >= 3))];
  const parts = [...new Set([secret.unlock, ...secret.unlock.split("!")])].filter((p) => p.length >= 4);
  const wordRe = words.length ? new RegExp(`\\b(${words.join("|")})\\b`, "gi") : null;
  return (text: string) => {
    let out = text;
    for (const p of parts) out = out.split(p).join("[removed]");
    return wordRe ? out.replace(wordRe, "[removed]") : out;
  };
}

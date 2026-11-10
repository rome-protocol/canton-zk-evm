// Takes the throwaway seed's words and the unlock password out of any text that is logged or written to a result: a wallet's failing screen may show them. Every whole word of the phrase is removed,
// so a few ordinary words that are also in the phrase are removed from a reason too (that is the price of never letting a word through).
export interface Secret { mnemonic: string; unlock: string }

/** A last check on a harness message that is written to a result: it takes out the unlock password and any two phrase words in a row, and nothing else, so that the harness's own fixed words ("ready" and the like) are not
 * taken out because the phrase happens to have them (which would show that they are in the phrase). The screen text that a message carries is scrubbed word by word where it is read (`describe` in browser.ts). */
export function guard(secret: Secret): (text: string) => string {
  const words = secret.mnemonic.split(/\s+/).filter(Boolean);
  const pairs = [...new Set(words.slice(0, -1).map((w, i) => `${w}\\s+${words[i + 1]}`))];
  const parts = [...new Set([secret.unlock, ...secret.unlock.split("!")])].filter((p) => p.length >= 4);
  const pairRe = pairs.length ? new RegExp(`\\b(${pairs.join("|")})\\b`, "gi") : null;
  return (text: string) => {
    let out = text;
    for (const p of parts) out = out.split(p).join("[removed]");
    return pairRe ? out.replace(pairRe, "[removed]") : out;
  };
}

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

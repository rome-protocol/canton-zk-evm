// Byte and text forms shared by the account library's files. They sit apart from key.ts so that key.ts can call topology.ts's check without a circular import.
export const bytesFromHex = (hex: string): Uint8Array => {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(h)) throw new Error("not hex");
  return Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
};
export const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const base64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));
export const fromBase64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

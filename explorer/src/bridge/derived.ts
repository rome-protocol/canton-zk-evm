// The code of the Bridge account made from a wallet signature, asked for only in a build that has it (`__BRIDGE_ACCOUNT__`, src/vite-env.d.ts: true only when the build's VITE_BRIDGE_ACCOUNT is `on`).
// In every other build the `import()`s below go with their branch, so the pages carry no key derivation, no kept-key store and no account-service client. Each answers null there.

/** The account's code: sign in, reopen a kept key, close, the Canton Coin faucet (account.ts). */
export async function accountCode(): Promise<typeof import("./account.ts") | null> {
  if (__BRIDGE_ACCOUNT__) return import("./account.ts");
  return null;
}
/** What signs and sends on Canton for an open account (send.ts). */
export async function senderCode(): Promise<typeof import("./send.ts") | null> {
  if (__BRIDGE_ACCOUNT__) return import("./send.ts");
  return null;
}
/** The store of the keys this browser keeps (canton/keystore.ts). */
export async function keystoreCode(): Promise<typeof import("./canton/keystore.ts") | null> {
  if (__BRIDGE_ACCOUNT__) return import("./canton/keystore.ts");
  return null;
}

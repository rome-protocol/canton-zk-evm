// The dApp SDK imports WalletConnect's client for its WalletConnect adapter, an optional part this build does not install and the Bridge never uses. The page's build (vite.config.ts) and the tests that
// load the SDK (vitest.config.ts) are given this in its place: left unresolved, the import throws when the SDK's script loads, and no wallet could connect.
export default class SignClient {
  static init(): never { throw new Error("WalletConnect is not part of this build"); }
}

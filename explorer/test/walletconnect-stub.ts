// The dApp SDK imports WalletConnect's client for its WalletConnect adapter, an optional part this build does not install and the Bridge never uses. The tests that load the SDK in Node are given this in its place;
// the page's build leaves the missing optional package as an import that fails only if it is used.
export default class SignClient {
  static init(): never { throw new Error("WalletConnect is not part of this build"); }
}

/// <reference types="vite/client" />

/** The Bridge page's build-time pins (explorer/bridge-pins.ts). */
declare const __BRIDGE_GATEWAY__: string;
declare const __VAULT_CODE_HASHES__: string[];
declare const __WTROME_ADDRESS__: string;
/** True only in a build whose VITE_CANTON_WALLETS lists "loop" (vite.config.ts): Loop's library is in a build only then. */
declare const __WALLET_LOOP__: boolean;

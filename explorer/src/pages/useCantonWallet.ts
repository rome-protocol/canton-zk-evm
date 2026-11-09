import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Unanswered } from "../bridge/canton/accounts.ts";
import type { Chain } from "../bridge/canton/env.ts";
import { Refused } from "../bridge/moves/moves.ts";
import { forgetWallet, inWallet, rememberWallet, wasConnected, type WalletConfig } from "../bridge/wallet/wallets.ts";
import type { Choice } from "../bridge/wallet/connect.ts";
import type { WalletAccount } from "../bridge/wallet/adapter.ts";
import type { WalletLink } from "../bridge/wallet/link.ts";
import { WALLET_WORDS } from "../bridge/wallet/link.ts";
import { plainWords } from "../bridge/words.ts";

export type WalletState =
  | { s: "idle" }
  | { s: "working"; note: string }
  | { s: "choosing"; choices: Choice[] }
  | { s: "failed"; message: string }
  | { s: "ready"; link: WalletLink; account: WalletAccount; opted: boolean; opting: boolean; note: string | null };

/** One error of connecting or of reading the wallet's account, in plain words. */
export function connectWords(e: unknown): string { return e instanceof Refused ? e.message : plainWords(e); }
/** One error of the opt-in, in plain words: a refusal by Canton says what it most likely means for a wallet. */
export function optInWords(e: unknown, name: string): string {
  if (e instanceof Unanswered) { const w = inWallet(name); return `${w.charAt(0).toUpperCase()}${w.slice(1)} did not say whether it took this. Check again in a minute; nothing is asked twice.`; }
  if (e instanceof Refused) return e.message === WALLET_WORDS.rejected ? `Canton did not take this. Your wallet may not support Ostia's tokens yet. Nothing was changed.` : e.message;
  return plainWords(e);
}

/**
 * The person's own Canton wallet on the Bridge page: connect it (Canton's wallet picker), read its account and whether the two standing acceptances are made, make them on request, disconnect.
 * Off (every state idle, nothing loaded) unless the build lists wallets. The wallet libraries are loaded only when a person connects, or when this browser connected a wallet before.
 */
export function useCantonWallet(config: WalletConfig, chain: Chain | null, networkName: string | null) {
  const [state, setState] = useState<WalletState>({ s: "idle" });
  const epoch = useRef(0);   // counts the connections: work of an earlier one is ignored when it ends
  const on = config.wallets.length > 0 && chain !== null;
  const options = useMemo(() => ({ ...config, networkName }), [config, networkName]);

  /** Reads the account's acceptances and shows the wallet. A wallet that cannot be read is let go. */
  const adopt = useCallback(async (link: WalletLink, mine: number) => {
    try {
      const { walletAccount, optedIn } = await import("../bridge/wallet/adapter.ts");
      const account = walletAccount(link, chain!);
      const opted = await optedIn(account);
      if (epoch.current !== mine) return;
      link.onLost(() => { if (epoch.current === mine) { epoch.current++; forgetWallet(); setState({ s: "failed", message: "Your Canton wallet was disconnected or changed its account. Connect it again." }); } });
      setState({ s: "ready", link, account, opted, opting: false, note: null });
    } catch (e) {
      void link.disconnect();
      if (epoch.current === mine) { forgetWallet(); setState({ s: "failed", message: connectWords(e) }); }
    }
  }, [chain]);

  useEffect(() => {
    if (!on || !wasConnected()) return;
    const mine = ++epoch.current;
    setState({ s: "working", note: "Opening your Canton wallet." });
    (async () => {
      const { restoreWallet } = await import("../bridge/wallet/connect.ts");
      const link = await restoreWallet(options);
      if (epoch.current !== mine) return void link?.disconnect();
      if (!link) { forgetWallet(); return setState({ s: "idle" }); }
      await adopt(link, mine);
    })().catch(() => { if (epoch.current === mine) { forgetWallet(); setState({ s: "idle" }); } });
    return () => { epoch.current++; };
  }, [on, options, adopt]);

  /** Connects the wallet the person picked; the wallet asks the person to approve. */
  const pick = useCallback(async (id: string) => {
    if (!on) return;
    const mine = ++epoch.current;
    setState({ s: "working", note: "Approve the connection in your wallet." });
    try {
      const { connectWallet } = await import("../bridge/wallet/connect.ts");
      const link = await connectWallet(options, id);
      if (epoch.current !== mine) return void link.disconnect();
      rememberWallet();
      await adopt(link, mine);
    } catch (e) { if (epoch.current === mine) setState({ s: "failed", message: connectWords(e) }); }
  }, [on, options, adopt]);

  /** "Connect your Canton wallet": the wallets this browser can reach are listed (one is connected at once). */
  const connect = useCallback(async () => {
    if (!on || state.s === "working") return;
    const mine = ++epoch.current;
    setState({ s: "working", note: "Looking for your Canton wallet." });
    try {
      const { choices } = await import("../bridge/wallet/connect.ts");
      const found = await choices(options);
      if (epoch.current !== mine) return;
      if (found.length === 0) return setState({ s: "failed", message: "No Canton wallet was found in this browser. Open your wallet or install its extension, then try again." });
      if (found.length === 1) return void (await pick(found[0]!.id));
      setState({ s: "choosing", choices: found });
    } catch (e) { if (epoch.current === mine) setState({ s: "failed", message: connectWords(e) }); }
  }, [on, state.s, options, pick]);

  const optIn = useCallback(async () => {
    if (state.s !== "ready" || state.opting || state.opted) return;
    const mine = epoch.current, { link, account } = state;
    setState({ ...state, opting: true, note: null });
    try {
      const { optIn: make } = await import("../bridge/wallet/adapter.ts");
      await make(account);
      if (epoch.current === mine) setState({ s: "ready", link, account, opted: true, opting: false, note: null });
    } catch (e) { if (epoch.current === mine) setState({ s: "ready", link, account, opted: false, opting: false, note: optInWords(e, link.name) }); }
  }, [state]);

  const disconnect = useCallback(async () => {
    const was = state;
    epoch.current++;
    forgetWallet();
    setState({ s: "idle" });
    if (was.s === "ready") await was.link.disconnect();
  }, [state]);

  const ready = state.s === "ready" ? state : null;
  return { on, state, connect, pick, optIn, disconnect, link: ready?.link ?? null, party: ready?.link.party ?? null, name: ready?.link.name ?? null, account: ready?.opted ? ready.account : null, inWallet };
}

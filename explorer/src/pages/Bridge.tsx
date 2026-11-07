import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { bridgeReads } from "../api.ts";
import { CardHead, unready } from "../components/Cards.tsx";
import { Icon } from "../components/Icon.tsx";
import { createFaucetClient, type CoinResult, type FaucetInfo } from "../faucet/faucet-client.ts";
import { formatCoin } from "../faucet/format.ts";
import { short } from "../format.ts";
import { timeoutSignal } from "../timeout.ts";
import { useStatus } from "../useStatus.ts";
import { injected, useWallet } from "../wallet.ts";
import { ensureOstia } from "../bridge/evm/network.ts";
import { buildSettings } from "../bridge/settings.ts";
import { GENERIC, PageError, plainText, plainWords } from "../bridge/words.ts";
import type { Account } from "../bridge/account.ts";
import type { EvmAdapter } from "../bridge/evm/adapter.ts";
import type { BridgeConfig } from "../bridge/evm/config.ts";
import type { Session } from "../bridge/session.ts";
import { MoveCard } from "./MoveCard.tsx";
import "./bridge.css";

const NO_WALLET = "No wallet was found in this browser. Install MetaMask, then open this page again.";
type Config = { s: "loading" } | { s: "failed" } | { s: "ready"; config: BridgeConfig };

const faucet = createFaucetClient();
type Phase = { s: "idle" } | { s: "working"; note: string } | { s: "failed"; message: string } | { s: "ready"; account: Account };
type Coin = { s: "idle" } | { s: "working" } | { s: "done"; message: string } | { s: "off" } | { s: "failed"; message: string };

/** What the explorer's faucet said of a request, in words. */
function coinWords(r: CoinResult, amount: string): string {
  if (r.kind === "queued") return `${amount} is on its way to your wallet.`;
  if (r.kind === "captcha") return "The faucet asks for a human check first. Ask for it on the Faucet page.";
  return plainText(r.message) ?? GENERIC;
}

/** The Canton Coin registry's name, as the explorer's own list of Canton tokens gives it. */
async function coinAdmin(): Promise<string> {
  const admin = (await bridgeReads.twins(timeoutSignal()!)).canton.find((c) => c.instrumentId === "Amulet")?.instrumentAdmin;
  if (!admin) throw new PageError("no_canton_coin", "This site does not list Canton Coin yet.");
  return admin;
}

/** The Bridge route: the account sheet, the Canton account opened from the wallet, with the test coins. */
export function Bridge() {
  const st = useStatus();
  const settings = useMemo(buildSettings, []);
  const wallet = useWallet(st.data);
  const [phase, setPhase] = useState<Phase>({ s: "idle" });
  const [coin, setCoin] = useState<Coin>({ s: "idle" });
  const [rome, setRome] = useState<Coin>({ s: "idle" });
  const [info, setInfo] = useState<FaucetInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [noWallet, setNoWallet] = useState(false);
  const [cfg, setCfg] = useState<Config>({ s: "loading" });
  const [evm, setEvm] = useState<EvmAdapter | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  // Another wallet account is another Canton account: the one that was open is let go (its key is dropped, and nothing is signed or sent for it any more), and whatever was on its way
  // for it is ignored when it ends. `epoch` counts the wallet's accounts: work that began under an earlier count is the old account's.
  const epoch = useRef(0);
  const holding = useRef<Account | null>(null);
  useEffect(() => {
    epoch.current++;
    holding.current?.close();
    holding.current = null;
    setPhase({ s: "idle" }); setCoin({ s: "idle" }); setRome({ s: "idle" }); setCopied(false); setSheet(false); setEvm(null); setSession(null);
  }, [wallet.account]);
  const ready = phase.s === "ready";
  const connected = wallet.account !== null;
  useEffect(() => { if (ready || connected) faucet.info().then(setInfo, () => setInfo(null)); }, [ready, connected]);

  // This build's tokens, read from the chain (the bridge's own code is loaded here, not with the first page).
  useEffect(() => {
    if (!settings) return;
    let live = true;
    import("../bridge/evm/config.ts").then((m) => m.loadBridgeConfig()).then(
      (config) => { if (live) setCfg({ s: "ready", config }); },
      (e) => { console.warn(e instanceof Error ? e.message : e); if (live) setCfg({ s: "failed" }); },
    );
    return () => { live = false; };
  }, [settings]);
  // The wallet's account on Ostia, for balances; and, once the Canton account is open, the move's machinery.
  const config = cfg.s === "ready" ? cfg.config : null;
  const opened = phase.s === "ready" ? phase.account : null;
  useEffect(() => {
    const w = injected();
    if (!config || !w || !wallet.account) { setEvm(null); return; }
    let live = true;
    import("../bridge/session.ts").then((m) => { if (live) setEvm(m.ostiaAdapter(w, wallet.account!, config.chain)); }, () => {});
    return () => { live = false; };
  }, [config, wallet.account]);
  useEffect(() => {
    if (!config || !evm || !opened) { setSession(null); return; }
    let live = true;
    import("../bridge/session.ts").then((m) => { if (live) setSession(m.createSession({ evm, account: opened, config })); }, () => {});
    return () => { live = false; };
  }, [config, evm, opened]);

  const wait = unready(st, "Looking up the chain…");
  if (wait) return wait;
  const chain = st.data!;
  const sym = chain.coin.symbol;
  const here = location.origin;
  const wrongSite = settings !== null && here !== settings.origin;
  const amount = info ? `${formatCoin(info.amount, chain.coin.decimals)} ${sym}` : `test ${sym}`;

  async function signIn() {
    const w = injected();
    if (!w || !wallet.account || !settings || phase.s === "working") return;
    const mine = epoch.current, same = () => epoch.current === mine;
    // The page signs only on the address it was set up for: a copy of it on another address is refused.
    if (wrongSite) return setPhase({ s: "failed", message: plainWords(new PageError("origin_mismatch", "origin")) });
    try {
      setPhase({ s: "working", note: "Putting your wallet on " + chain.chainName + "." });
      const on = await ensureOstia(w, chain);
      if (!same()) return;
      if (!on.ok) return setPhase({ s: "failed", message: plainText(on.message) ?? "Your wallet is not on " + chain.chainName + " yet." });
      const { openAccount } = await import("../bridge/account.ts");
      const account = await openAccount(w, wallet.account, settings, (note) => { if (same()) setPhase({ s: "working", note }); }, undefined, same);
      if (!same()) return account.close();
      holding.current = account;
      setPhase({ s: "ready", account });
    } catch (e) { if (same()) setPhase({ s: "failed", message: plainWords(e) }); }
  }
  async function getCanton(account: Account) {
    const mine = epoch.current, same = () => epoch.current === mine;
    setCoin({ s: "working" });
    try {
      const { getTestCoin } = await import("../bridge/account.ts");
      const done = await getTestCoin(account, await coinAdmin());
      if (same()) setCoin(done === "off" ? { s: "off" } : { s: "done", message: "Test Canton Coin is in your account." });
    } catch (e) { if (same()) setCoin({ s: "failed", message: plainWords(e) }); }
  }
  async function getRome() {
    const mine = epoch.current;
    setRome({ s: "working" });
    const r = await faucet.request(wallet.account!);
    if (epoch.current === mine) setRome({ s: r.kind === "queued" ? "done" : "failed", message: coinWords(r, amount) });
  }

  /** Puts the wallet on Ostia before a move; says why not, in words. */
  async function ensureChain(): Promise<string | null> {
    const w = injected();
    if (!w) return NO_WALLET;
    const on = await ensureOstia(w, chain);
    return on.ok ? null : plainText(on.message) ?? "Your wallet is not on " + chain.chainName + " yet.";
  }
  function connect() { if (!injected()) setNoWallet(true); else { setNoWallet(false); void wallet.connect(); } }
  const showSheet = sheet || phase.s !== "idle" || (wrongSite && connected);
  const note = (c: Coin) => c.s === "done" || c.s === "failed" ? <p className={`small ${c.s === "failed" ? "bad" : "muted"}`} role="status">{c.message}</p> : null;
  const walletNote = noWallet ? NO_WALLET : wallet.error ? plainText(wallet.error) : null;
  return (
    <div className="bridge-page">
      <div className="ptitle"><h1>Bridge</h1><span className="muted psub">Move tokens between {chain.chainName} and Canton</span></div>
      {settings && (
        <MoveCard
          config={config} configState={cfg.s} gateway={settings.chain.gateway} account={wallet.account} evm={evm} session={session} chainName={chain.chainName}
          onConnect={connect} connectNote={walletNote} onOpenAccount={() => setSheet(true)} ensureChain={ensureChain}
          faucet={info === null || info.on ? { label: `Get ${amount}`, busy: rome.s === "working", onGet: getRome } : null}
        />
      )}
      {!ready && note(rome)}
      {settings && showSheet && (
        <section className="card account" aria-label="Your Canton account">
          <CardHead title="Your Canton account" as="h2" />
          {phase.s === "ready" ? (
            <>
              <p className="ready"><span className="sd ok"><i /><b>Ready</b></span> <span className="mono" title={phase.account.party}>{short(phase.account.party, 16, 6)}</span>
                <button type="button" className="copy" aria-label="Copy account id" onClick={() => { navigator.clipboard?.writeText(phase.account.party).then(() => setCopied(true), () => {}); }}><Icon name={copied ? "check" : "copy"} size={13} /> {copied ? "Copied" : "Copy"}</button></p>
              <div className="actions">
                {coin.s !== "off" && <button type="button" className="btn ghost" disabled={coin.s === "working"} onClick={() => getCanton(phase.account)}>{coin.s === "working" ? "Getting Canton Coin…" : "Get test Canton Coin"}</button>}
                {(info === null || info.on) && <button type="button" className="btn ghost" disabled={rome.s === "working" || !wallet.account} onClick={getRome}>{rome.s === "working" ? "Asking the faucet…" : `Get ${amount}`}</button>}
              </div>
              {note(coin)}
              {note(rome)}
            </>
          ) : (
            <>
              <p className="lead">Sign one message in your wallet. It opens your Canton account. No gas and no new wallet. The same wallet opens the same account on any device.</p>
              <button type="button" className="btn" disabled={phase.s === "working" || wrongSite || !connected} onClick={signIn}>{phase.s === "working" ? phase.note : "Sign in with MetaMask"}</button>
              <p className="small muted">You are on <b className="mono">{here}</b>. Sign in only if that is the address you meant to open.</p>
              {wrongSite && <p className="small bad" role="alert">This page is open at {here}, but this bridge is set up for {settings.origin}. Signing is turned off here. Open the bridge from its own address.</p>}
              {phase.s === "failed" && <p className="small bad" role="alert">{phase.message}</p>}
            </>
          )}
        </section>
      )}
      {!settings && (
        <section className="card account" aria-label="Your Canton account"><CardHead title="Your Canton account" as="h2" /><p className="muted">The bridge is not set up on this site yet.</p></section>
      )}
      <p className="small muted">Test coins have no value. <Link to="/faucet">The Faucet page</Link> has the limits.</p>
    </div>
  );
}

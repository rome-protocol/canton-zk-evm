import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { bridgeReads } from "../api.ts";
import { CardHead, unready } from "../components/Cards.tsx";
import { Icon } from "../components/Icon.tsx";
import { BuilderGrant } from "../faucet/builder.tsx";
import { createFaucetClient, type CoinResult, type FaucetInfo } from "../faucet/faucet-client.ts";
import { formatCoin } from "../faucet/format.ts";
import { short } from "../format.ts";
import { timeoutSignal } from "../timeout.ts";
import { useStatus } from "../useStatus.ts";
import { injected, noWalletWords, onPhone, useWallet } from "../wallet.ts";
import { HelpLine, OutLink, StillStuck } from "../components/Help.tsx";
import { MOVES_ARE_PUBLIC, SIGN_IN_NO_RECOVERY, SIGN_IN_SAME_ACCOUNT, TRUST_MODEL_URL } from "../copy.ts";
import { browserKeyStore } from "../bridge/canton/keystore.ts";
import { ensureOstia } from "../bridge/evm/network.ts";
import { buildSettings } from "../bridge/settings.ts";
import { walletsFromEnv } from "../bridge/wallet/wallets.ts";
import { GENERIC, PageError, plainText, plainWords, signInWords } from "../bridge/words.ts";
import type { Account } from "../bridge/account.ts";
import type { EvmAdapter } from "../bridge/evm/adapter.ts";
import type { BridgeConfig } from "../bridge/evm/config.ts";
import { moveStore } from "../bridge/moves/state.ts";
import type { Sender } from "../bridge/send.ts";
import type { Session, SessionAccount } from "../bridge/session.ts";
import { pairsOf } from "../bridge/tokens.ts";
import { AccountPanel } from "./AccountPanel.tsx";
import { CantonWalletSheet } from "./CantonWalletSheet.tsx";
import { useCantonWallet } from "./useCantonWallet.ts";
import { Activity } from "./Activity.tsx";
import { MoveBar } from "./MoveBar.tsx";
import { MoveCard } from "./MoveCard.tsx";
import "./bridge.css";

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
  /** The Canton wallets this build offers (VITE_CANTON_WALLETS): none, and the page is the Bridge as it was. */
  const walletConfig = useMemo(() => walletsFromEnv(import.meta.env), []);
  const canton = useCantonWallet(walletConfig, settings?.chain ?? null, st.data?.networkName ?? null);
  /** The person chose a Bridge account from MetaMask over a Canton wallet (only when the build offers wallets). */
  const [bridgeAccount, setBridgeAccount] = useState(false);
  const wallet = useWallet(st.data);
  const [phase, setPhase] = useState<Phase>({ s: "idle" });
  const [coin, setCoin] = useState<Coin>({ s: "idle" });
  const [rome, setRome] = useState<Coin>({ s: "idle" });
  const [info, setInfo] = useState<FaucetInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const [sheet, setSheet] = useState(false);
  /** What the wallet holds of the chain's coin (the card reads it); null while not known. */
  const [gas, setGas] = useState<bigint | null>(null);
  const [refresh, setRefresh] = useState(0);
  /** Counts up every few seconds while the wallet's coin is on its way: the wallet's balances are read again, the Canton account's are not. */
  const [poll, setPoll] = useState(0);
  /** What the Canton account holds of each listed token, as the card read it (the account panel shows it). */
  const [held, setHeld] = useState<Record<string, bigint | null>>({});
  /** The faucet has queued the coin and the wallet does not show it yet. */
  const [coming, setComing] = useState(false);
  const [nudge, setNudge] = useState(0);
  const sheetRef = useRef<HTMLElement>(null);
  const [noWallet, setNoWallet] = useState(false);
  const [cfg, setCfg] = useState<Config>({ s: "loading" });
  const [evm, setEvm] = useState<EvmAdapter | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  /** What sends and accepts on Canton for the open account (the signing code, loaded once the account is open). */
  const [sender, setSender] = useState<Sender | null>(null);
  const [tab, setTab] = useState<"move" | "activity">("move");
  // Another wallet account is another Canton account: the one that was open is let go (its key is dropped, and nothing is signed or sent for it any more), and whatever was on its way
  // for it is ignored when it ends. `epoch` counts the wallet's accounts: work that began under an earlier count is the old account's.
  const epoch = useRef(0);
  const holding = useRef<Account | null>(null);
  /** True while a kept account is being looked for and reopened: a sign-in started now would ask the wallet for a signature the reopen does not need. */
  const reopening = useRef(false);
  const [closeNote, setCloseNote] = useState<string | null>(null);
  const clear = () => { setPhase({ s: "idle" }); setCoin({ s: "idle" }); setRome({ s: "idle" }); setComing(false); setCopied(false); setSheet(false); setEvm(null); setSession(null); setSender(null); setGas(null); setHeld({}); setCloseNote(null); };
  useEffect(() => {
    epoch.current++;
    holding.current?.close();
    holding.current = null;
    reopening.current = false;
    clear();
    // An account this browser kept for this wallet address opens again without a signature (a reload, or the wallet coming back to an address it opened before). Nothing kept, or any
    // failure, leaves the sign-in as it was.
    const address = wallet.account;
    if (!address || !settings || location.origin !== settings.origin) return;
    const mine = epoch.current, same = () => epoch.current === mine;
    reopening.current = true;
    (async () => {
      // The signing code is fetched only when this browser keeps a key for this address; otherwise it is fetched when the person signs in.
      const store = browserKeyStore();
      if (!(await store.load(address))) return;
      // From here the page is busy with the reopen: the sign-in button is off and a sign-in started by other means returns at once.
      if (same()) setPhase({ s: "working", note: "Opening your account." });
      const { reopenAccount } = await import("../bridge/account.ts");
      const account = await reopenAccount(address, settings, (note) => { if (same()) setPhase({ s: "working", note }); }, undefined, same, store);
      if (!same()) return account?.close();
      if (!account) return setPhase({ s: "idle" });
      holding.current = account;
      setPhase({ s: "ready", account });
    })().catch(() => { if (same()) setPhase({ s: "idle" }); }).finally(() => { if (same()) reopening.current = false; });
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
  const pairs = useMemo(() => (config && settings ? pairsOf(config, settings.chain.gateway) : []), [config, settings]);
  const store = useMemo(moveStore, []);
  const derived = phase.s === "ready" ? phase.account : null;
  /** The Canton account the moves are made for: a connected wallet's (once it has opted in), else the Bridge account from MetaMask. A connected wallet takes the place of the Bridge account. */
  const opened: SessionAccount | null = canton.link ? canton.account : derived;
  useEffect(() => {
    const w = injected();
    if (!config || !w || !wallet.account) { setEvm(null); return; }
    let live = true;
    import("../bridge/evm/ostia.ts").then((m) => { if (live) setEvm(m.ostiaAdapter(w, wallet.account!, config.chain)); }, () => {});
    return () => { live = false; };
  }, [config, wallet.account]);
  useEffect(() => {
    if (!config || !evm || !opened) { setSession(null); return; }
    let live = true, made: Session | null = null;
    import("../bridge/session.ts").then((m) => { if (live) { made = m.createSession({ evm, account: opened, config }); setSession(made); } }, () => {});
    return () => { live = false; made?.close(); };
  }, [config, evm, opened]);

  useEffect(() => {
    // Sending and accepting are the Bridge account's: a connected wallet does them in the wallet itself.
    if (!derived || canton.link) { setSender(null); return; }
    let live = true;
    import("../bridge/send.ts").then((m) => { if (live) setSender(m.createSender(derived)); }, () => {});
    return () => { live = false; };
  }, [derived, canton.link]);

  // Once the coin is queued the balance is read every few seconds, so the walk goes on as soon as it lands; the wait ends when the wallet shows it (or after five minutes).
  useEffect(() => { if (gas !== null && gas > 0n) setComing(false); }, [gas]);
  useEffect(() => {
    if (!coming) return;
    const tick = setInterval(() => setPoll((n) => n + 1), 3_000);
    const stop = setTimeout(() => setComing(false), 300_000);
    return () => { clearInterval(tick); clearTimeout(stop); };
  }, [coming]);

  // "Open my Canton account" brings the sign-in part into view: it sits below the card, so on a phone it may be off the screen.
  useEffect(() => { if (nudge > 0) sheetRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" }); }, [nudge]);

  const wait = unready(st, "Looking up the chain…");
  if (wait) return wait;
  const chain = st.data!;
  const sym = chain.coin.symbol;
  const here = location.origin;
  const wrongSite = settings !== null && here !== settings.origin;
  const amount = info ? `${formatCoin(info.amount, chain.coin.decimals)} ${sym}` : `test ${sym}`;

  async function signIn() {
    const w = injected();
    if (!w || !wallet.account || !settings || phase.s === "working" || reopening.current) return;
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
    } catch (e) { if (same()) setPhase({ s: "failed", message: signInWords(e, sym, chain.chainName, gas) }); }
  }
  /** "Remove my Canton key from this browser": the kept key is removed, and the open account is let go. The next sign-in asks the wallet again. */
  async function closeHere(account: Account) {
    if (!wallet.account) return;
    try {
      const { closeAccount } = await import("../bridge/account.ts");
      await closeAccount(account, wallet.account);
      epoch.current++;
      holding.current = null;
      clear();
    } catch { setCloseNote("This browser could not remove it. Your account is still open."); }
  }
  async function getCanton(account: Account) {
    const mine = epoch.current, same = () => epoch.current === mine;
    setCoin({ s: "working" });
    try {
      const { getTestCoin } = await import("../bridge/account.ts");
      const done = await getTestCoin(account, await coinAdmin());
      if (same()) { setCoin(done === "off" ? { s: "off" } : { s: "done", message: "Test Canton Coin is in your account." }); setRefresh((n) => n + 1); }
    } catch (e) { if (same()) setCoin({ s: "failed", message: plainWords(e) }); }
  }
  async function getRome() {
    const mine = epoch.current;
    setRome({ s: "working" });
    const r = await faucet.request(wallet.account!);
    if (epoch.current === mine) { setRome({ s: r.kind === "queued" ? "done" : "failed", message: coinWords(r, amount) }); setComing(r.kind === "queued" && gas === 0n); setRefresh((n) => n + 1); }
  }

  /** Puts the wallet on Ostia before a move; says why not, in words. */
  async function ensureChain(): Promise<string | null> {
    const w = injected();
    if (!w) return noWalletWords();
    const on = await ensureOstia(w, chain);
    return on.ok ? null : plainText(on.message) ?? "Your wallet is not on " + chain.chainName + " yet.";
  }
  function connect() { if (!injected()) setNoWallet(true); else { setNoWallet(false); void wallet.connect(); } }
  const openSheet = () => { setSheet(true); setNudge((n) => n + 1); };
  const showSheet = sheet || phase.s !== "idle" || (wrongSite && connected) || canton.state.s !== "idle";
  /** The sheet is the Canton wallet's while one is being connected or is connected, and at first when the build offers wallets (the Bridge account from MetaMask is one click away). */
  const walletSheet = canton.on && !bridgeAccount && (canton.state.s !== "idle" || phase.s !== "ready");
  /** "Use a Bridge account from your wallet": the person's choice decides the sheet, whatever the wallet's connection was doing. */
  const toBridgeAccount = () => { canton.reset(); setBridgeAccount(true); setSheet(true); };
  /** "Connect your Canton wallet" from any sheet: the wallet sheet comes back and the connection starts. */
  const toWallet = () => { setBridgeAccount(false); setSheet(true); void canton.connect(); };
  const note = (c: Coin) => c.s === "done" || c.s === "failed" ? <p className={`small ${c.s === "failed" ? "bad" : "muted"}`} role="status">{c.message}</p> : null;
  const faucetOn = info === null || info.on;
  /** The wallet holds none of the chain's coin and the site has a faucet: the coin comes before the sign-in. */
  const needCoin = connected && gas === 0n && faucetOn;
  const walletNote = noWallet ? noWalletWords() : wallet.error ? plainText(wallet.error) : null;
  return (
    <div className="bridge-page">
      <div className="ptitle"><h1>Bridge</h1><span className="muted psub">Move tokens between {chain.chainName} and Canton</span></div>
      {settings && (
        <div className="tabs" role="tablist" aria-label="Bridge">
          {(["move", "activity"] as const).map((t) => (
            <button key={t} type="button" role="tab" id={`bridge-tab-${t}`} aria-selected={tab === t} aria-controls={`bridge-panel-${t}`} onClick={() => setTab(t)}>{t === "move" ? "Move" : "Activity"}</button>
          ))}
        </div>
      )}
      {settings && (
        <div className="panel" role="tabpanel" id="bridge-panel-move" aria-labelledby="bridge-tab-move" hidden={tab !== "move"}>
          <MoveCard
            config={config} configState={cfg.s} gateway={settings.chain.gateway} account={wallet.account} evm={evm} session={session} accountOpen={opened !== null} openLabel={canton.link ? "Opt in with your wallet" : undefined} cantonWallet={canton.link?.name ?? null} chainName={chain.chainName}
            onConnect={connect} connectNote={walletNote} onOpenAccount={openSheet} ensureChain={ensureChain}
            faucet={faucetOn ? { label: `Get ${amount}`, busy: rome.s === "working", coming, onGet: getRome, extra: <BuilderGrant info={info} address={wallet.account} coin={chain.coin} /> } : null} onGas={setGas} refresh={refresh} poll={poll} onCanton={setHeld} onMoved={() => setRefresh((n) => n + 1)}
          />
          <MoveBar session={session} pairs={pairs} chainName={chain.chainName} />
        </div>
      )}
      {settings && tab === "activity" && (
        <div className="panel" role="tabpanel" id="bridge-panel-activity" aria-labelledby="bridge-tab-activity">
          <Activity account={wallet.account} session={session} store={store} pairs={pairs} chainName={chain.chainName} onConnect={connect} connectNote={walletNote} onOpenAccount={openSheet} ensureChain={ensureChain} />
        </div>
      )}
      {!ready && note(rome)}
      {settings && wallet.account && <AccountPanel wallet={wallet.account} party={canton.party ?? derived?.party ?? null} cantonWallet={canton.link?.name ?? null} pairs={pairs} held={held} chainName={chain.chainName} sender={sender} refresh={refresh} onChanged={() => setRefresh((n) => n + 1)} kept={!canton.link && derived?.kept ? { onClose: () => closeHere(derived), note: closeNote } : null} />}
      {settings && showSheet && (
        <section className="card account" aria-label="Your Canton account" ref={sheetRef}>
          <CardHead title="Your Canton account" as="h2" />
          {walletSheet ? (
            <CantonWalletSheet state={canton.state} onConnect={() => void canton.connect()} onPick={(id) => void canton.pick(id)} onOptIn={() => void canton.optIn()} onDisconnect={() => { setSheet(true); void canton.disconnect(); }} onBridgeAccount={toBridgeAccount} />
          ) : phase.s === "ready" ? (
            <>
              <p className="ready"><span className="sd ok"><i /><b>Ready</b></span> <span className="mono" title={phase.account.party}>{short(phase.account.party, 16, 6)}</span>
                <button type="button" className="copy" aria-label="Copy account id" onClick={() => { navigator.clipboard?.writeText(phase.account.party).then(() => setCopied(true), () => {}); }}><Icon name={copied ? "check" : "copy"} size={13} /> {copied ? "Copied" : "Copy"}</button></p>
              <div className="actions">
                {coin.s !== "off" && <button type="button" className="btn ghost" disabled={coin.s === "working"} onClick={() => getCanton(phase.account)}>{coin.s === "working" ? "Getting Canton Coin…" : "Get test Canton Coin"}</button>}
                {(info === null || info.on) && <button type="button" className="btn ghost" disabled={rome.s === "working" || coming || !wallet.account} onClick={getRome}>{rome.s === "working" ? "Asking the faucet…" : coming ? `${sym} is on its way…` : `Get ${amount}`}</button>}
              </div>
              {note(coin)}
              {note(rome)}
              {canton.on && <p className="small muted">Have a Canton wallet? <button type="button" className="link-b" onClick={toWallet}>Connect your Canton wallet</button></p>}
            </>
          ) : (
            <>
              <p className="lead">Sign one message in your wallet. It opens your Canton account.{needCoin ? "" : " No gas and no new wallet."} {SIGN_IN_SAME_ACCOUNT} {SIGN_IN_NO_RECOVERY} <OutLink href={TRUST_MODEL_URL}>Limits</OutLink></p>
              {needCoin && phase.s !== "working" ? (
                <>
                  <p className="small" role="status">Get test {sym} first. Every move on {chain.chainName} needs a little for fees.</p>
                  <button type="button" className="btn" disabled={rome.s === "working" || coming} onClick={getRome}>{rome.s === "working" ? "Asking the faucet…" : coming ? `${sym} is on its way…` : `Get test ${sym}`}</button>
                  <BuilderGrant info={info} address={wallet.account} coin={chain.coin} />
                </>
              ) : (
                <button type="button" className="btn" disabled={phase.s === "working" || wrongSite || !connected} onClick={signIn}>{phase.s === "working" ? phase.note : "Sign in with your wallet"}</button>
              )}
              <p className="small muted">You are on <b className="mono">{here}</b>. Sign in only if that is the address you meant to open.</p>
              {wrongSite && <p className="small bad" role="alert">This page is open at {here}, but this bridge is set up for {settings.origin}. Signing is turned off here. Open the bridge from its own address.</p>}
              {phase.s === "failed" && <><p className="small bad" role="alert">{phase.message}</p><StillStuck /></>}
              {canton.on && <p className="small muted">Have a Canton wallet? <button type="button" className="link-b" onClick={toWallet}>Connect your Canton wallet</button></p>}
            </>
          )}
        </section>
      )}
      {!settings && (
        <section className="card account" aria-label="Your Canton account"><CardHead title="Your Canton account" as="h2" /><p className="muted">The bridge is not set up on this site yet.</p></section>
      )}
      {settings && !injected() && onPhone() && <p className="small muted" role="note">{noWalletWords()}</p>}
      <p className="small muted">Test coins have no value. <Link to="/faucet">The Faucet page</Link> has the limits.</p>
      <p className="small muted">{MOVES_ARE_PUBLIC}</p>
      <HelpLine />
    </div>
  );
}

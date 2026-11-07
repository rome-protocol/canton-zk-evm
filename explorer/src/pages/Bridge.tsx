import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { bridgeReads } from "../api.ts";
import { CardHead, unready } from "../components/Cards.tsx";
import { Icon } from "../components/Icon.tsx";
import { createFaucetClient, type CoinResult, type FaucetInfo } from "../faucet/faucet-client.ts";
import { formatCoin } from "../faucet/format.ts";
import { short } from "../format.ts";
import { timeoutSignal } from "../timeout.ts";
import { useStatus } from "../useStatus.ts";
import { injected, useWallet, walletWords } from "../wallet.ts";
import { ensureOstia } from "../bridge/evm/network.ts";
import { buildSettings } from "../bridge/settings.ts";
import type { Account } from "../bridge/account.ts";
import "./bridge.css";

const faucet = createFaucetClient();
type Phase = { s: "idle" } | { s: "working"; note: string } | { s: "failed"; message: string } | { s: "ready"; account: Account };
type Coin = { s: "idle" } | { s: "working" } | { s: "done"; message: string } | { s: "off" } | { s: "failed"; message: string };

/** What the explorer's faucet said of a request, in words. */
function coinWords(r: CoinResult, amount: string): string {
  if (r.kind === "queued") return `${amount} is on its way to your wallet.`;
  if (r.kind === "captcha") return "The faucet asks for a human check first. Ask for it on the Faucet page.";
  return r.message;
}

/** The Canton Coin registry's name, as the explorer's own list of Canton tokens gives it. */
async function coinAdmin(): Promise<string> {
  const admin = (await bridgeReads.twins(timeoutSignal()!)).canton.find((c) => c.instrumentId === "Amulet")?.instrumentAdmin;
  if (!admin) throw new Error("This site does not list Canton Coin yet.");
  return admin;
}

/** The Bridge route. This slice has the account sheet: the Canton account opened from the wallet, with the test coins. */
export function Bridge() {
  const st = useStatus();
  const settings = useMemo(buildSettings, []);
  const wallet = useWallet(st.data);
  const [phase, setPhase] = useState<Phase>({ s: "idle" });
  const [coin, setCoin] = useState<Coin>({ s: "idle" });
  const [rome, setRome] = useState<Coin>({ s: "idle" });
  const [info, setInfo] = useState<FaucetInfo | null>(null);
  const [copied, setCopied] = useState(false);
  // Another wallet account is another Canton account: the one that was open is let go.
  useEffect(() => { setPhase({ s: "idle" }); setCoin({ s: "idle" }); setRome({ s: "idle" }); }, [wallet.account]);
  const ready = phase.s === "ready";
  useEffect(() => { if (ready) faucet.info().then(setInfo, () => setInfo(null)); }, [ready]);

  const wait = unready(st, "Looking up the chain…");
  if (wait) return wait;
  const chain = st.data!;
  const sym = chain.coin.symbol;
  const amount = info ? `${formatCoin(info.amount, chain.coin.decimals)} ${sym}` : `test ${sym}`;

  async function signIn() {
    const w = injected();
    if (!w || !wallet.account || !settings) return;
    try {
      setPhase({ s: "working", note: "Putting your wallet on " + chain.chainName + "." });
      const on = await ensureOstia(w, chain);
      if (!on.ok) return setPhase({ s: "failed", message: on.message ?? "Your wallet is not on " + chain.chainName + " yet." });
      const { openAccount } = await import("../bridge/account.ts");
      setPhase({ s: "ready", account: await openAccount(w, wallet.account, settings, (note) => setPhase({ s: "working", note })) });
    } catch (e) { setPhase({ s: "failed", message: walletWords(e) }); }
  }
  async function getCanton(account: Account) {
    setCoin({ s: "working" });
    try {
      const { getTestCoin } = await import("../bridge/account.ts");
      const done = await getTestCoin(account, await coinAdmin());
      setCoin(done === "off" ? { s: "off" } : { s: "done", message: "Test Canton Coin is in your account." });
    } catch (e) { setCoin({ s: "failed", message: walletWords(e) }); }
  }
  async function getRome() {
    setRome({ s: "working" });
    const r = await faucet.request(wallet.account!);
    setRome({ s: r.kind === "queued" ? "done" : "failed", message: coinWords(r, amount) });
  }

  const note = (c: Coin) => c.s === "done" || c.s === "failed" ? <p className={`small ${c.s === "failed" ? "bad" : "muted"}`} role="status">{c.message}</p> : null;
  return (
    <div className="bridge-page">
      <div className="ptitle"><h1>Bridge</h1><span className="muted psub">Move tokens between {chain.chainName} and Canton</span></div>
      <section className="card account" aria-label="Your Canton account">
        <CardHead title="Your Canton account" as="h2" />
        {!settings ? <p className="muted">The bridge is not set up on this site yet.</p> : phase.s === "ready" ? (
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
            {wallet.account === null
              ? <button type="button" className="btn" onClick={wallet.connect}>Connect MetaMask</button>
              : <button type="button" className="btn" disabled={phase.s === "working"} onClick={signIn}>{phase.s === "working" ? phase.note : "Sign in MetaMask"}</button>}
            <p className="small muted">You are on <b className="mono">{settings.origin}</b>. Sign in only if that is the address you meant to open.</p>
            {phase.s === "failed" && <p className="small bad" role="alert">{phase.message}</p>}
            {wallet.error && <p className="small bad" role="alert">{wallet.error}</p>}
          </>
        )}
      </section>
      <p className="small muted">Test coins have no value. <Link to="/faucet">The Faucet page</Link> has the limits.</p>
    </div>
  );
}

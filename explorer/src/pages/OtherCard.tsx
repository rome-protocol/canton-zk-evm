import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AmountError, normaliseAmount, showBalance, showUnits } from "../bridge/amounts.ts";
import { amountSize } from "../bridge/card.ts";
import { parseBase } from "../bridge/other/amount.ts";
import { readBalances, type Balances } from "../bridge/other/balances.ts";
import type { Dir } from "../bridge/other/record.ts";
import type { Asset, OpenRow, OstiaChain } from "../bridge/other/setup.ts";
import { sides, type SendInput } from "../bridge/other/transfer.ts";
import { BRING_YOUR_OWN, feeCoin, feesNote, notAvailable, otherWords, timeWords } from "../bridge/other/words.ts";
import { StillStuck } from "../components/Help.tsx";
import { Icon } from "../components/Icon.tsx";
import { short } from "../format.ts";
import { injected } from "../wallet.ts";

export interface OtherCardProps {
  row: OpenRow;
  chain: OstiaChain;
  /** Ostia's own coin, which pays the fees there. */
  ostiaCoin: string;
  /** The wallet's account, or null while it is not connected. */
  account: string | null;
  connectNote: string | null;
  onConnect(): void;
  /** The chain the wallet is on now. */
  walletChainId: number | null;
  /** A read of Ostia through the explorer's /rpc. */
  read: (method: string, params: unknown[]) => Promise<unknown>;
  /** The test coin of Ostia, when the site has a faucet. */
  faucet: { label: string; busy: boolean; coming: boolean; onGet(): void } | null;
  /** Asks the wallet for the send; throws (with words the page reads) when it could not. */
  onStart(input: SendInput): Promise<void>;
  /** Counts up when the balances should be read again. */
  refresh: number;
  /** Something is being asked of the wallet. */
  busy: boolean;
}

/** An amount: a field that grows to hold the whole of it (the same styles as the Canton card's). */
function AmountField({ label, value, readOnly, onChange, onBlur }: { label: string; value: string; readOnly?: boolean; onChange?: (t: string) => void; onBlur?: () => void }) {
  return (
    <div className={`amt amt-${amountSize(value)}`} data-value={`${value || "0"} `}>
      <textarea rows={1} aria-label={label} inputMode="decimal" autoComplete="off" spellCheck={false} placeholder="0" readOnly={readOnly} value={value} onChange={(e) => onChange?.(e.target.value.replace(/[\s\n]/g, ""))} onBlur={onBlur} />
    </div>
  );
}

export function OtherCard(p: OtherCardProps) {
  const { row, chain } = p;
  const offered = useMemo(() => row.assets.filter((a) => a.sepolia === "native"), [row]);
  const [dir, setDir] = useState<Dir>("in");
  const [symbol, setSymbol] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [bal, setBal] = useState<Balances>({ from: null, coin: null });
  const [tick, setTick] = useState(0);
  const asset: Asset | undefined = offered.find((a) => a.symbol === symbol) ?? offered[0];
  const s = sides({ ostia: chain, other: row, topic0: "" }, dir);
  const wrapped = asset ? (asset.sepolia === "native" ? `W${asset.symbol}` : asset.symbol) : "";
  const fromSymbol = dir === "in" ? asset?.symbol ?? "" : wrapped, toSymbol = dir === "in" ? wrapped : asset?.symbol ?? "";

  useEffect(() => { const id = setInterval(() => setTick((n) => n + 1), 15_000); return () => clearInterval(id); }, []);
  useEffect(() => {
    if (!p.account || !asset) { setBal({ from: null, coin: null }); return; }
    let live = true;
    readBalances({ dir, asset, account: p.account, read: p.read, wallet: injected(), walletChainId: p.walletChainId, otherChainId: row.chainId }).then((b) => { if (live) setBal(b); });
    return () => { live = false; };
  }, [p.account, asset, dir, p.walletChainId, p.refresh, tick]);   // eslint-disable-line react-hooks/exhaustive-deps

  const parsed = useMemo(() => {
    if (!asset || text.trim() === "") return { state: "empty" as const, error: null, base: null };
    try { return { state: "ok" as const, error: null, base: parseBase(text, asset.decimals) }; }
    catch (e) { return { state: "bad" as const, error: e instanceof AmountError ? e.message : null, base: null }; }
  }, [asset, text]);
  const enough = parsed.base !== null && bal.from !== null ? parsed.base <= bal.from : null;
  const needCoin = dir === "out" && bal.coin === 0n && p.faucet !== null;

  const button: { label: string; action: "connect" | "faucet" | "send" | "none"; disabled: boolean } =
    starting || p.busy ? { label: "Confirm in your wallet…", action: "none", disabled: true }
    : p.account === null ? { label: "Connect wallet", action: "connect", disabled: false }
    : !row.available ? { label: "Not available right now", action: "none", disabled: true }
    : needCoin ? { label: p.faucet!.busy ? "Asking the faucet…" : p.faucet!.coming ? `${p.ostiaCoin} is on its way…` : `Get test ${p.ostiaCoin}`, action: "faucet", disabled: p.faucet!.busy || p.faucet!.coming }
    : parsed.state !== "ok" ? { label: "Enter an amount", action: "none", disabled: true }
    : enough === false ? { label: `Not enough ${fromSymbol}`, action: "none", disabled: true }
    : { label: `Send to ${s.claimName}`, action: "send", disabled: false };

  async function press() {
    if (button.action === "connect") return p.onConnect();
    if (button.action === "faucet") return p.faucet?.onGet();
    if (button.action !== "send" || !asset || parsed.base === null) return;
    setProblem(null); setStarting(true);
    try { await p.onStart({ dir, asset, amount: parsed.base }); setText(""); }
    catch (e) { setProblem(otherWords(e, s.sendName, feeCoin(row, p.ostiaCoin, dir === "in" ? "other" : "ostia"))); }
    finally { setStarting(false); }
  }

  const edit = (t: string) => { setText(/^[^.,]*,[^.,]*$/.test(t) ? t.replace(",", ".") : t); setProblem(null); };
  const flip = () => { setDir(dir === "in" ? "out" : "in"); setText(""); setProblem(null); };
  const locked = starting || p.busy;
  const chip = <span className="wchip mono" title={p.account ?? undefined}>{p.account ? short(p.account, 6, 4) : "Not connected"}</span>;

  const side = (field: "from" | "to") => {
    const name = field === "from" ? s.sendName : s.claimName;
    const coin = field === "from" ? fromSymbol : toSymbol;
    // The balance shown is the one the wallet sends: what it will hold on the far side is not read.
    const balance = field === "from" ? bal.from : null;
    return (
      <div className={`side ${field}`}>
        <div className="side-h"><span className="lbl">{field === "from" ? "From" : "To"} <b>{name}</b></span>{chip}</div>
        <div className="tok-row">
          {offered.length > 1 && field === "from"
            ? <select className="tok" aria-label="Token" disabled={locked} value={asset?.symbol} onChange={(e) => { setSymbol(e.target.value); setText(""); }}>{offered.map((a) => <option key={a.symbol} value={a.symbol}>{dir === "in" ? a.symbol : `W${a.symbol}`}</option>)}</select>
            : <span className="tok" aria-label={`${field === "from" ? "From" : "To"} token ${coin} on ${name}`}><b>{coin || "–"}</b><span className="muted small">on {name}</span></span>}
          <AmountField label={field === "from" ? "Amount to move" : "Amount you get"} value={text} readOnly={field === "to" || locked} onChange={edit} onBlur={field === "from" ? () => setText((t) => normaliseAmount(t)) : undefined} />
        </div>
        {field === "from" && (
          <p className="bal small muted">
            Balance <span className="num">{balance === null || !asset ? "–" : showBalance(balance, asset.decimals)}</span>
            {dir === "out" && balance !== null && balance > 0n && !locked && asset && <> · <button type="button" className="link-b" onClick={() => edit(showUnits(balance, asset.decimals))}>Max</button></>}
          </p>
        )}
      </div>
    );
  };

  const time = timeWords(row.times[dir]);
  const steps: ReactNode[] = dir === "in"
    ? [<>Send on {s.sendName} <span className="muted small">(1 wallet pop-up, paid in {feeCoin(row, p.ostiaCoin, "other")})</span></>, <>Wait until it is ready on {s.claimName}</>, <>Claim on {s.claimName} <span className="muted small">(1 pop-up, paid in {feeCoin(row, p.ostiaCoin, "ostia")})</span></>]
    : [<>Send on {s.sendName} <span className="muted small">(1 pop-up, paid in {feeCoin(row, p.ostiaCoin, "ostia")})</span></>, <>Wait until it is confirmed on {s.claimName}</>, <>Claim on {s.claimName} <span className="muted small">(1 pop-up, paid in {feeCoin(row, p.ostiaCoin, "other")})</span></>];

  return (
    <section className="card move" aria-label="Move tokens over the AggLayer Bridge">
      {!asset ? <p className="muted">There are no tokens to move here yet.</p> : (
        <>
          {side("from")}
          <button type="button" className="flip" aria-label="Swap direction" disabled={locked} onClick={flip}><Icon name="swap" size={16} /></button>
          {side("to")}
          {parsed.error && <p className="small bad" role="status">{parsed.error}</p>}
          {time && <p className="small muted">Time {time}</p>}
          {!row.available && <p className="small bad" role="status">{notAvailable(row.name)}</p>}
          <button type="button" className="btn go" disabled={button.disabled} onClick={() => void press()}>{button.label}</button>
          {dir === "in" && <p className="small muted">{BRING_YOUR_OWN}</p>}
          <p className="small muted">{feesNote(dir, p.ostiaCoin, feeCoin(row, p.ostiaCoin, "other"), s.claimName)}</p>
          {problem && <><p className="small bad" role="alert">{problem}</p><StillStuck error={problem} /></>}
          {p.connectNote && <p className="small bad" role="alert">{p.connectNote}</p>}
          {p.faucet && bal.coin === 0n && button.action !== "faucet" && <p className="small"><button type="button" className="link-b" disabled={p.faucet.busy || p.faucet.coming} onClick={p.faucet.onGet}>{p.faucet.busy ? "Asking the faucet…" : p.faucet.coming ? `${p.ostiaCoin} is on its way…` : p.faucet.label}</button> <span className="muted">You have none for fees on {chain.name}.</span></p>}
          <details className="move-steps">
            <summary><span>Steps · 2 wallet pop-ups</span></summary>
            <ol>{steps.map((x, i) => <li key={i}><span>{x}</span></li>)}</ol>
          </details>
        </>
      )}
    </section>
  );
}

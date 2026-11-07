import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../components/Icon.tsx";
import { short } from "../format.ts";
import { AmountError, maxText, parseAmount, showUnits } from "../bridge/amounts.ts";
import { amountSize, buttonOf, noteOf, progressWords } from "../bridge/card.ts";
import type { EvmAdapter } from "../bridge/evm/adapter.ts";
import type { BridgeConfig } from "../bridge/evm/config.ts";
import type { MoveState } from "../bridge/moves/state.ts";
import { popups, stepsOf, cantonSignatures } from "../bridge/moves/steps.ts";
import type { Session } from "../bridge/session.ts";
import { inputOf, moveOf, pairsOf, type Pair, type Side, type Token } from "../bridge/tokens.ts";
import { moveWords } from "../bridge/words.ts";
import { TokenPicker } from "./TokenPicker.tsx";

export interface MoveCardProps {
  config: BridgeConfig | null;
  configState: "loading" | "ready" | "failed";
  /** The Canton party that issues the twins on Canton (from the build's settings). */
  gateway: string;
  /** The wallet's account on Ostia, or null while the wallet is not connected. */
  account: string | null;
  evm: EvmAdapter | null;
  /** The move's machinery, once the Canton account is open. */
  session: Session | null;
  chainName: string;
  onConnect(): void;
  /** What the wallet or the page says of connecting, in plain words. */
  connectNote: string | null;
  onOpenAccount(): void;
  /** Puts the wallet on Ostia; says why not, in words, when it cannot. */
  ensureChain(): Promise<string | null>;
  /** The inline faucet for gas: shown when the account holds none. Null when this site has no faucet. */
  faucet: { label: string; busy: boolean; onGet(): void } | null;
  /** Said once a move is final. The page reads the kept moves from `session.move`. */
  onMoved?(): void;
}

interface Balances { ostia: bigint | null; canton: bigint | null; gas: bigint | null }
const EMPTY: Balances = { ostia: null, canton: null, gas: null };
/** What a move of the chain's own coin leaves unspent, for the fees of its steps (a hundredth of a coin). */
const gasReserve = (decimals: number) => 10n ** BigInt(Math.max(decimals - 2, 0));

/** An amount: a field that grows to hold the whole of it. The typed text is also drawn in a hidden copy that wraps, which sets the field's height, so no digit is ever cut. */
function AmountField({ label, value, size, readOnly, onChange }: { label: string; value: string; size: string; readOnly?: boolean; onChange?: (t: string) => void }) {
  return (
    <div className={`amt amt-${size}`} data-value={`${value || "0"} `}>
      <textarea rows={1} aria-label={label} inputMode="decimal" autoComplete="off" spellCheck={false} placeholder="0" readOnly={readOnly} value={value} onChange={(e) => onChange?.(e.target.value.replace(/[\s\n]/g, ""))} />
    </div>
  );
}

export function MoveCard(p: MoveCardProps) {
  const { config, evm, session } = p;
  const pairs = useMemo(() => (config ? pairsOf(config, p.gateway) : []), [config, p.gateway]);
  const [sel, setSel] = useState<{ pair: string | null; from: Side }>({ pair: null, from: "ostia" });
  const [text, setText] = useState("");
  const [picker, setPicker] = useState<"from" | "to" | null>(null);
  const [bal, setBal] = useState<Balances>(EMPTY);
  const [tick, setTick] = useState(0);
  const [move, setMove] = useState<MoveState>({ phase: "idle" });
  const [problem, setProblem] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const pair: Pair | undefined = pairs.find((x) => x.key === sel.pair) ?? pairs[0];
  const from = sel.from;
  const symbols = pair ? { from: from === "ostia" ? pair.ostia.symbol : pair.canton.symbol, to: from === "ostia" ? pair.canton.symbol : pair.ostia.symbol } : null;

  // The move's state, and a move that was kept (after a reload) is picked up: the card shows what is on its way and offers to continue it.
  useEffect(() => {
    if (!session) { setMove({ phase: "idle" }); return; }
    setMove(session.move.state);
    const off = session.move.subscribe(setMove);
    const kept = session.kept()[0];
    if (kept) {
      const found = pairs.find((x) => x.erc20.toLowerCase() === kept.input.asset.toLowerCase());
      if (found) { setSel({ pair: found.key, from: kept.input.kind === "lock" || kept.input.kind === "withdraw" ? "ostia" : "canton" }); setText(kept.input.amount); }
      void session.move.resume();
    }
    return off;
  }, [session, pairs]);
  useEffect(() => { if (move.phase === "final") { setText(""); setTick((n) => n + 1); p.onMoved?.(); } }, [move.phase]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Balances: Ostia's from the wallet's account, Canton's from the Canton account. Read again when the move ends and every 15 seconds.
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (!pair) return;
    let live = true;
    const hold = <T,>(f: Promise<T>) => f.then((v) => v as T | null, () => null);
    (async () => {
      const [held, gas] = evm ? await Promise.all([hold(evm.balanceOf(pair.erc20)), hold(evm.native())]) : [null, null];
      const ostia = held === null ? null : pair.native && gas !== null ? held + (gas > gasReserve(config!.chain.coin.decimals) ? gas - gasReserve(config!.chain.coin.decimals) : 0n) : held;
      const canton = session ? await hold(session.cantonBalance({ admin: pair.canton.admin, id: pair.canton.id })) : null;
      if (live) setBal({ ostia, canton, gas });
    })();
    return () => { live = false; };
  }, [pair?.key, evm, session, tick]);   // eslint-disable-line react-hooks/exhaustive-deps

  const parsed = useMemo(() => {
    if (!pair || text.trim() === "") return { state: "empty" as const, error: null, units: null };
    try { return { state: "ok" as const, error: null, units: parseAmount(text, pair.ostia.decimals) }; }
    catch (e) { return { state: "bad" as const, error: e instanceof AmountError ? e.message : null, units: null }; }
  }, [pair, text]);
  const have = from === "ostia" ? bal.ostia : bal.canton;
  const enough = parsed.units && have !== null ? (from === "ostia" ? parsed.units.base : parsed.units.twin) <= have : null;
  const tokenDecimals = (s: Side) => (!pair ? 18 : s === "ostia" ? pair.ostia.decimals : pair.canton.decimals);

  const to = from === "ostia" ? "Canton" : p.chainName;
  const button = buttonOf({
    connected: p.account !== null, accountReady: session !== null, config: p.configState, amount: parsed.state, enough, symbol: symbols?.from ?? "",
    to, move, kept: move.phase === "failed" && move.kept,
  });
  const kind = pair ? moveOf(pair, from) : null;
  const steps = pair && kind ? stepsOf(kind, symbols!.from, pair.native && from === "ostia", p.chainName) : [];
  const pops = popups(steps), signs = kind ? cantonSignatures(kind) : 0;
  const note = noteOf(move);
  const running = progressWords(move, symbols?.from ?? "") !== null || starting;

  const press = useCallback(async () => {
    setProblem(null);
    if (button.action === "connect") return p.onConnect();
    if (button.action === "open") return p.onOpenAccount();
    if (!session || !pair) return;
    try {
      if (button.action === "continue") { await session.move.proceed(); return; }
      if (button.action !== "move") return;
      setStarting(true);
      const why = await p.ensureChain();
      if (why) return setProblem(why);
      await session.move.start(inputOf(pair, from, text.trim(), session.party));
    } catch (e) { setProblem(moveWords(e instanceof Error ? e.message : null)); }
    finally { setStarting(false); }
  }, [button.action, session, pair, from, text, p]);   // eslint-disable-line react-hooks/exhaustive-deps
  const giveUp = async () => { try { await session?.move.abandon(); setText(""); } catch (e) { setProblem(moveWords(e instanceof Error ? e.message : null)); } };

  const pick = (t: Token, field: "from" | "to") => {
    setPicker(null);
    const side: Side = field === "from" ? t.side : t.side === "ostia" ? "canton" : "ostia";
    setSel({ pair: t.pair, from: side });
    setText("");
  };
  const flip = () => setSel({ pair: pair?.key ?? null, from: from === "ostia" ? "canton" : "ostia" });

  const chip = (side: Side): string => (side === "ostia" ? (p.account ? short(p.account, 6, 4) : "Not connected") : session ? short(session.party, 10, 4) : "Not opened");
  const shown = (b: bigint | null, side: Side) => (b === null ? "–" : showUnits(b, tokenDecimals(side)));
  const edit = (t: string) => { setText(t); setProblem(null); };
  const locked = running || move.phase === "paused" || (move.phase === "failed" && move.kept);

  const side = (field: "from" | "to") => {
    const s: Side = field === "from" ? from : from === "ostia" ? "canton" : "ostia";
    const tok = symbols ? (field === "from" ? symbols.from : symbols.to) : "";
    const balance = s === "ostia" ? bal.ostia : bal.canton;
    const where = s === "ostia" ? `on ${p.chainName}` : "on Canton";
    return (
      <div className={`side ${field}`}>
        <div className="side-h"><span className="lbl">{field === "from" ? "From" : "To"}</span><span className="wchip mono" title={s === "ostia" ? p.account ?? undefined : session?.party}>{chip(s)}</span></div>
        <div className="tok-row">
          <button type="button" className="tok" disabled={!pair || locked} aria-label={`${field === "from" ? "From" : "To"} token ${tok} ${where}`} onClick={() => setPicker(field)}>
            <b>{tok || "–"}</b><span className="muted small">{where}</span><Icon name="down" size={12} />
          </button>
          <AmountField label={field === "from" ? "Amount to move" : "Amount you get"} value={text} size={amountSize(text)} readOnly={field === "to" || locked} onChange={edit} />
        </div>
        <p className="bal small muted">
          Balance <span className="num">{shown(balance, s)}</span>
          {field === "from" && balance !== null && !locked && maxText(balance, tokenDecimals(s)) !== "" && <> · <button type="button" className="link-b" onClick={() => edit(maxText(balance, tokenDecimals(s)))}>Max</button></>}
        </p>
      </div>
    );
  };

  let extra: ReactNode = null;
  if (move.phase === "final" && text === "") extra = <p className="small ok" role="status">Done. It is final in <Link to={`/block/${move.block}`}>block {move.block}</Link>.</p>;
  return (
    <section className="card move" aria-label="Move tokens">
      {!pair ? (
        <>
          <p className="muted">{p.configState === "failed" ? "The bridge is not available on this chain yet." : "Looking up the tokens…"}</p>
          <button type="button" className="btn go" disabled={button.disabled} onClick={press}>{button.label}</button>
          {p.connectNote && <p className="small bad" role="alert">{p.connectNote}</p>}
        </>
      ) : (
        <>
          {side("from")}
          <button type="button" className="flip" aria-label="Swap direction" disabled={locked} onClick={flip}><Icon name="swap" size={16} /></button>
          {side("to")}
          {parsed.error && <p className="small bad" role="status">{parsed.error}</p>}
          <button type="button" className="btn go" disabled={button.disabled} onClick={press}>{button.label}</button>
          {button.action === "continue" && <button type="button" className="link-b give-up" onClick={giveUp}>Give this move up</button>}
          {note && <p className={`small ${note.bad ? "bad" : "muted"}`} role={note.bad ? "alert" : "status"}>{note.text}</p>}
          {problem && <p className="small bad" role="alert">{problem}</p>}
          {p.connectNote && <p className="small bad" role="alert">{p.connectNote}</p>}
          {extra}
          {p.faucet && bal.gas === 0n && <p className="small"><button type="button" className="link-b" disabled={p.faucet.busy} onClick={p.faucet.onGet}>{p.faucet.busy ? "Asking the faucet…" : p.faucet.label}</button> <span className="muted">You have none for fees.</span></p>}
          <details className="steps">
            <summary><span>About 30 s · {pops} MetaMask pop-up{pops === 1 ? "" : "s"}</span></summary>
            <ol>{steps.map((s, i) => <li key={i}><span>{s.text}</span> <span className="muted small">{s.by === "wallet" ? "MetaMask pop-up" : s.by === "page" ? "Signed by this page with your Canton account" : "Automatic"}</span></li>)}</ol>
            <p className="small muted">{pops} in MetaMask{signs > 0 ? `, ${signs} by your Canton account` : ""}.</p>
          </details>
        </>
      )}
      {picker && pair && <TokenPicker pairs={pairs} chainName={p.chainName} selected={`${pair.key}@${picker === "from" ? from : from === "ostia" ? "canton" : "ostia"}`} onPick={(t) => pick(t, picker)} onClose={() => setPicker(null)} />}
    </section>
  );
}

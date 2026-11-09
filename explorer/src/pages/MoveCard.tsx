import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../components/Icon.tsx";
import { short } from "../format.ts";
import { AmountError, maxText, normaliseAmount, parseAmount, showBalance } from "../bridge/amounts.ts";
import { continueWords, entryOf, recordOf } from "../bridge/activity.ts";
import { amountSize, buttonOf, noteOf, offersTakeBack, progressWords, TAKE_BACK_LABEL, waitFor } from "../bridge/card.ts";
import type { EvmAdapter } from "../bridge/evm/adapter.ts";
import type { BridgeConfig } from "../bridge/evm/config.ts";
import { CannotTakeBack } from "../bridge/moves/moves.ts";
import type { MoveState } from "../bridge/moves/state.ts";
import { popups, stepsOf, cantonSignatures } from "../bridge/moves/steps.ts";
import type { Session } from "../bridge/session.ts";
import { inWallet } from "../bridge/wallet/wallets.ts";
import { arrivesAs, inputOf, moveOf, pairsOf, type Pair, type Side, type Token } from "../bridge/tokens.ts";
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
  /** The move's machinery, once the Canton account is open and the bridge's setup is read. */
  session: Session | null;
  /** The Canton account is open (the machinery may still be getting built). */
  accountOpen: boolean;
  /** What the button says while the Canton account is not open, when it is not "Open my Canton account" (a connected wallet that has not opted in). */
  openLabel?: string;
  /** The name of the connected Canton wallet when the Canton steps are approved in it, else null (this page signs them with the Bridge account). */
  cantonWallet?: string | null;
  chainName: string;
  onConnect(): void;
  /** What the wallet or the page says of connecting, in plain words. */
  connectNote: string | null;
  onOpenAccount(): void;
  /** Puts the wallet on Ostia; says why not, in words, when it cannot. */
  ensureChain(): Promise<string | null>;
  /** The inline faucet for gas: shown when the account holds none. Null when this site has no faucet. */
  faucet: { label: string; busy: boolean; coming?: boolean; onGet(): void; /** Shown under the inline faucet: the builder grant's offer, when it is on. */ extra?: ReactNode } | null;
  /** Called with what the wallet holds of the chain's coin, each time it is read (null while not known). */
  onGas?(gas: bigint | null): void;
  /** Counts up when the balances should be read again (after the faucet is asked). */
  refresh?: number;
  /** Counts up while the page waits for the wallet's coin to land: only the wallet's balances are read again, never the Canton account's. */
  poll?: number;
  /** What the Canton account holds of each listed token (by the token's key; null when it could not be read), said each time it is read, so the page's other panels show it without reading it again. */
  onCanton?(held: Record<string, bigint | null>): void;
  /** Said once a move is final. The page reads the kept moves from `session.move`. */
  onMoved?(): void;
}

/** `ostia` is what the From side can spend (for the chain's own coin, the coin and its wrapped form together); `wrapped` is only what the token itself holds, which is what a move back from Canton adds to. */
interface Balances { ostia: bigint | null; wrapped: bigint | null; canton: bigint | null; gas: bigint | null }
/** What a move of the chain's own coin leaves unspent, for the fees of its steps (a hundredth of a coin). */
const gasReserve = (decimals: number) => 10n ** BigInt(Math.max(decimals - 2, 0));

/** An amount: a field that grows to hold the whole of it. The typed text is also drawn in a hidden copy that wraps, which sets the field's height, so no digit is ever cut. */
function AmountField({ label, value, size, readOnly, onChange, onBlur }: { label: string; value: string; size: string; readOnly?: boolean; onChange?: (t: string) => void; onBlur?: () => void }) {
  return (
    <div className={`amt amt-${size}`} data-value={`${value || "0"} `}>
      <textarea rows={1} aria-label={label} inputMode="decimal" autoComplete="off" spellCheck={false} placeholder="0" readOnly={readOnly} value={value} onChange={(e) => onChange?.(e.target.value.replace(/[\s\n]/g, ""))} onBlur={onBlur} />
    </div>
  );
}

export function MoveCard(p: MoveCardProps) {
  const { config, evm, session } = p;
  const pairs = useMemo(() => (config ? pairsOf(config, p.gateway) : []), [config, p.gateway]);
  const [sel, setSel] = useState<{ pair: string | null; from: Side }>({ pair: null, from: "ostia" });
  const [text, setText] = useState("");
  const [picker, setPicker] = useState<"from" | "to" | null>(null);
  const [wallet, setWallet] = useState<Omit<Balances, "canton">>({ ostia: null, wrapped: null, gas: null });
  /** What the Canton account holds of every listed token, from one read of its holdings. */
  const [held, setHeld] = useState<Record<string, bigint | null>>({});
  const [tick, setTick] = useState(0);
  const [move, setMove] = useState<MoveState>({ phase: "idle" });
  const [problem, setProblem] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [asking, setAsking] = useState(false);
  /** Canton would not take a deposit's tokens back: the person is asked once more before the deposit is given up with its tokens still locked. */
  const [stuck, setStuck] = useState(false);

  const pair: Pair | undefined = pairs.find((x) => x.key === sel.pair) ?? pairs[0];
  const from = sel.from;
  const symbols = pair ? { from: from === "ostia" ? pair.ostia.symbol : pair.canton.symbol, to: arrivesAs(pair, from) } : null;

  // The move's state, and a move that was kept (after a reload) is picked up: the card shows what is on its way and offers to continue it.
  useEffect(() => {
    if (!session) { setMove({ phase: "idle" }); return; }
    setMove(session.move.state);
    const off = session.move.subscribe(setMove);
    const kept = recordOf(session.kept(), session.move.current) ?? session.kept()[0];
    if (kept) {
      const found = pairs.find((x) => x.erc20.toLowerCase() === kept.input.asset.toLowerCase());
      if (found) { setSel({ pair: found.key, from: kept.input.kind === "lock" || kept.input.kind === "withdraw" ? "ostia" : "canton" }); setText(kept.input.amount); }
      void session.move.resume(kept.ref);
    }
    return off;
  }, [session, pairs]);
  useEffect(() => { if (move.phase === "final") { setText(""); setTick((n) => n + 1); p.onMoved?.(); } }, [move.phase]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Balances: Ostia's from the wallet's account, Canton's from the Canton account. Read again when the move ends and every 15 seconds.
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(id);
  }, []);
  // The balances of another token are not this token's: they are dropped when the token changes, until the new ones are read.
  const lastKey = useRef<string | undefined>(pair?.key);
  useEffect(() => {
    if (!pair) return;
    if (lastKey.current !== pair.key) { lastKey.current = pair.key; setWallet({ ostia: null, wrapped: null, gas: null }); }
    let live = true;
    const hold = <T,>(f: Promise<T>) => f.then((v) => v as T | null, () => null);
    (async () => {
      const [held, gas] = evm ? await Promise.all([hold(evm.balanceOf(pair.erc20)), hold(evm.native())]) : [null, null];
      const ostia = held === null ? null : pair.native && gas !== null ? held + (gas > gasReserve(config!.chain.coin.decimals) ? gas - gasReserve(config!.chain.coin.decimals) : 0n) : held;
      if (live) setWallet({ ostia, wrapped: held, gas });
    })();
    return () => { live = false; };
  }, [pair?.key, evm, tick, p.refresh, p.poll]);   // eslint-disable-line react-hooks/exhaustive-deps
  // The Canton account's balances: one read of its holdings for all the listed tokens (the card's and the page's account panel's), on the card's own tick, when a move ends or a coin is asked for; not on the wallet-coin wait's quick ticks.
  useEffect(() => {
    if (!session || pairs.length === 0) { setHeld({}); return; }
    let live = true;
    session.cantonBalances(pairs.map((x) => ({ admin: x.canton.admin, id: x.canton.id }))).then(
      (rows) => { if (live) setHeld(Object.fromEntries(pairs.map((x, i) => [x.key, rows[i] ?? null]))); },
      () => { if (live) setHeld(Object.fromEntries(pairs.map((x) => [x.key, null]))); },
    );
    return () => { live = false; };
  }, [session, pairs, tick, p.refresh]);
  useEffect(() => { p.onCanton?.(held); }, [held]);   // eslint-disable-line react-hooks/exhaustive-deps
  const bal: Balances = { ...wallet, canton: pair ? held[pair.key] ?? null : null };
  useEffect(() => { p.onGas?.(bal.gas); }, [bal.gas]);   // eslint-disable-line react-hooks/exhaustive-deps

  const parsed = useMemo(() => {
    if (!pair || text.trim() === "") return { state: "empty" as const, error: null, units: null };
    try { return { state: "ok" as const, error: null, units: parseAmount(text, pair.ostia.decimals) }; }
    catch (e) { return { state: "bad" as const, error: e instanceof AmountError ? e.message : null, units: null }; }
  }, [pair, text]);
  const have = from === "ostia" ? bal.ostia : bal.canton;
  const enough = parsed.units && have !== null ? (from === "ostia" ? parsed.units.base : parsed.units.twin) <= have : null;
  const tokenDecimals = (s: Side) => (!pair ? 18 : s === "ostia" ? pair.ostia.decimals : pair.canton.decimals);

  const to = from === "ostia" ? "Canton" : p.chainName;
  const keptNow = move.phase === "paused" || (move.phase === "failed" && move.kept) ? recordOf(session?.kept() ?? [], session?.move.current) : undefined;
  // A kept deposit whose time to settle has passed can have its tokens taken back on Canton: asked of the move, which also knows the gateway shows no claim for it.
  const [due, setDue] = useState(false);
  const keptRef = keptNow?.ref, keptStage = keptNow?.stage;
  useEffect(() => {
    setDue(false);
    if (!session || !keptRef) return;
    let live = true;
    const look = () => session.move.takeBackDue(keptRef).then((v) => { if (live) setDue(v); }, () => {});
    void look();
    const timer = setInterval(() => void look(), 60_000);   // the time to settle may pass while the card is open
    return () => { live = false; clearInterval(timer); };
  }, [session, keptRef, keptStage, move.phase]);
  const button = buttonOf({
    connected: p.account !== null, needCoin: p.faucet && bal.gas === 0n ? config?.chain.coin.symbol : undefined, asking: p.faucet?.busy, coming: p.faucet?.coming, accountReady: p.accountOpen, openLabel: p.openLabel, preparing: session === null, config: p.configState, amount: parsed.state, enough, symbol: symbols?.from ?? "",
    to, move, kept: move.phase === "failed" && move.kept, continueLabel: keptNow ? continueWords(entryOf(keptNow), p.chainName) : undefined,
  });
  const kind = pair ? moveOf(pair, from) : null;
  const steps = pair && kind ? stepsOf(kind, symbols!.from, pair.native, p.chainName, pair.wrapped, p.cantonWallet ?? undefined) : [];
  const pops = popups(steps), signs = kind ? cantonSignatures(kind) : 0;
  const note = noteOf(move);
  const running = progressWords(move, symbols?.from ?? "") !== null || starting;

  const press = useCallback(async () => {
    if (starting) return;
    setProblem(null);
    if (button.action === "connect") return p.onConnect();
    if (button.action === "faucet") return p.faucet?.onGet();
    if (button.action === "open") return p.onOpenAccount();
    if (!session || !pair) return;
    try {
      if (button.action !== "continue" && button.action !== "move") return;
      setStarting(true);
      const why = await p.ensureChain();
      if (why) return setProblem(why);
      if (button.action === "continue") { await session.move.proceed(); return; }
      await session.move.start(inputOf(pair, from, normaliseAmount(text), session.party));
    } catch (e) { setProblem(moveWords(e instanceof Error ? e.message : null)); }
    finally { setStarting(false); }
  }, [button.action, session, pair, from, text, p, starting]);   // eslint-disable-line react-hooks/exhaustive-deps
  // A move Canton or the wallet may already know cannot be finished by this page once it is given up, so it is asked first.
  const giveUp = async (leaveLocked = false) => {
    setAsking(false); setStuck(false);
    try { await session?.move.abandon(undefined, { leaveLocked }); setText(""); }
    catch (e) { if (e instanceof CannotTakeBack) setStuck(true); else setProblem(moveWords(e instanceof Error ? e.message : null)); }
  };

  const takeBack = async () => {
    if (!session || !keptNow || starting) return;
    setProblem(null); setStarting(true);
    try { await session.move.takeBack(keptNow.ref); setText(""); } catch (e) { if (e instanceof CannotTakeBack) setStuck(true); else setProblem(moveWords(e instanceof Error ? e.message : null)); }
    finally { setStarting(false); }
  };

  const pick = (t: Token, field: "from" | "to") => {
    setPicker(null);
    const side: Side = field === "from" ? t.side : t.side === "ostia" ? "canton" : "ostia";
    setSel({ pair: t.pair, from: side });
    setText("");
  };
  // What Max fills in must be an amount the button takes: on the Canton side the balance is cut to the digits the Ostia token has (Canton holds ten).
  const maxFor = (b: bigint, s: Side) => {
    if (s === "ostia" || !pair) return maxText(b, tokenDecimals(s));
    const d = Math.min(pair.ostia.decimals, 10);
    return maxText(b - (b % 10n ** BigInt(10 - d)), 10);
  };
  const flip = () => setSel({ pair: pair?.key ?? null, from: from === "ostia" ? "canton" : "ostia" });

  const chip = (side: Side): string => (side === "ostia" ? (p.account ? short(p.account, 6, 4) : "Not connected") : session ? short(session.party, 10, 4) : "Not opened");
  const shown = (b: bigint | null, side: Side) => (b === null ? "–" : showBalance(b, tokenDecimals(side)));
  // A keypad set to a comma-decimal language offers only the comma: one comma and no point is read as the decimal point. Anything else (two commas, a comma and a point) is left for the amount check to refuse.
  const edit = (t: string) => { setText(/^[^.,]*,[^.,]*$/.test(t) ? t.replace(",", ".") : t); setProblem(null); };
  // Leaving the field shows the amount as it is read: ".5" is "0.5" and "5." is "5".
  const settle = () => setText((t) => normaliseAmount(t));
  const locked = running || move.phase === "paused" || (move.phase === "failed" && move.kept);

  const side = (field: "from" | "to") => {
    const s: Side = field === "from" ? from : from === "ostia" ? "canton" : "ostia";
    const tok = symbols ? (field === "from" ? symbols.from : symbols.to) : "";
    const balance = s === "ostia" ? (field === "to" && pair?.native ? bal.wrapped : bal.ostia) : bal.canton;
    const where = s === "ostia" ? `on ${p.chainName}` : "on Canton";
    return (
      <div className={`side ${field}`}>
        <div className="side-h"><span className="lbl">{field === "from" ? "From" : "To"}</span><span className="wchip mono" title={s === "ostia" ? p.account ?? undefined : session?.party}>{chip(s)}</span></div>
        <div className="tok-row">
          <button type="button" className="tok" disabled={!pair || locked} aria-label={`${field === "from" ? "From" : "To"} token ${tok} ${where}`} onClick={() => setPicker(field)}>
            <b>{tok || "–"}</b><span className="muted small">{where}</span><Icon name="down" size={12} />
          </button>
          <AmountField label={field === "from" ? "Amount to move" : "Amount you get"} value={text} size={amountSize(text)} readOnly={field === "to" || locked} onChange={edit} onBlur={field === "from" ? settle : undefined} />
        </div>
        <p className="bal small muted">
          Balance <span className="num">{shown(balance, s)}</span>
          {field === "from" && balance !== null && !locked && maxFor(balance, s) !== "" && <> · <button type="button" className="link-b" onClick={() => edit(maxFor(balance, s))}>Max</button></>}
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
          <p className="muted">{p.configState === "failed" ? "The bridge is not available on this chain yet." : p.configState === "ready" ? "There are no tokens to move here yet." : "Looking up the tokens…"}</p>
          <button type="button" className="btn go" disabled={button.disabled || starting} onClick={press}>{button.label}</button>
          {p.connectNote && <p className="small bad" role="alert">{p.connectNote}</p>}
        </>
      ) : (
        <>
          {side("from")}
          <button type="button" className="flip" aria-label="Swap direction" disabled={locked} onClick={flip}><Icon name="swap" size={16} /></button>
          {side("to")}
          {parsed.error && <p className="small bad" role="status">{parsed.error}</p>}
          <button type="button" className="btn go" disabled={button.disabled || starting} onClick={press}>{button.label}</button>
          {button.action === "continue" && !asking && offersTakeBack(keptNow, due) && <button type="button" className="link-b give-up" disabled={starting} onClick={() => void takeBack()}>{TAKE_BACK_LABEL}</button>}
          {button.action === "continue" && !asking && !stuck && <button type="button" className="link-b give-up" onClick={() => (keptNow && keptNow.stage !== "start" ? setAsking(true) : void giveUp())}>Give this move up</button>}
          {button.action === "continue" && stuck && (
            <div className="give-up" role="group" aria-label="Give this deposit up with its tokens locked">
              <p className="small bad">Canton would not take the tokens back. If you give this deposit up now, they stay locked on Canton.</p>
              <button type="button" className="link-b" onClick={() => void giveUp(true)}>Give it up, leave the tokens locked</button> <button type="button" className="link-b" onClick={() => setStuck(false)}>Keep it</button>
            </div>
          )}
          {button.action === "continue" && asking && (
            <div className="give-up" role="group" aria-label="Give this move up">
              <p className="small muted">Part of this move may already be done. If you give it up, this page cannot finish it.</p>
              <button type="button" className="link-b" onClick={() => void giveUp()}>Give it up</button> <button type="button" className="link-b" onClick={() => setAsking(false)}>Keep it</button>
            </div>
          )}
          {note && <p className={`small ${note.bad ? "bad" : "muted"}`} role={note.bad ? "alert" : "status"}>{note.text}</p>}
          {problem && <p className="small bad" role="alert">{problem}</p>}
          {p.connectNote && <p className="small bad" role="alert">{p.connectNote}</p>}
          {extra}
          {p.faucet && bal.gas === 0n && button.action !== "faucet" && <p className="small"><button type="button" className="link-b" disabled={p.faucet.busy || p.faucet.coming} onClick={p.faucet.onGet}>{p.faucet.busy ? "Asking the faucet…" : p.faucet.coming ? `${config?.chain.coin.symbol ?? "Test coin"} is on its way…` : p.faucet.label}</button> <span className="muted">You have none for fees.</span></p>}
          {p.faucet && bal.gas === 0n && p.faucet.extra}
          <details className="move-steps">
            <summary><span>{waitFor(pops)} · {pops} MetaMask pop-up{pops === 1 ? "" : "s"}</span></summary>
            <ol>{steps.map((s, i) => <li key={i}><span>{s.text}</span> <span className={`muted small by-${s.by}`}>{s.by === "wallet" ? "MetaMask pop-up" : s.by === "page" ? (p.cantonWallet ? `Approve in ${inWallet(p.cantonWallet)}` : "Signed by this page") : "Automatic"}</span></li>)}</ol>
            <p className="small muted">{pops} in MetaMask{signs > 0 ? (p.cantonWallet ? `, ${signs} in ${inWallet(p.cantonWallet)}` : `, ${signs} by your Canton account`) : ""}.</p>
          </details>
        </>
      )}
      {picker && pair && <TokenPicker pairs={pairs} chainName={p.chainName} selected={`${pair.key}@${picker === "from" ? from : from === "ostia" ? "canton" : "ostia"}`} onPick={(t) => pick(t, picker)} onClose={() => setPicker(null)} />}
    </section>
  );
}

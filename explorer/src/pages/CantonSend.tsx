import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AmountError, normaliseAmount } from "../bridge/amounts.ts";
import { checkAmount, checkReceiver, confirmLine, shortAddress, tidyAmount } from "../bridge/sendwords.ts";
import type { Incoming, SendResult, Sender, Sent } from "../bridge/send.ts";
import type { Pair } from "../bridge/tokens.ts";
import { GENERIC, moveWords, plainWords } from "../bridge/words.ts";

/** What went wrong with a send or an accept, in plain words. A refusal by Canton says what it most likely means for a person. */
function problemWords(e: unknown, what: "send" | "accept" | "takeback"): string {
  const x = e as { name?: unknown; kind?: unknown; message?: unknown } | null;
  if (x?.name === "AccountsError" && x.kind === "refused") {
    return what === "send" ? "Canton did not take this transfer. The receiver may not be set up for this token yet. Nothing was sent."
      : what === "takeback" ? "Canton did not take this back. The receiver may have accepted it just now. Nothing was changed. Check again in a moment."
      : "Canton did not take this transfer. It may have been taken back or have run out of time. Nothing was changed.";
  }
  const known = plainWords(e);
  return known === GENERIC && e instanceof Error ? moveWords(e.message) : known;   // the page's own sentences (a refusal to spend tokens that are held elsewhere) pass through moveWords
}

type Result = { s: "idle" } | { s: "working" } | { s: "done"; result: SendResult; line: string } | { s: "failed"; message: string };

/** "Send on Canton": a token the account holds on Canton, an amount and the receiver's address; a line to confirm; then the page signs (no wallet pop-up) and says what happened. */
export function SendOnCanton({ sender, pairs, held, party, onChanged }: { sender: Sender; pairs: Pair[]; held: Record<string, bigint | null>; party: string; onChanged(): void }) {
  const sendable = useMemo(() => pairs.filter((p) => (held[p.key] ?? 0n) > 0n && sender.can(p)), [pairs, held, sender]);
  const [key, setKey] = useState<string>("");
  const [amount, setAmount] = useState("");
  const [receiver, setReceiver] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<Result>({ s: "idle" });
  const pair = sendable.find((p) => p.key === key) ?? sendable[0];

  const checked = useMemo(() => {
    if (!pair) return { ok: false as const, amountError: null, receiverError: null };
    let amountError: string | null = null, receiverError: string | null = null;
    if (amount.trim() !== "") { try { checkAmount(amount, pair, held[pair.key] ?? null); } catch (e) { amountError = e instanceof AmountError ? e.message : GENERIC; } }
    if (receiver.trim() !== "") { try { checkReceiver(receiver, party); } catch (e) { receiverError = e instanceof AmountError ? e.message : GENERIC; } }
    return { ok: amount.trim() !== "" && receiver.trim() !== "" && !amountError && !receiverError, amountError, receiverError };
  }, [pair, amount, receiver, held, party]);
  useEffect(() => setConfirming(false), [pair?.key, amount, receiver]);

  const line = pair && checked.ok ? confirmLine(tidyAmount(amount, pair.ostia.decimals), pair.canton.symbol, receiver.trim()) : null;
  const working = result.s === "working";

  const send = useCallback(async () => {
    if (!pair || !line || working) return;
    setResult({ s: "working" });
    try {
      const done = await sender.send(pair, normaliseAmount(amount), receiver.trim());
      setResult({ s: "done", result: done, line });
      setAmount(""); setReceiver(""); setConfirming(false);
      onChanged();
    } catch (e) { setResult({ s: "failed", message: problemWords(e, "send") }); setConfirming(false); }
  }, [pair, line, working, sender, amount, receiver, onChanged]);

  if (sendable.length === 0) {
    return (
      <div className="send" role="group" aria-labelledby="send-h">
        <h3 id="send-h">Send on Canton</h3>
        <p className="small muted">Nothing to send yet. The tokens you hold on Canton show up here.</p>
        {result.s === "done" && <Done done={result} />}
      </div>
    );
  }
  return (
    <div className="send" role="group" aria-labelledby="send-h">
      <h3 id="send-h">Send on Canton</h3>
      <label className="field"><span className="lbl">Token</span>
        <select value={pair?.key ?? ""} onChange={(e) => setKey(e.target.value)} disabled={working}>
          {sendable.map((p) => <option key={p.key} value={p.key}>{p.canton.symbol}</option>)}
        </select>
      </label>
      <label className="field"><span className="lbl">Amount</span>
        <input type="text" inputMode="decimal" autoComplete="off" spellCheck={false} placeholder="0" value={amount} disabled={working} onChange={(e) => setAmount(e.target.value.replace(/\s/g, ""))} />
      </label>
      {checked.amountError && <p className="small bad" role="alert">{checked.amountError}</p>}
      <label className="field"><span className="lbl">Receiver's Canton address</span>
        <input type="text" autoComplete="off" spellCheck={false} placeholder="name::1220…" value={receiver} disabled={working} onChange={(e) => setReceiver(e.target.value.replace(/\s/g, ""))} />
      </label>
      {checked.receiverError && <p className="small bad" role="alert">{checked.receiverError}</p>}
      {confirming && line ? (
        <>
          <p className="confirm" role="status">{line}</p>
          <div className="actions">
            <button type="button" className="btn" disabled={working} onClick={send}>{working ? "Sending…" : "Send"}</button>
            <button type="button" className="btn ghost" disabled={working} onClick={() => setConfirming(false)}>Back</button>
          </div>
        </>
      ) : (
        <button type="button" className="btn" disabled={!checked.ok || working} onClick={() => { setResult({ s: "idle" }); setConfirming(true); }}>Review</button>
      )}
      {result.s === "done" && <Done done={result} />}
      {result.s === "failed" && <p className="small bad" role="alert">{result.message}</p>}
    </div>
  );
}

function Done({ done }: { done: { result: SendResult } }) {
  const { result } = done;
  return (
    <p className="small" role="status">
      {result.waiting ? "Sent; waiting for the receiver to accept." : "Sent. It is in their account."}{" "}
      <Link to={`/canton/${result.updateId}`}>Canton update</Link>
    </p>
  );
}

type Looked = { s: "loading" } | { s: "ready"; offers: Incoming[]; sent: Sent[]; more: boolean } | { s: "failed" };

/** "Incoming": the transfers offered to the account, each with Accept. The page looks when the account opens, after each accept and send, and when the person asks. */
export function IncomingTransfers({ sender, pairs, refresh, onChanged }: { sender: Sender; pairs: Pair[]; refresh: number; onChanged(): void }) {
  const [looked, setLooked] = useState<Looked>({ s: "loading" });
  const [again, setAgain] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<string | null>(null);
  useEffect(() => {
    if (pairs.length === 0) { setLooked({ s: "ready", offers: [], sent: [], more: false }); return; }
    let live = true;
    sender.waiting(pairs).then(({ offers, sent, more }) => { if (live) setLooked({ s: "ready", offers, sent, more }); }, () => { if (live) setLooked({ s: "failed" }); });
    return () => { live = false; };
  }, [sender, pairs, again, refresh]);

  const accept = async (o: Incoming) => {
    if (busy) return;
    setBusy(o.id); setProblem(null); setAccepted(null);
    try {
      await sender.accept(o);
      setAccepted(`${o.amount} ${o.pair.canton.symbol} is in your account.`);
      setLooked((l) => (l.s === "ready" ? { ...l, offers: l.offers.filter((x) => x.id !== o.id) } : l));
      onChanged();
    } catch (e) { setProblem(problemWords(e, "accept")); }
    finally { setBusy(null); }
  };
  const takeBack = async (o: Sent) => {
    if (busy) return;
    setBusy(o.id); setProblem(null); setAccepted(null);
    try {
      await sender.takeBack(o);
      setAccepted(`${o.amount} ${o.pair.canton.symbol} is back in your account.`);
      setLooked((l) => (l.s === "ready" ? { ...l, sent: l.sent.filter((x) => x.id !== o.id) } : l));
      onChanged();
    } catch (e) {
      const gone = (e as { name?: unknown; kind?: unknown } | null)?.name === "AccountsError" && (e as { kind?: unknown }).kind === "not-found";   // the receiver accepted it between the list and the click
      setProblem(gone ? "This transfer is no longer waiting. The receiver may have accepted it." : problemWords(e, "takeback"));
      if (gone) setAgain((n) => n + 1);   // read the list again, so the row goes
    }
    finally { setBusy(null); }
  };
  const offers = looked.s === "ready" ? looked.offers : [];
  const sentOnes = looked.s === "ready" ? looked.sent : [];
  return (
    <div className="incoming" role="group" aria-labelledby="incoming-h">
      <div className="incoming-h"><h3 id="incoming-h">Incoming</h3><button type="button" className="link-b small" disabled={busy !== null} onClick={() => setAgain((n) => n + 1)}>Check again</button></div>
      {looked.s === "loading" && <p className="small muted">Looking for transfers to you…</p>}
      {looked.s === "failed" && <p className="small bad" role="alert">Could not look for transfers just now. Check again in a moment.</p>}
      {looked.s === "ready" && offers.length === 0 && <p className="small muted">No transfers are waiting for you.</p>}
      {offers.length > 0 && (
        <ul className="offers">
          {offers.map((o) => (
            <li key={o.id}>
              <span className="offer-what"><b>{o.amount} {o.pair.canton.symbol}</b> <span className="muted small">from <span className="mono" title={o.from}>{shortAddress(o.from)}</span></span></span>
              <button type="button" className="btn ghost" disabled={busy !== null} onClick={() => accept(o)}>{busy === o.id ? "Accepting…" : "Accept"}</button>
            </li>
          ))}
        </ul>
      )}
      {sentOnes.length > 0 && (
        <>
          <p className="small muted">Sent by you, not accepted yet. The tokens are in the transfer until the receiver accepts, or you take them back.</p>
          <ul className="offers">
            {sentOnes.map((o) => (
              <li key={o.id}>
                <span className="offer-what"><b>{o.amount} {o.pair.canton.symbol}</b> <span className="muted small">to <span className="mono" title={o.to}>{shortAddress(o.to)}</span>{o.lapsed ? ", not accepted in time" : ""}</span></span>
                <button type="button" className="btn ghost" disabled={busy !== null} onClick={() => takeBack(o)}>{busy === o.id ? "Taking back…" : "Take back"}</button>
              </li>
            ))}
          </ul>
        </>
      )}
      {looked.s === "ready" && looked.more && <p className="small muted">More transfers are waiting than shown here.</p>}
      {accepted && <p className="small" role="status">{accepted}</p>}
      {problem && <p className="small bad" role="alert">{problem}</p>}
    </div>
  );
}

import { useMemo, useState } from "react";
import { checkAddress, checkAmount } from "../bridge/route/form.ts";
import type { RouteAsset, RouteOn } from "../bridge/route/setup.ts";
import { DEST, exact, TRUST } from "../bridge/route/words.ts";
import { timeWords } from "../bridge/other/words.ts";
import { TRUST_MODEL_PAGE } from "../copy.ts";
import { OutLink } from "../components/Help.tsx";

export interface SendInput { asset: RouteAsset; amount: bigint; address: string; /** The fee the page shows: the label's `maxFee`. */ maxFee: bigint }

/**
 * The form that starts a move on Canton: the asset, the amount and the address, the fee before anything is signed and what the person gets. It is shown only where the page can start a move on Canton
 * (`onSend` is given); until then moves are started elsewhere and the page shows them to the destination wallet.
 */
export function RouteForm({ setup, asset, account, onSend }: { setup: RouteOn; asset: RouteAsset; account: string | null; onSend(input: SendInput): Promise<void> }) {
  const [text, setText] = useState("");
  const [to, setTo] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const address = to ?? account ?? "";
  const checked = useMemo(() => checkAmount(asset, setup.unit, text), [asset, setup.unit, text]);
  const bad = address === "" ? null : checkAddress(address);
  const ready = checked.state === "ok" && address !== "" && bad === null;
  const time = timeWords(setup.time);
  async function send() {
    if (checked.state !== "ok" || !ready) return;
    setSending(true); setProblem(null);
    try { await onSend({ asset, amount: checked.amount, address: address.toLowerCase(), maxFee: checked.quote.fee }); setText(""); }
    catch (e) { setProblem(e instanceof Error ? e.message : "The move was not started. Nothing was sent."); }
    finally { setSending(false); }
  }
  return (
    <div className="route-form">
      <label className="field"><span className="lbl">Amount of {asset.symbol}</span><input inputMode="decimal" autoComplete="off" spellCheck={false} placeholder="0" value={text} disabled={sending} onChange={(e) => setText(e.target.value.replace(/\s/g, ""))} /></label>
      <div className="field">
        <span className="lbl">To {DEST}</span>
        {changing || account === null
          ? <input aria-label={`Address on ${DEST}`} spellCheck={false} autoComplete="off" value={address} disabled={sending} onChange={(e) => setTo(e.target.value.trim())} />
          : <span className="mono">{address} <span className="muted small">(your wallet)</span> <button type="button" className="link-b" onClick={() => setChanging(true)}>Change</button></span>}
      </div>
      {checked.state === "bad" && <p className="small bad" role="status">{checked.why}</p>}
      {bad && <p className="small bad" role="status">{bad}</p>}
      {checked.state === "ok" && (
        <>
          <p className="small">Fee {exact(checked.quote.fee, asset.decimals)} {asset.symbol}, taken from the amount. {asset.claimFee > 0n ? `It covers the cost on Ostia and the claim on ${DEST}.` : "It covers the cost on Ostia."}</p>
          <p className="small">You get {exact(checked.quote.send, asset.decimals)} {asset.symbol} on {DEST}</p>
        </>
      )}
      {time && <p className="small muted">Time {time}</p>}
      <ol className="small muted" aria-label="Steps"><li>Send from Canton (your Canton wallet)</li><li>Through Ostia</li><li>Confirmed on {DEST}</li><li>Arrived</li></ol>
      <button type="button" className="btn go" disabled={!ready || sending} onClick={() => void send()}>{sending ? "Confirm in your wallet…" : `Send to ${DEST}`}</button>
      {problem && <p className="small bad" role="alert">{problem}</p>}
      <p className="small muted">{TRUST(asset)} <OutLink href={TRUST_MODEL_PAGE}>Limits</OutLink></p>
    </div>
  );
}

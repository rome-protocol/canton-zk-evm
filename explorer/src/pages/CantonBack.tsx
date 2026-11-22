import { useEffect, useMemo, useState } from "react";
import type { Hex } from "viem";
import { AmountError, showBalance, showUnits } from "../bridge/amounts.ts";
import { parseBase } from "../bridge/other/amount.ts";
import { readBalances } from "../bridge/other/balances.ts";
import type { Asset, OpenRow } from "../bridge/other/setup.ts";
import { BRING_YOUR_OWN, otherWords, timeWords } from "../bridge/other/words.ts";
import { BACK_NAME, FROM, NO_ACCEPTANCE, NOT_AVAILABLE_BACK, payoutLine, quoteIn, SETTING_UP, short, smallestIn, WARN_BRIDGE_AND_CALL, wayBackLine } from "../bridge/route/in.ts";
import { exact } from "../bridge/route/words.ts";
import type { RouteAsset, RouteOn } from "../bridge/route/setup.ts";
import { CardHead } from "../components/Cards.tsx";
import { rpc } from "../rpc.ts";
import { timeoutSignal } from "../timeout.ts";
import { injected } from "../wallet.ts";
import { MoveMarks } from "./MoveMarks.tsx";
import { useMarks } from "./moveWatch.ts";
import { BACK_ROUTE, type Back } from "./useBack.ts";
import { useAddress } from "./useAddress.ts";

const explorerRead = (method: string, params: unknown[]) => rpc(method, params, timeoutSignal());

/** The wait for the account's Ostia address, with the Sent, Proven and Final marks of the transaction that opens it. */
function SettingUp({ openTx, time }: { openTx: string | null; time: string | null }) {
  const marks = useMarks((openTx as Hex | null) ?? null);
  return (
    <div role="status">
      <p className="small">{SETTING_UP}</p>
      <MoveMarks marks={marks} block={false} />
      {time && <p className="small muted">{time}</p>}
    </div>
  );
}

/**
 * Ethereum Sepolia to Canton: the Canton account (typed, until a Canton wallet can connect), its address on Ostia (shown only once a final block names it), the fee before anything is signed, what Canton can
 * pay out today, and the one send, signed in the EVM wallet on Ethereum Sepolia. The way back is the wallet's own address, and cannot be changed here.
 */
export function CantonBack({ setup, asset, sepolia, account, walletChainId, back, pollMs, onConnect }: {
  setup: RouteOn; asset: RouteAsset | null; sepolia: OpenRow; account: string | null; walletChainId: number | null; back: Back; pollMs: number; onConnect(): void;
}) {
  const flow = setup.in!;
  const copy: Asset | undefined = asset ? sepolia.assets.find((a) => a.ostia.toLowerCase() === asset.erc20) : undefined;
  const [party, setParty] = useState("");
  const [text, setText] = useState("");
  const [bal, setBal] = useState<bigint | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const state = useAddress({ party: party.trim(), wallet: account, router: flow.router, setupSeconds: flow.setupSeconds, pollMs });

  useEffect(() => {
    if (!account || !copy) return;
    let live = true;
    const read = () => void readBalances({ dir: "in", asset: copy, account, read: explorerRead, wallet: injected(), walletChainId, otherChainId: sepolia.chainId }).then((b) => { if (live) setBal(b.from); });
    read();
    const id = setInterval(read, pollMs);
    return () => { live = false; clearInterval(id); };
  }, [account, copy, walletChainId, sepolia.chainId, pollMs]);

  const checked = useMemo((): { state: "empty" } | { state: "bad"; why: string } | { state: "ok"; amount: bigint; fee: bigint; get: bigint } => {
    if (!asset || text.trim() === "") return { state: "empty" };
    let amount: bigint;
    try { amount = parseBase(text, asset.decimals); } catch (e) { return { state: "bad", why: e instanceof AmountError ? e.message : "Type an amount such as 12 or 12.5." }; }
    const q = quoteIn(asset, amount);
    if (!q) return { state: "bad", why: smallestIn(asset) };
    if (bal !== null && amount > bal) return { state: "bad", why: `You hold ${showBalance(bal, asset.decimals)} ${asset.symbol} on ${FROM}.` };
    return { state: "ok", amount, ...q };
  }, [asset, text, bal]);

  const unavailable = flow.route !== "open" || !sepolia.available || !asset || !copy || copy.decimals !== asset.decimals;
  const ready = state.kind === "ready" && checked.state === "ok" && account !== null && !sending;
  async function send() {
    if (state.kind !== "ready" || checked.state !== "ok" || !copy) return;
    setSending(true); setProblem(null);
    try { await back.send({ dir: "in", asset: copy, amount: checked.amount, to: { receiver: state.inbox, party: party.trim(), route: BACK_ROUTE } }); setText(""); }
    catch (e) { setProblem(otherWords(e, FROM, "Sepolia ETH")); }
    finally { setSending(false); }
  }
  const lines = {
    reading: "Checking this Canton account…", "no-acceptance": NO_ACCEPTANCE, unavailable: NOT_AVAILABLE_BACK,
  } as const;
  return (
    <section className="card move" aria-label={BACK_NAME}>
      <CardHead title={BACK_NAME} as="h2" />
      {unavailable || !asset || !copy
        ? <p className="small bad" role="status">{NOT_AVAILABLE_BACK}</p>
        : (
          <div className="route-form">
            {account === null
              ? <p className="small muted">Connect your wallet to send to Canton. <button type="button" className="link-b" onClick={onConnect}>Connect wallet</button></p>
              : <p className="small">From {FROM}, wallet <span className="mono">{short(account)}</span>. The way back is this address on {FROM}.</p>}
            <label className="field"><span className="lbl">Canton account</span><input aria-label="Canton account" spellCheck={false} autoComplete="off" placeholder="name::1220…" value={party} disabled={sending} onChange={(e) => setParty(e.target.value.replace(/\s/g, ""))} /></label>
            {(state.kind === "reading" || state.kind === "no-acceptance" || state.kind === "unavailable") && <p className={`small${state.kind === "reading" ? " muted" : " bad"}`} role="status">{lines[state.kind]}</p>}
            {state.kind === "setting-up" && <SettingUp openTx={state.openTx} time={timeWords(flow.setupTime)} />}
            {state.kind === "ready" && (
              <>
                <p className="small">Takes transfers from Ostia: yes</p>
                <p className="small">Its Ostia address <span className="mono" title={state.inbox}>{short(state.inbox)}</span>, checked on Ostia</p>
                <p className="small muted">{WARN_BRIDGE_AND_CALL}</p>
                <label className="field"><span className="lbl">Amount of {asset.symbol}</span><input inputMode="decimal" autoComplete="off" spellCheck={false} placeholder="0" value={text} disabled={sending} onChange={(e) => setText(e.target.value.replace(/\s/g, ""))} /></label>
                <p className="small muted">Balance {bal === null ? "–" : showBalance(bal, asset.decimals)}{bal !== null && bal > 0n && <> · <button type="button" className="link-b" onClick={() => setText(showUnits(bal, asset.decimals))}>Max</button></>}</p>
                {checked.state === "bad" && <p className="small bad" role="status">{checked.why}</p>}
                {checked.state === "ok" && (
                  <>
                    <p className="small">Fee {exact(checked.fee, asset.decimals)} {asset.symbol}, taken from the amount. It covers the cost on Ostia.</p>
                    <p className="small">The account gets {exact(checked.get, asset.decimals)} {asset.symbol}</p>
                  </>
                )}
                {payoutLine(asset, flow.payout, checked.state === "ok" ? checked.get : null, flow.refundWaitSeconds) && <p className="small" role="status">{payoutLine(asset, flow.payout, checked.state === "ok" ? checked.get : null, flow.refundWaitSeconds)}</p>}
                <p className="small muted">{wayBackLine(asset, account ?? "your wallet", flow.refundWaitSeconds)}</p>
                <ol className="small muted" aria-label="Steps"><li>Send from {FROM} (your EVM wallet, a little Sepolia ETH)</li><li>Ready on Ostia</li><li>Through Ostia to Canton</li><li>Arrived in the Canton account</li></ol>
                <p className="small muted">{BRING_YOUR_OWN}</p>
                <button type="button" className="btn go" disabled={!ready} onClick={() => void send()}>{sending ? "Confirm in your wallet…" : "Send to Canton"}</button>
                {problem && <p className="small bad" role="alert">{problem}</p>}
              </>
            )}
          </div>
        )}
    </section>
  );
}

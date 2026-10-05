import { useEffect, useRef, useState } from "react";
import "./VerifyPanel.css";
import { fetchVerifier, parseAnswer, type BlockFields, type LoadedVerifier, type Pins } from "./verifier.ts";

/** The pins as /api/status gives them, with the file they came from. */
export type PinsWithFile = Pins & { file: string };

export interface VerifyPanelProps {
  /** The block record's proof, header and transactions, as /api/block gives them. Null when the block has no record yet. */
  block: BlockFields | null;
  /** The block's hash as reth gives it. A pass must commit to this hash. */
  blockHash: string;
  /** This explorer's pins and the file they came from, from /api/status. */
  pins: PinsWithFile;
  /** True while the block is being proven. The panel is greyed and does nothing. */
  proving: boolean;
  /** Where the .wasm file is served from. It is fetched on the first press of Verify, and not before. */
  moduleUrl: string;
  /** The file's size in bytes, if the page knows it, to say before the press what the download is. */
  moduleSize?: number;
  /** Downloads and loads the check. The default fetches `moduleUrl`. */
  load?: () => Promise<LoadedVerifier>;
  /** The clock the check is timed by, in milliseconds. The default is the browser's `performance.now`. */
  now?: () => number;
}

type State =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "passed"; ms: number; txCount: number; blockHash: string }
  | { kind: "failed"; ms: number; reason: string }
  | { kind: "otherBlock"; ms: number; provenHash: string }
  | { kind: "error"; message: string };

const hex = (s: string) => s.replace(/^0x/i, "").toLowerCase();
const short = (s: string) => { const h = hex(s); return h.length > 12 ? `0x${h.slice(0, 4)}…${h.slice(-4)}` : `0x${h}`; };

/** "12 ms" under a second, "1.3 s" after. */
export function formatTime(ms: number): string {
  if (ms < 0.5) return "under 1 ms";
  if (ms < 999.5) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** "170 KB" (1,000 bytes to the KB), "2.5 MB" from a million up. */
export function formatSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1000))} KB`;
}

const Tick = ({ size }: { size: number }) => (
  <svg className="ic" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8.4l3.1 3.1L13 4.6" /></svg>
);
const Cross = ({ size }: { size: number }) => (
  <svg className="ic" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
);

/**
 * Lets the browser draw "Checking…" before the check, which holds the page while it runs: waits for the next frame, then one turn of
 * the event loop. A tab that is hidden draws no frames, so the wait for the frame is cut off after a short time.
 */
const paint = () => new Promise<void>((resolve) => {
  const later = () => setTimeout(resolve, 0);
  if (typeof requestAnimationFrame !== "function") return later();
  let done = false;
  const next = () => { if (!done) { done = true; later(); } };
  requestAnimationFrame(next);
  setTimeout(next, 100);
});

function transactions(n: number): string {
  if (n === 0) return "the header is that block's, and it holds no transactions.";
  return `the header and the ${n === 1 ? "1 transaction" : `${n} transactions`} are that block's.`;
}

/**
 * The "Verify this block in your browser" card. It runs the check the confirmers' sidecars run, on the record's proof, header and
 * transactions, and shows pass or fail with the check's own reason and how long it took here.
 */
export function VerifyPanel({ block, blockHash, pins, proving, moduleUrl, moduleSize, load, now = () => performance.now() }: VerifyPanelProps) {
  const [state, setState] = useState<State>({ kind: "idle" });
  // The check is downloaded once per panel. A failed download is dropped so that the next press tries again.
  const loaded = useRef<Promise<LoadedVerifier> | null>(null);
  // Which block the last press was for: an answer that arrives after the page moved to another block is dropped.
  const run = useRef(0);
  const loadModule = load ?? (() => fetchVerifier(moduleUrl));

  useEffect(() => { run.current++; setState({ kind: "idle" }); }, [blockHash, block?.proofHex, block?.headerHex, block?.txsHex]);

  const greyed = proving || block === null;
  const pinLine = (
    <>This explorer's pins: program <span className="mono">{short(pins.programVK)}</span> and ZisK release <span className="mono">{short(pins.rootC)}</span>, from <span className="mono">{pins.file}</span>.</>
  );
  const notChecked = "Not checked here: the Daml legs, the head and gas-cap checks Daml makes, and that Canton committed the block. The proof, header, transactions, pins and the check's code all come from this explorer.";

  if (greyed) {
    return (
      <section className="card verify muted-card">
        <div className="v-h"><h3>Verify this block in your browser</h3><button type="button" className="btn" disabled>Verify</button></div>
        <p className="muted">Verify works on the block record, so it opens once this block is final on Canton.</p>
      </section>
    );
  }

  async function press() {
    if (!block) return;
    const mine = ++run.current;
    setState({ kind: "running" });
    try {
      loaded.current ??= loadModule();
      const { verify } = await loaded.current.catch((e: unknown) => { loaded.current = null; throw e; });
      await paint();
      if (run.current !== mine) return;
      const t0 = now();
      const line = verify(block, { programVK: pins.programVK, rootC: pins.rootC });
      const ms = now() - t0;
      const answer = parseAnswer(line);
      if (run.current !== mine) return;
      if (!answer.ok) setState({ kind: "failed", ms, reason: answer.reason });
      else if (hex(answer.blockHash) !== hex(blockHash)) setState({ kind: "otherBlock", ms, provenHash: answer.blockHash });
      else setState({ kind: "passed", ms, txCount: Number(answer.txCount), blockHash: answer.blockHash });
    } catch (e) {
      if (run.current === mine) setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  const button = (label: string, primary: boolean) => (
    <button type="button" className={primary ? "btn primary" : "btn"} onClick={press}>{label}</button>
  );
  const timing = (s: { ms: number }) => <span className="muted small">Ran in your browser in {formatTime(s.ms)}.</span>;

  if (state.kind === "running") {
    return (
      <section className="card verify" aria-busy="true">
        <div className="v-h"><h3>Verify this block in your browser</h3><button type="button" className="btn" disabled>Checking…</button></div>
        <div className="v-run" role="status"><span className="spinner" aria-hidden="true" />Running the check in your browser…</div>
      </section>
    );
  }

  if (state.kind === "passed") {
    return (
      <section className="card verify v-pass">
        <div className="v-h"><h3>Verify this block in your browser</h3>{button("Run again", false)}</div>
        <div className="v-res ok-res" role="status"><Tick size={16} /><b>Passed.</b>{timing(state)}</div>
        <p>Canton's confirmers ran this check before the commit. It just ran again here, in your browser, on the same proof, header and transactions:</p>
        <ul className="v-list">
          <li><Tick size={13} />the proof verifies under ZisK 1.3.1's key;</li>
          <li><Tick size={13} />program <span className="mono">{short(pins.programVK)}</span> and ZisK release <span className="mono">{short(pins.rootC)}</span> made it (this explorer's pins, from <span className="mono">{pins.file}</span>);</li>
          <li><Tick size={13} />it commits to block hash <span className="mono">{short(state.blockHash)}</span>, which is this block;</li>
          <li><Tick size={13} />{transactions(state.txCount)}</li>
        </ul>
        <p className="small muted">{notChecked}</p>
      </section>
    );
  }

  if (state.kind === "failed") {
    return (
      <section className="card verify v-fail">
        <div className="v-h"><h3>Verify this block in your browser</h3>{button("Run again", false)}</div>
        <div className="v-res bad-res" role="status"><Cross size={16} /><b>Failed: {state.reason}.</b>{timing(state)}</div>
        <p>That is the check's own answer. It stops at the first thing that does not hold. It ran on the proof, header and transactions of this block's record, with this explorer's pins.</p>
        <p className="small muted">{pinLine} {notChecked}</p>
      </section>
    );
  }

  if (state.kind === "otherBlock") {
    // The check itself passed. It is this page's own comparison of the hash it commits to with the block's hash that does not hold.
    return (
      <section className="card verify v-fail">
        <div className="v-h"><h3>Verify this block in your browser</h3>{button("Run again", false)}</div>
        <div className="v-res bad-res" role="status"><Cross size={16} /><b>The check passed, but the proof is for block <span className="mono">{short(state.provenHash)}</span>, not this block (<span className="mono">{short(blockHash)}</span>).</b>{timing(state)}</div>
        <p>The proof, header and transactions hold together, but they belong to another block, so they say nothing about this one.</p>
        <dl className="v-facts">
          <dt>The proof is for</dt><dd className="mono">0x{hex(state.provenHash)}</dd>
          <dt>This block is</dt><dd className="mono">0x{hex(blockHash)}</dd>
        </dl>
        <p className="small muted">{pinLine} {notChecked}</p>
      </section>
    );
  }

  if (state.kind === "error") {
    return (
      <section className="card verify v-fail">
        <div className="v-h"><h3>Verify this block in your browser</h3>{button("Try again", false)}</div>
        <div className="v-res bad-res" role="status"><Cross size={16} /><b>Could not run the check here: {state.message}</b></div>
        <p>The check did not run, so nothing was found about this block's proof either way.</p>
      </section>
    );
  }

  return (
    <section className="card verify">
      <div className="v-h"><h3>Verify this block in your browser</h3>{button("Verify", true)}</div>
      <p>Canton's confirmers checked this block's proof before it committed. Verify runs the same check again, here, on your own machine, on the proof, header and transactions this block's record holds.</p>
      <p className="small muted">{pinLine} The check downloads once{moduleSize !== undefined && <>, about {formatSize(moduleSize)},</>} when you press Verify.</p>
    </section>
  );
}

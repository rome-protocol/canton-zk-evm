import { useEffect, useRef, useState } from "react";
import { getBlockRecord, type ApiStatus } from "../api.ts";
import { Icon } from "../components/Icon.tsx";
import { short } from "../format.ts";
import { fetchVerifier, parseAnswer, type LoadedVerifier } from "../verify/verifier.ts";
import { formatTime } from "../verify/VerifyPanel.tsx";
import { VERIFY_MODULE_URL } from "../verify/module-size.ts";

type State =
  | { kind: "idle" }
  | { kind: "running"; step: "record" | "check" }
  | { kind: "passed"; ms: number }
  | { kind: "failed"; reason: string }
  | { kind: "otherBlock"; provenHash: string }
  | { kind: "error"; message: string };

const hex = (s: string) => s.replace(/^0x/i, "").toLowerCase();

/**
 * "Verify block N in your browser", on a transaction's page. The block's record is read when the button is pressed and not before: the page itself holds none of it: it reads the block's summary, which has no record hex.
 * The check is the one the confirmers run; a pass must commit to this block's own hash.
 */
export function TxVerify({ number, blockHash, pins, final, unindexed = false, proofBytes, load }: {
  number: number; blockHash: string; pins: ApiStatus["pins"]; final: boolean; /** Final on Canton, and the explorer has not read the record yet. */ unindexed?: boolean; proofBytes: number | null; load?: () => Promise<LoadedVerifier>;
}) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const run = useRef(0);
  useEffect(() => { run.current++; setState({ kind: "idle" }); }, [number, blockHash]);

  async function press() {
    const mine = ++run.current;
    setState({ kind: "running", step: "record" });
    try {
      const record = await getBlockRecord(number);
      if (run.current !== mine) return;
      if (record.proof === null) { setState({ kind: "failed", reason: "the block's record holds no proof" }); return; }
      setState({ kind: "running", step: "check" });
      const { verify } = await (load ?? (() => fetchVerifier(VERIFY_MODULE_URL)))();
      if (run.current !== mine) return;
      const t0 = performance.now();
      const answer = parseAnswer(verify({ proofHex: record.proof, headerHex: record.header, txsHex: record.txs }, { programVK: pins.programVK, rootC: pins.rootC }));
      const ms = performance.now() - t0;
      if (run.current !== mine) return;
      if (!answer.ok) setState({ kind: "failed", reason: answer.reason });
      else if (hex(answer.blockHash) !== hex(blockHash)) setState({ kind: "otherBlock", provenHash: answer.blockHash });
      else setState({ kind: "passed", ms });
    } catch (e) {
      if (run.current === mine) setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  const busy = state.kind === "running";
  return (
    <div className="txv">
      <div className="txv-row">
        <button type="button" className="btn primary" disabled={!final || busy} onClick={press}>
          <Icon name="check" size={13} /> {busy ? "Checking…" : state.kind === "idle" ? `Verify block ${number} in your browser` : "Run again"}
        </button>
        <span className="muted small">{!final ? (unindexed ? "opens once the explorer has read the record" : "opens once the block is final on Canton") : proofBytes !== null ? `${proofBytes.toLocaleString("en-US")}-byte proof` : ""}</span>
      </div>
      {state.kind === "running" && <p className="small muted" role="status">{state.step === "record" ? "Reading the block's record…" : "Running the check in your browser…"}</p>}
      {state.kind === "passed" && <p className="small fact-ok" role="status"><Icon name="check" size={13} />Passed. The proof, header and transactions of block {number} check out, and the proof commits to this block's hash. Ran in your browser in {formatTime(state.ms)}.</p>}
      {state.kind === "failed" && <p className="small fact-bad" role="status"><Icon name="cross" size={13} />Failed: {state.reason}.</p>}
      {state.kind === "otherBlock" && <p className="small fact-bad" role="status"><Icon name="cross" size={13} />The check passed, but the proof is for block <span className="mono">{short(state.provenHash)}</span>, not for this block.</p>}
      {state.kind === "error" && <p className="small fact-bad" role="status"><Icon name="cross" size={13} />Could not run the check here: {state.message}</p>}
    </div>
  );
}

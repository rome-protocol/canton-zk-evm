import type { ReactNode } from "react";
import type { ApiStatus, CantonSummary, Fact } from "../api.ts";
import { HashLink } from "../components/HashLink.tsx";
import { Icon } from "../components/Icon.tsx";
import { count, short } from "../format.ts";
import { Bad, Good } from "./BlockSides.tsx";
import "./block.css";

const PROOF_LENGTH = "This proof is not 1,344 bytes, so its facts cannot be read.";
/** A wrapped proof is four fields one after the other: the proof (768 bytes), the program key (32), the release root (32) and the public values (512). */
const PARTS = "proof 768, program key 32, release 32, public values 512";

/** One fact read from the proof, with the value that was read and whether it matches. The value is always shown. */
function FactRows({ label, fact, match, mismatch }: { label: string; fact: Fact; match: string; mismatch: ReactNode }) {
  return (
    <>
      <dt className="f-k">{label}</dt>
      <dd className="f-v">{fact.value === null ? <span className="muted">none in its public values</span> : <HashLink value={fact.value} />}</dd>
      <dd className="f-s">{fact.ok ? <Good>{match}</Good> : <Bad>{mismatch}</Bad>}</dd>
    </>
  );
}

function ProofFacts({ c, pins }: { c: CantonSummary; pins: ApiStatus["pins"] | undefined }) {
  if (!c.proof) return <div className="alert bad-alert flat facts-gap"><Icon name="cross" size={15} /><div>{PROOF_LENGTH}</div></div>;
  const { programVK, rootC, blockHash } = c.proof;
  const pin = (v: string | undefined) => <>does not match this explorer's pin{v && <> <span className="mono">{short(v)}</span></>}</>;
  const red = !(programVK.ok && rootC.ok && blockHash.ok);
  return (
    <>
      <dl className={`facts${red ? " facts-bad" : ""}`} role="group" aria-label="Facts read from the proof">
        <FactRows label="Program key" fact={programVK} match="ours" mismatch={pin(pins?.programVK)} />
        <FactRows label="ZisK release" fact={rootC} match="ZisK 1.3.1" mismatch={pin(pins?.rootC)} />
        <FactRows label="Block hash committed" fact={blockHash} match="this block" mismatch="not this block's hash" />
        <dt className="f-k">Proof</dt>
        <dd className="f-v wide2"><span className="mono">{count(c.proofBytes)} bytes</span>{c.proofBytes === 1344 && <span className="muted"> · {PARTS}</span>}</dd>
      </dl>
      {red && <div className="facts-note small muted">The status word stays Final: Canton's confirmers checked the proof against their own pins when the block committed. A red fact means the proof differs from the pins this explorer was given.</div>}
    </>
  );
}

/** "The proof": what the proof's own bytes say, next to this explorer's pins, with the in-browser check under it. */
export function ProofCard({ c, pins, children }: { c: CantonSummary; pins: ApiStatus["pins"] | undefined; children: ReactNode }) {
  return (
    <section className="card side canton proof" aria-labelledby="proof-h">
      <div className="side-h"><span className="side-l" id="proof-h">The proof</span><span className="muted small">read from the proof's own bytes, compared with this explorer's pins{pins?.file && <>, from <span className="mono">{pins.file}</span></>}</span></div>
      <ProofFacts c={c} pins={pins} />
      <div className="proof-verify">{children}</div>
    </section>
  );
}

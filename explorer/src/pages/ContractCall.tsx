import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { typeOf, type AbiEntry, type AbiParam } from "../abi.ts";
import type { Shown } from "../abi-call.ts";
import { ErrorCard, LoadingCard } from "../components/Cards.tsx";
import { useAbi } from "./useAbi.ts";

export type Abis = ReturnType<typeof useAbi>;

/** The ABI the Read and Write tabs list: a proxy's is the implementation's, with the contract's own one click away when both are known. */
export function useChoice(abis: Abis) {
  const [pick, setPick] = useState<"implementation" | "own">("implementation");
  const both = abis.implementation !== null && abis.own !== null;
  const use = abis.implementation !== null && (pick === "implementation" || abis.own === null) ? "implementation" : "own";
  const entries = use === "implementation" ? abis.implementation : abis.own;
  const note: ReactNode = abis.implementationAddress && abis.implementation
    ? <>Read and Write as proxy: {use === "implementation" ? "the functions are the implementation's" : "the functions are the proxy's own"}, called at this address. Implementation <Link className="mono" to={`/contract/${abis.implementationAddress}`}>{abis.implementationAddress.slice(0, 8)}…{abis.implementationAddress.slice(-4)}</Link>.</>
    : null;
  const switcher = both
    ? <div className="seg" role="group" aria-label="Functions from">{(["implementation", "own"] as const).map((o) => <button key={o} type="button" aria-pressed={o === use} onClick={() => setPick(o)}>{o === "own" ? "Proxy's own ABI" : "As proxy"}</button>)}</div>
    : null;
  return { entries, note, switcher };
}

/** What stands in for the functions while the ABI is read, when there is none to read, or when it could not be read. */
export function Gate({ abis, entries, what, children }: { abis: Abis; entries: AbiEntry[] | null; what: string; children: ReactNode }) {
  if (abis.error && !abis.ready) return <ErrorCard message={abis.error.message} retrying />;
  if (!abis.ready) return <LoadingCard>Reading the interface…</LoadingCard>;
  if (!entries) return <section className="card" aria-label={what}><h2>{what}</h2><p className="muted">The source of this contract is not verified, so its functions are not known. Verify it on the Code tab to read and write it here.</p></section>;
  return <>{children}</>;
}

export const label = (p: AbiParam, i: number) => `${p.name || `arg${i}`} (${typeOf(p)})`;
export const headline = (e: AbiEntry) => `${e.name} (${(e.inputs ?? []).map((p, i) => label(p, i)).join(", ")})`;

/** The typed fields of a function's inputs. */
export function Fields({ e, values, onChange }: { e: AbiEntry; values: string[]; onChange: (i: number, v: string) => void }) {
  return (
    <>
      {(e.inputs ?? []).map((p, i) => {
        const id = `f-${e.name}-${i}`;
        return (
          <div className="field" key={i}>
            <label htmlFor={id} className="muted small">{label(p, i)}</label>
            <input id={id} className="inp mono" type="text" spellCheck={false} autoComplete="off" value={values[i] ?? ""} onChange={(ev) => onChange(i, ev.target.value)} />
          </div>
        );
      })}
    </>
  );
}

/** A value an ABI function gave, as text; an address links to its page. */
export function Out({ v }: { v: Shown }) {
  return (
    <div className="out">
      <span className="mono wrap">{v.type === "address" && /^0x[0-9a-f]{40}$/.test(v.value) ? <Link to={`/address/${v.value}`}>{v.value}</Link> : v.value}</span>
      {v.name && <span className="muted small"> {v.name}</span>} <span className="muted mono small">{v.type}</span>
    </div>
  );
}

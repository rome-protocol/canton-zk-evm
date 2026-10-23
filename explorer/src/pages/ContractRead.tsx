import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { callable, decodeOutputs, encodeCall, type AbiEntry } from "../abi-call.ts";
import type { ContractDetail } from "../api.ts";
import { ErrorCard } from "../components/Cards.tsx";
import { Icon } from "../components/Icon.tsx";
import { ethCall, finalBlock } from "../rpc.ts";
import { Fields, Gate, headline, Out, useChoice, type Abis } from "./ContractCall.tsx";
import { useAbi } from "./useAbi.ts";

/** The final block of one reading of the tab, asked once and shared by every call on it. */
interface Head { block: number | undefined; error: string | null; tick: number }

/** What a view function answered, or why it did not: the call is data from the ABI and the fields, made through /rpc at the final block. */
function Answer({ address, e, fields, head }: { address: string; e: AbiEntry; fields: string[]; head: Head }) {
  const q = useQuery({
    queryKey: ["read", address, e.name, JSON.stringify(e.inputs), fields, head.block, head.tick],
    queryFn: async () => { const r = await ethCall(address, encodeCall(e, fields), head.block!); return { out: decodeOutputs(e, r.result), block: r.block }; },
    enabled: head.block !== undefined, retry: false, staleTime: Infinity,
  });
  if (head.error) return <p className="muted small">Not read: the final block is not known.</p>;
  if (q.isLoading || head.block === undefined) return <p className="muted small" aria-busy="true">Reading…</p>;
  if (q.error) return <p className="fact-bad small" role="alert">{q.error.message}</p>;
  const { out, block } = q.data!;
  return (
    <div className="answer">
      {out.length === 0 ? <span className="muted small">It returns nothing.</span> : out.map((o, i) => <Out key={i} v={o} />)}
      <span className="muted small">answered at block {block}</span>
    </div>
  );
}

function ReadItem({ n, address, e, head, open }: { n: number; address: string; e: AbiEntry; head: Head; open: boolean | null }) {
  const inputs = e.inputs ?? [];
  const [toggled, setToggled] = useState(false);
  const [values, setValues] = useState<string[]>([]);
  const [ran, setRan] = useState<{ fields: string[]; n: number } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const returns = (e.outputs ?? []).map((o) => o.type).join(", ");
  // Expand all and Collapse all set every function; a function's own header then flips it from there, until the next press.
  useEffect(() => setToggled(false), [open]);
  const shut = inputs.length > 0 && ((open === null ? true : !open) !== toggled);
  const query = () => {
    try { encodeCall(e, values); } catch (x) { return setProblem((x as Error).message); }
    setProblem(null);
    setRan((r) => ({ fields: [...values], n: (r?.n ?? 0) + 1 }));
  };
  return (
    <section className="fn" aria-label={e.name}>
      <button type="button" className="fn-h" aria-expanded={!shut} disabled={inputs.length === 0} onClick={() => setToggled((t) => !t)}>
        <span className="muted">{n}.</span> <span className="mono fn-name">{headline(e)}</span>
        <span className="muted small">{inputs.length ? `returns ${returns || "nothing"}` : returns}</span>
        {inputs.length > 0 && <Icon name="down" size={14} />}
      </button>
      {inputs.length === 0 ? <div className="fn-b"><Answer address={address} e={e} fields={[]} head={head} /></div>
        : !shut && (
          <div className="fn-b">
            <Fields e={e} values={values} onChange={(i, v) => setValues((a) => { const b = [...a]; b[i] = v; return b; })} />
            <div className="fn-q"><button type="button" className="btn" onClick={query}>Query</button></div>
            {problem && <p className="fact-bad small" role="alert">{problem}</p>}
            {ran && <Answer key={ran.n} address={address} e={e} fields={ran.fields} head={head} />}
          </div>
        )}
    </section>
  );
}

/** Read: the view and pure functions of the contract, called through the explorer's RPC at the final block. Nothing is signed and nothing is sent. */
export function ReadTab({ detail }: { detail: ContractDetail }) {
  const abis: Abis = useAbi(detail);
  const { entries, note, switcher } = useChoice(abis);
  const [tick, setTick] = useState(0);
  const [open, setOpen] = useState<boolean | null>(null);
  const head = useQuery({ queryKey: ["rpc-final-block", detail.address, tick], queryFn: finalBlock, retry: false, staleTime: Infinity, gcTime: 0 });
  const shared: Head = { block: head.data, error: head.error ? head.error.message : null, tick };
  const fns = entries ? callable(entries, "read") : [];
  return (
    <Gate abis={abis} entries={entries} what="Read contract">
      <section className="card" aria-label="Read contract">
        <div className="list-h">
          <h2>Read contract <span className="muted thin">Calls go through <span className="mono">eth_call</span> on this explorer's RPC at the final head{head.data !== undefined ? `, block ${head.data}` : ""}. Nothing is signed and nothing is sent.</span></h2>
          <span className="row-gap">
            {switcher}
            <button type="button" className="btn" onClick={() => setTick((t) => t + 1)}>Read again</button>
            <button type="button" className="btn" onClick={() => setOpen((o) => !(o ?? false))}>{open ? "Collapse all" : "Expand all"}</button>
          </span>
        </div>
        {note && <p className="small muted card-note">{note}</p>}
        {head.error && <ErrorCard message={head.error.message} retrying />}
        {fns.length === 0 ? <p className="muted">This contract has no functions that only read.</p>
          : <div className="fn-cols">{fns.map((e, i) => <ReadItem key={`${e.name}-${i}`} n={i + 1} address={detail.address} e={e} head={shared} open={open} />)}</div>}
      </section>
    </Gate>
  );
}

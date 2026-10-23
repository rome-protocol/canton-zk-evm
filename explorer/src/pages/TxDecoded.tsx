import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { decodeInputOf, type Decoded } from "../abi-call.ts";
import { abiOrStandard } from "../abi.ts";
import { getContract, type ContractDetail, type Label } from "../api.ts";
import { AddressCell } from "../components/AddressCell.tsx";
import { Item, Kv } from "../components/Kv.tsx";
import { Seg } from "../components/Seg.tsx";
import { short } from "../format.ts";
import { labelName, useLabels, type Labels } from "../labels.ts";
import { amountLines, listOf } from "./txValues.ts";
import { useAbi } from "./useAbi.ts";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function MethodId({ id, note, held = false }: { id: string; note: boolean; held?: boolean }) {
  return <Item label="Method id"><span className="mono">{id}</span>{note && <> <span className="muted">{held ? "The input is not one of the functions of the verified interface, so it is not decoded." : "The verified interface is not held, so the input is not decoded."}</span></>}</Item>;
}

type View = "decoded" | "raw";
const VIEWS = [{ id: "decoded" as const, text: "Decoded" }, { id: "raw" as const, text: "Raw" }];

/** The card's head and body (the card itself is InputData's, so it stays one element while the answers come): its title, what it was read with, and the switch between the decoded and the raw input. */
function Card({ note, toggle, children }: { note?: string; toggle?: ReactNode; children: ReactNode }) {
  return (
    <>
      <div className="sec-h"><h2 className="tx-h">Input data</h2>{note && <span className="muted small">{note}</span>}{toggle && <span className="sec-r">{toggle}</span>}</div>
      {children}
    </>
  );
}

/** One argument's value. An address is its name (or its short address) and a link; a list of addresses one full address a line; an amount of the token its raw digits and, beside them, whole units. */
function Value({ a, token, labels }: { a: Decoded["args"][number]; token: Label | undefined; labels: Labels }) {
  if (a.type === "address" && ADDRESS.test(a.value)) {
    const label = labels.get(a.value);
    return labelName(label) ? <><AddressCell address={a.value} label={label} /> <span className="mono muted">{short(a.value, 8, 4)}</span></> : <Link className="mono" to={`/address/${a.value}`}>{short(a.value, 8, 4)}</Link>;
  }
  if (a.type === "address[]") {
    const list = listOf(a.value);
    if (list && list.every((x) => ADDRESS.test(x))) return <>{list.map((x, i) => <div key={i}><Link className="mono wrap" to={`/address/${x}`}>{x}</Link></div>)}</>;
  }
  const units = amountLines(a, token);
  if (units) {
    const raws = a.type === "uint256" ? [a.value] : listOf(a.value)!;
    return <>{raws.map((r, i) => <div key={i}><span className="mono wrap">{r}</span> <span className="muted">= {units[i]}</span></div>)}</>;
  }
  return <span className="mono wrap">{a.value}</span>;
}

/** The addresses an input names that are shown by name: its arguments that are one address. The elements of a list are shown as they are, so none is asked for. */
const addressesOf = (d: Decoded | null) => (d ? d.args.flatMap((a) => (a.type === "address" ? [a.value] : [])) : []);

/** The decoded call as the screen has it: the function, then a table of its arguments by place, name, type and value. */
function DecodedCall({ d, id, to, labels }: { d: Decoded; id: string; to: string; labels: Labels }) {
  const named = d.args.find((a) => a.type === "address" && /token/i.test(a.name));
  const token = labels.get(named?.value) ?? labels.get(to);
  return (
    <>
      <div className="fn-box">
        Function: <b className="mono fn-name" title={d.signature}>{d.name}</b><span className="mono">({d.args.map((a) => (a.name ? `${a.type} ${a.name}` : a.type)).join(", ")})</span>
        <span className="muted"> · MethodID <span className="mono">{id}</span></span>
      </div>
      {d.args.length > 0 && (
        <div className="tx-scroll">
          <table className="tx-table args-table">
            <thead><tr><th>#</th><th>Name</th><th>Type</th><th>Data</th></tr></thead>
            <tbody>{d.args.map((a, i) => <tr key={i}><td className="mono muted">{i}</td><td>{a.name || `arg${i}`}</td><td className="mono muted">{a.type}</td><td><Value a={a} token={token} labels={labels} /></td></tr>)}</tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** The contract is known: the call is read with its verified ABI, or with the standard one when it has none. */
function Call({ detail, input, id, raw }: { detail: ContractDetail; input: string; id: string; raw: ReactNode }) {
  const abi = useAbi(detail);
  const [view, setView] = useState<View>("decoded");
  const d = decodeInputOf(abiOrStandard(abi.all), input);
  const labels = useLabels([detail.address, ...addressesOf(d)]);
  // While the verified source is being read the card says nothing of what read the call: the standard interface is not the answer yet.
  if (!abi.ready) return <Card><Kv wide><Item label="Input data">{raw}</Item><MethodId id={id} note={false} /></Kv></Card>;
  const rawView = <Kv wide><Item label="Input data">{raw}</Item><MethodId id={id} note={d === null && abi.ready} held={abi.all.length > 0} /></Kv>;
  if (!d) return <Card>{rawView}</Card>;
  const by = abi.all.length > 0 ? `the verified ABI of ${labelName(labels.get(detail.address)) ?? detail.verification?.contractName ?? short(detail.address, 8, 4)}` : "the standard token interface";
  return (
    <Card note={`decoded with ${by}`} toggle={<Seg label="Input data view" value={view} options={VIEWS} onPick={setView} />}>
      {view === "decoded" ? <DecodedCall d={d} id={id} to={detail.address} labels={labels} /> : rawView}
    </Card>
  );
}

/**
 * The input's method id and its call, read with the verified ABI of the contract called (a proxy's with its implementation's), or with the
 * standard token ABI when the contract has none. Decoded and Raw are a switch. When the contract is not a contract, or the call is in no ABI
 * held, the input stays raw and the row says so. `raw` is the input as sent.
 */
export function InputData({ to, input, raw }: { to: string | null; input: string; raw: ReactNode }) {
  const id = input.slice(0, 10);
  const c = useQuery({ queryKey: ["tx-input-contract", to], queryFn: () => getContract(to!), enabled: to !== null });
  const plain = (note: boolean) => <Card><Kv wide><Item label="Input data">{raw}</Item>{input.length >= 10 && <MethodId id={id} note={note} />}</Kv></Card>;
  const body = to === null || c.isLoading || !c.data || input.length < 10 ? plain(to === null ? true : !c.isLoading) : <Call detail={c.data} input={input} id={id} raw={raw} />;
  return <section className="card" aria-label="Input data">{body}</section>;
}

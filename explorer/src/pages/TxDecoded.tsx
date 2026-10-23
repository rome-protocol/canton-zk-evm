import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { decodeInputOf } from "../abi-call.ts";
import { getContract, type ContractDetail } from "../api.ts";
import { Item } from "../components/Kv.tsx";
import { useAbi } from "./useAbi.ts";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function MethodId({ id, note }: { id: string; note: boolean }) {
  return <Item label="Method id"><span className="mono">{id}</span>{note && <> <span className="muted">The verified interface is not held, so the input is not decoded.</span></>}</Item>;
}

/** The call by name, each argument beside its name, an address as a link. Every value is text. */
function Call({ detail, input, id }: { detail: ContractDetail; input: string; id: string }) {
  const abi = useAbi(detail);
  const d = decodeInputOf(abi.all, input);
  if (!d) return <MethodId id={id} note={abi.ready} />;
  return (
    <>
      <Item label="Decoded">
        <span className="mono" title={d.signature}>{d.name}</span>
        <div className="small">
          {d.args.map((a, i) => (
            <div key={i}><span className="muted">{a.name || `arg${i}`} ({a.type})</span>{" "}
              {a.type === "address" && ADDRESS.test(a.value) ? <Link className="mono" to={`/address/${a.value}`}>{a.value.slice(0, 8)}…{a.value.slice(-4)}</Link> : <span className="mono wrap">{a.value}</span>}</div>
          ))}
        </div>
      </Item>
      <MethodId id={id} note={false} />
    </>
  );
}

/**
 * The input's method id, and its call read with the verified ABI of the contract called (a proxy's with its implementation's). When the
 * contract is not verified, is not a contract, or the call is not in its ABI, the input stays raw and the row says so.
 */
export function MethodRows({ to, input }: { to: string | null; input: string }) {
  const id = input.slice(0, 10);
  const c = useQuery({ queryKey: ["tx-input-contract", to], queryFn: () => getContract(to!), enabled: to !== null });
  if (to === null || c.isLoading) return <MethodId id={id} note={to === null} />;
  return c.data ? <Call detail={c.data} input={input} id={id} /> : <MethodId id={id} note />;
}

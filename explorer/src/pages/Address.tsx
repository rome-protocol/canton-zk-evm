import { Link, useParams } from "react-router-dom";
import { getAddress, type ApiAddress } from "../api.ts";
import { Amount } from "../components/Amount.tsx";
import { unready } from "../components/Cards.tsx";
import { HashLink } from "../components/HashLink.tsx";
import { Item, Kv } from "../components/Kv.tsx";
import { useFollowing, useStatus } from "../useStatus.ts";

const KIND = { account: "Account", contract: "Contract", token: "Token" } as const;

/** The title: a token is named by its own name and symbol; an account and a contract are an address, and the chip says which. */
function Title({ a }: { a: ApiAddress }) {
  const named = a.token ? <>{a.token.name} <span className="muted thin">({a.token.symbol})</span></> : "Address";
  return <div className="ptitle"><h1>{named}</h1><span className="chip chip-kind">{KIND[a.kind]}</span></div>;
}

/**
 * What reth says about an address in its newest block, which may still be being proven. An account shows how many transactions it has
 * sent. A contract or a token does not: the count means little there.
 */
export function Address() {
  const { addr = "" } = useParams();
  const coin = useStatus().data?.coin;
  // an address is read once it has been read; a failed read is asked again
  const q = useFollowing(["address", addr], () => getAddress(addr), () => true);
  const wait = unready(q, "Reading the address…");
  if (wait) return wait;
  const a = q.data!;
  return (
    <>
      <Title a={a} />
      <div className="bighash"><HashLink value={a.address} full /></div>
      <section className="card" aria-label="Address">
        <Kv wide>
          {a.token && <><Item label="Name">{a.token.name}</Item><Item label="Symbol">{a.token.symbol}</Item><Item label="Decimals"><span className="mono">{a.token.decimals}</span></Item></>}
          {a.createdBy && (
            <Item label="Created by"><HashLink value={a.createdBy.txHash} to={`/tx/${a.createdBy.txHash}`} /> in <Link className="num" to={`/block/${a.createdBy.block}`}>block {a.createdBy.block}</Link></Item>
          )}
          <Item label="Balance">{coin ? <Amount raw={a.balance} decimals={coin.decimals} symbol={coin.symbol} /> : <span className="muted">…</span>}</Item>
          {a.kind === "account" && <Item label="Transactions sent"><span className="mono">{a.nonce}</span></Item>}
        </Kv>
        <p className="small muted card-note">{a.kind === "account" ? "Both come" : "The balance comes"} from reth's newest block, which may still be being proven.</p>
      </section>
    </>
  );
}

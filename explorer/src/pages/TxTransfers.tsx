import { useQuery } from "@tanstack/react-query";
import { getAddress, getTxTransfers, type TokenTransfer } from "../api.ts";
import { Amount } from "../components/Amount.tsx";
import { HashLink } from "../components/HashLink.tsx";
import { Pager, usePaged } from "../components/Pager.tsx";

/** One transfer. The token's symbol and decimals come from its own address; until they can be read the raw amount is shown, as it is. */
function Row({ x }: { x: TokenTransfer }) {
  const q = useQuery({ queryKey: ["address", x.token], queryFn: () => getAddress(x.token), retry: false, staleTime: 60_000 });
  const tok = q.data?.token ?? null;
  return (
    <tr>
      <td><HashLink value={x.from} to={`/address/${x.from}`} /></td>
      <td><HashLink value={x.to} to={`/address/${x.to}`} /></td>
      <td className="r">{tok ? <Amount raw={x.amount} decimals={tok.decimals} symbol={tok.symbol} /> : <span className="mono" title="The token's decimals cannot be read, so this is the raw amount">{x.amount}</span>}</td>
      <td>
        <HashLink value={x.token} to={`/token/${x.token}`} />
        {tok ? <span className="tag">{tok.symbol}</span> : null}
        {x.tokenId !== null && <span className="muted"> id {x.tokenId}</span>}
      </td>
    </tr>
  );
}

/** The token transfers of a final transaction, read from the logs the explorer has derived. */
export function TransfersCard({ hash }: { hash: string }) {
  const p = usePaged(["tx-transfers", hash], (after) => getTxTransfers(hash, after));
  if (p.error && !p.data) return <section className="card" aria-label="Token transfers"><div className="alert" role="alert">{p.error.message}</div></section>;
  if (!p.data) return <section className="card" aria-label="Token transfers" aria-busy="true"><p className="muted">Reading the token transfers…</p></section>;
  const items = p.data.items;
  const gap = p.data.derived === false;
  return (
    <section className="card" aria-label="Token transfers">
      <h2 className="side-l tx-h">Token transfers</h2>
      {gap ? <p className="muted">not derived yet</p> : items.length === 0 ? <p className="muted">This transaction moved no tokens.</p> : (
        <div className="tx-scroll">
          <table className="tx-table">
            <thead><tr><th>From</th><th>To</th><th className="r">Amount</th><th>Token</th></tr></thead>
            <tbody>{items.map((x) => <Row key={`${x.logIndex}-${x.batchIndex}`} x={x} />)}</tbody>
          </table>
        </div>
      )}
      {!gap && <Pager p={p} label="Pages of token transfers" />}
    </section>
  );
}

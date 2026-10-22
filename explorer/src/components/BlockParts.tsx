import { Link } from "react-router-dom";
import { getBlockLegs, getBlockTxs, type TxListItem } from "../api.ts";
import { units } from "../format.ts";
import { HashLink } from "./HashLink.tsx";
import { Icon } from "./Icon.tsx";
import { Pager, usePaged } from "./Pager.tsx";

const PER_PAGE = 10;

const fee = (t: TxListItem) => (BigInt(t.gasUsed) * BigInt(t.gasPrice)).toString();

function Result({ success }: { success: boolean }) {
  return success ? <span className="fact-ok"><Icon name="check" size={13} />Success</span> : <span className="fact-bad"><Icon name="cross" size={13} />Failed (reverted)</span>;
}

/** The transactions of a final block, in order, read a page at a time from the block's own route. */
export function PagedTransactions({ id, total, coin }: { id: string; total: number; coin: { symbol: string; decimals: number } }) {
  const p = usePaged(["blocks", "txs", id], (c) => getBlockTxs(id, c, PER_PAGE));
  const rows = p.data?.items;
  const from = (p.page - 1) * PER_PAGE;
  return (
    <section className="card" aria-labelledby="txs-h">
      <div className="list-h">
        <div className="sec-h"><h3 id="txs-h">Transactions</h3><span className="muted small">{total} in this block, in order</span></div>
        <Pager p={p} label="Pages of transactions" />
      </div>
      {p.error && !rows ? <p className="muted">{p.error.message}</p> : !rows ? <p className="muted">Reading the transactions…</p> : rows.length ? (
        <>
          <div className="scroll">
            <table className="tbl txs">
              <thead><tr><th>Hash</th><th className="r">#</th><th>From</th><th>To</th><th className="r">Value</th><th className="r">Fee</th><th>Result</th></tr></thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.hash}>
                    <td className="c-hash"><HashLink value={t.hash} to={`/tx/${t.hash}`} /></td>
                    <td className="r">{t.index}</td>
                    <td><HashLink value={t.from} to={`/address/${t.from}`} /></td>
                    <td>{t.to ? <HashLink value={t.to} to={`/address/${t.to}`} /> : t.created ? <span className="muted">creates <Link className="mono" to={`/address/${t.created}`}>contract</Link></span> : <span className="muted">—</span>}</td>
                    <td className="r">{units(t.value, coin.decimals)} {coin.symbol}</td>
                    <td className="r mono">{units(fee(t), coin.decimals)} {coin.symbol}</td>
                    <td><Result success={t.success} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">Showing {from + 1}–{from + rows.length} of {total}.</p>
        </>
      ) : <p className="muted">No transactions in this block.</p>}
    </section>
  );
}

/** The gateway legs a block recorded, from the block's legs route. A block with none shows nothing, and so does a route that cannot answer. */
export function BlockLegs({ id }: { id: string }) {
  const p = usePaged(["blocks", "legs", id], (c) => getBlockLegs(id, c, PER_PAGE));
  const rows = p.data?.items;
  if (!rows?.length) return null;
  return (
    <section className="card" aria-labelledby="legs-h">
      <div className="list-h">
        <div className="sec-h"><h3 id="legs-h">Gateway legs</h3><span className="muted small">recorded by this block, in order</span></div>
        <Pager p={p} label="Pages of legs" />
      </div>
      <div className="scroll">
        <table className="tbl legs-tbl">
          <thead><tr><th className="r">#</th><th>Kind</th><th>Token</th><th>Account</th><th className="r">Amount</th><th className="r">Transaction</th></tr></thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.legIndex}>
                <td className="r">{l.legIndex}</td>
                <td><span className="tag">{l.kind}</span></td>
                <td><HashLink value={l.token} to={`/token/${l.token}`} /></td>
                <td><HashLink value={l.account} to={`/address/${l.account}`} /></td>
                <td className="r mono">{l.amount}</td>
                <td className="r">{l.txIndex}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

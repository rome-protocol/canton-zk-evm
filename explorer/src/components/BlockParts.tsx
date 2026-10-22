import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getBlockLegs, getBlockTxs, getFaucetAddress, type TxListItem } from "../api.ts";
import { count, units } from "../format.ts";
import { methodOf } from "../method.ts";
import { HashLink } from "./HashLink.tsx";
import { Icon } from "./Icon.tsx";
import { Pager, usePaged } from "./Pager.tsx";
import { NumberedPager, useNumbered } from "./Numbered.tsx";

const PER_PAGE = 10;

const fee = (t: TxListItem) => (BigInt(t.gasUsed) * BigInt(t.gasPrice)).toString();

function Result({ success }: { success: boolean }) {
  return success ? <span className="fact-ok"><Icon name="check" size={13} />Success</span> : <span className="fact-bad"><Icon name="cross" size={13} />Failed (reverted)</span>;
}

/** The sender's name when it is the chain's faucet, which is the one address the explorer knows by name. */
function Sender({ address, faucet, chain }: { address: string; faucet: string | null | undefined; chain: string }) {
  const named = faucet !== null && faucet !== undefined && faucet.toLowerCase() === address.toLowerCase();
  return named ? <Link to={`/address/${address}`} title={address}>{chain} faucet</Link> : <HashLink value={address} to={`/address/${address}`} />;
}

/** The transactions of a final block, in order, read a page at a time from the block's own route. The block's count is known, so any page can be opened. */
export function PagedTransactions({ id, total, coin, chain }: { id: string; total: number; coin: { symbol: string; decimals: number }; chain: string }) {
  const p = useNumbered(["blocks", "txs", id], total, PER_PAGE, (c) => getBlockTxs(id, c, PER_PAGE));
  const faucet = useQuery({ queryKey: ["faucet-address"], queryFn: getFaucetAddress, staleTime: 60_000, retry: false });
  const rows = p.data?.items;
  return (
    <section className="card" aria-labelledby="txs-h" id="transactions">
      <div className="list-h">
        <div className="sec-h"><h3 id="txs-h">Transactions</h3><span className="muted small">{count(total)} in this block, in order</span></div>
        <NumberedPager p={p} label="Pages of transactions" />
      </div>
      {p.error && !rows ? <p className="muted">{p.error.message}</p> : !rows ? <p className="muted">Reading the transactions…</p> : rows.length ? (
        <>
          <div className="scroll">
            <table className="tbl txs">
              <thead><tr><th>Hash</th><th className="r">#</th><th>Method</th><th>From</th><th aria-hidden="true" /><th>To</th><th className="r">Value</th><th className="r">Fee</th><th>Result</th></tr></thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.hash}>
                    <td className="c-hash"><HashLink value={t.hash} to={`/tx/${t.hash}`} /></td>
                    <td className="r">{t.index}</td>
                    <td><span className="tag method">{methodOf(t)}</span></td>
                    <td><Sender address={t.from} faucet={faucet.data} chain={chain} /></td>
                    <td className="arrow muted" aria-hidden="true">→</td>
                    <td>{t.to ? <HashLink value={t.to} to={`/address/${t.to}`} /> : t.created ? <span className="muted">creates <Link className="mono" to={`/address/${t.created}`}>contract</Link></span> : <span className="muted">—</span>}</td>
                    <td className="r">{units(t.value, coin.decimals)} {coin.symbol}</td>
                    <td className="r mono">{units(fee(t), coin.decimals)} {coin.symbol}</td>
                    <td><Result success={t.success} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">Showing {p.from + 1}–{p.from + rows.length} of {count(total)}</p>
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

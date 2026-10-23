import { getTxTransfers, type Label, type TokenTransfer } from "../api.ts";
import { AddressCell } from "../components/AddressCell.tsx";
import { TokenChip } from "../components/Amount.tsx";
import { Pager, usePaged } from "../components/Pager.tsx";
import { exact, plural, units } from "../format.ts";
import { useLabels, type Labels } from "../labels.ts";

/**
 * The amount of one transfer. A fungible token's is in whole units, as the screen shows it, with the exact amount and the symbol in its tooltip. Where the token's decimals
 * are not known the raw amount is shown and says so. A token id, with or without a count, is a chip.
 */
function AmountCell({ x, label }: { x: TokenTransfer; label: Label | undefined }) {
  if (x.tokenId !== null || x.amount === null) {
    return <TokenChip move={{ token: x.token, amount: x.amount, tokenId: x.tokenId, standard: label?.standard ?? null, decimals: null }} label={label} />;
  }
  const decimals = label?.decimals ?? null;
  if (decimals === null) return <span className="mono" title="The token's decimals cannot be read, so this is the raw amount">{x.amount}</span>;
  return <b className="num" title={`${exact(x.amount, decimals)}${label?.symbol ? ` ${label.symbol}` : ""}`}>{units(x.amount, decimals)}</b>;
}

function Row({ x, labels }: { x: TokenTransfer; labels: Labels }) {
  return (
    <tr>
      <td><AddressCell address={x.from} label={labels.get(x.from)} /></td>
      <td className="arrow" aria-hidden="true">→</td>
      <td><AddressCell address={x.to} label={labels.get(x.to)} /></td>
      <td className="r"><AmountCell x={x} label={labels.get(x.token)} /></td>
      <td><AddressCell address={x.token} label={labels.get(x.token)} to={`/token/${x.token}`} /></td>
    </tr>
  );
}

/** "4 ERC-20 transfers": only fungible rows are called ERC-20; a page with a token id in it says "token transfers". */
const countWords = (items: TokenTransfer[]) => (items.every((x) => x.tokenId === null) ? plural(items.length, "ERC-20 transfer") : plural(items.length, "token transfer"));

/** The token transfers of a final transaction, read from the logs the explorer has derived. The names of the page's addresses are read together, in one request. */
export function TransfersCard({ hash }: { hash: string }) {
  const p = usePaged(["tx-transfers", hash], (after) => getTxTransfers(hash, after));
  const items = p.data?.items ?? [];
  const labels = useLabels(items.flatMap((x) => [x.from, x.to, x.token]));
  if (p.error && !p.data) return <section className="card" aria-label="Token transfers"><div className="alert" role="alert">{p.error.message}</div></section>;
  if (!p.data) return <section className="card" aria-label="Token transfers" aria-busy="true"><p className="muted">Reading the token transfers…</p></section>;
  const gap = p.data.derived === false;
  const more = p.hasNext || p.hasPrev;
  return (
    <section className="card" aria-label="Token transfers">
      <div className="sec-h"><h2 className="tx-h">Token transfers</h2>{!gap && items.length > 0 && <span className="muted small">{more ? `${countWords(items)} on this page` : countWords(items)}, read from the logs</span>}</div>
      {gap ? <p className="muted">not derived yet</p> : items.length === 0 ? <p className="muted">This transaction moved no tokens.</p> : (
        <div className="tx-scroll">
          <table className="tx-table xfer-table">
            <thead><tr><th>From</th><th aria-hidden="true" /><th>To</th><th className="r">Amount</th><th>Token</th></tr></thead>
            <tbody>{items.map((x) => <Row key={`${x.logIndex}-${x.batchIndex}`} x={x} labels={labels} />)}</tbody>
          </table>
        </div>
      )}
      {!gap && <Pager p={p} label="Pages of token transfers" />}
    </section>
  );
}

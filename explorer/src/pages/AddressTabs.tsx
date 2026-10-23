import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { getAddressInternal, getAddressTransfers, getAddressTxs, getCoinHistory, getFaucetAddress, getTokenInfo, type AddressInternalItem, type AddressTransferItem, type ApiStatus, type DerivedPage, type TxListItem } from "../api.ts";
import { Sender } from "../components/BlockParts.tsx";
import { ErrorCard, LoadingCard } from "../components/Cards.tsx";
import { Amount } from "../components/Amount.tsx";
import { Chip } from "../components/Chip.tsx";
import { HashLink } from "../components/HashLink.tsx";
import { Icon } from "../components/Icon.tsx";
import { Pager, usePaged } from "../components/Pager.tsx";
import { count, duration, exact, units } from "../format.ts";
import { methodOf } from "../method.ts";
import "./tx.css";

type Coin = ApiStatus["coin"];
const Dash = () => <span className="muted">—</span>;
const same = (a: string, b: string | null) => b !== null && a.toLowerCase() === b.toLowerCase();

/** Which way a row went for this address. A row that is neither (a call that merely passed through) has no badge. */
export function Way({ me, from, to }: { me: string; from: string; to: string | null }) {
  const out = same(me, from), into = same(me, to);
  if (out && into) return <span className="way way-self">SELF</span>;
  return out ? <span className="way way-out">OUT</span> : into ? <span className="way way-in">IN</span> : null;
}

const CoinValue = ({ raw, coin }: { raw: string; coin: Coin }) => <span title={`${exact(raw, coin.decimals)} ${coin.symbol}`}>{units(raw, coin.decimals)} {coin.symbol}</span>;
const To = ({ t }: { t: { to: string | null; created: string | null } }) =>
  t.to ? <HashLink value={t.to} to={`/address/${t.to}`} /> : t.created ? <span className="muted">Create: <Link className="mono" to={`/address/${t.created}`}>contract</Link></span> : <span className="muted">creates a contract</span>;

/** A list read from the derived stage says what it is not sure of: an empty one is not called empty while the explorer is behind, and a short one says it may be. */
function Gap({ page, none }: { page: DerivedPage<unknown>; none: string }) {
  const n = page.items.length;
  if (page.derived !== false) return n === 0 ? <p className="muted">{none}</p> : null;
  return <p className="muted small">{n === 0 ? "The explorer has not read these blocks yet, so this list is not known to be empty." : "The explorer is still reading blocks, so this list may be missing the newest rows."}</p>;
}

function Frame({ label, error, ready, children }: { label: string; error: Error | null; ready: boolean; children: React.ReactNode }) {
  if (error && !ready) return <ErrorCard message={error.message} retrying />;
  if (!ready) return <LoadingCard>{`Reading the ${label}…`}</LoadingCard>;
  return <section className="card" aria-label={label}>{children}</section>;
}

function TxRow({ a, t, now, coin, faucet, chain }: { a: string; t: TxListItem; now: number; coin: Coin; faucet: string | null | undefined; chain: string }) {
  const fee = (BigInt(t.gasUsed) * BigInt(t.gasPrice)).toString();
  return (
    <tr>
      <td className="c-hash"><HashLink value={t.hash} to={`/tx/${t.hash}`} />{!t.success && <span className="fact-bad" role="img" aria-label="Failed (reverted)" title="Failed (reverted)"><Icon name="cross" size={13} /></span>}</td>
      <td><span className="tag method">{methodOf(t)}</span></td>
      <td><Link className="num" to={`/block/${t.block}`}>{t.block}</Link></td>
      <td title={new Date(t.timestamp * 1000).toISOString()}>{duration(now - t.timestamp * 1000)} ago</td>
      <td><Sender address={t.from} faucet={faucet} chain={chain} /></td>
      <td><Way me={a} from={t.from} to={t.to} /></td>
      <td><To t={t} /></td>
      <td className="r"><CoinValue raw={t.value} coin={coin} /></td>
      <td className="r"><span className="mono" title={`${exact(fee, coin.decimals)} ${coin.symbol}`}>{exact(fee, coin.decimals)}</span></td>
      <td><Chip status="final" /></td>
    </tr>
  );
}

export function TxsTab({ a, st, now }: { a: string; st: ApiStatus; now: number }) {
  const p = usePaged(["address-txs", a], (before) => getAddressTxs(a, before), 5000);
  const faucet = useQuery({ queryKey: ["faucet-address"], queryFn: getFaucetAddress, staleTime: 60_000, retry: false }).data;
  const items = p.data?.items;
  return (
    <Frame label="Transactions" error={p.error} ready={!!items}>
      <div className="list-h"><span className="muted">{items?.length ? `Showing ${count(items.length)} on this page, newest first` : "No transactions yet."}</span><Pager p={p} label="Pages of transactions" /></div>
      {items && items.length > 0 && (
        <div className="scroll">
          <table className="tbl txs">
            <thead><tr><th>Transaction hash</th><th>Method</th><th>Block</th><th>Age</th><th>From</th><th aria-hidden="true" /><th>To</th><th className="r">Value</th><th className="r">{`Fee (${st.coin.symbol})`}</th><th>Stage</th></tr></thead>
            <tbody>{items.map((t) => <TxRow key={t.hash} a={a} t={t} now={now} coin={st.coin} faucet={faucet} chain={st.chainName} />)}</tbody>
          </table>
        </div>
      )}
      <p className="muted small">Only final transactions are listed. The balance above is read from reth at the final block, never from this list.</p>
    </Frame>
  );
}

function TransferRow({ a, x }: { a: string; x: AddressTransferItem }) {
  // The token route, not the address route: it reads no balance from reth, so a page of transfers across many tokens costs the database only.
  const tok = useQuery({ queryKey: ["token-info", x.token], queryFn: () => getTokenInfo(x.token), retry: false, staleTime: 60_000 }).data ?? null;
  const sym = tok?.symbol ?? null;
  return (
    <tr>
      <td><HashLink value={x.txHash} to={`/tx/${x.txHash}`} /></td>
      <td><Link className="num" to={`/block/${x.block}`}>{x.block}</Link></td>
      <td><HashLink value={x.from} to={`/address/${x.from}`} /></td>
      <td><Way me={a} from={x.from} to={x.to} /></td>
      <td><HashLink value={x.to} to={`/address/${x.to}`} /></td>
      <td className="r">
        {x.amount === null ? <span className="mono">{sym ? `${sym} ` : ""}{x.tokenId === null ? "—" : `#${x.tokenId}`}</span>
          : tok?.decimals != null && sym ? <Amount raw={x.amount} decimals={tok.decimals} symbol={sym} />
          : <span className="mono" title="The token's decimals cannot be read, so this is the raw amount">{x.amount}</span>}
      </td>
      <td><HashLink value={x.token} to={`/token/${x.token}`} />{sym && <span className="tag">{sym}</span>}{x.tokenId !== null && x.amount !== null && <span className="muted"> id {x.tokenId}</span>}</td>
      <td><Chip status="final" /></td>
    </tr>
  );
}

export function TransfersTab({ a }: { a: string }) {
  const p = usePaged(["address-transfers", a], (before) => getAddressTransfers(a, before), 5000);
  const d = p.data;
  return (
    <Frame label="Token transfers" error={p.error} ready={!!d}>
      <div className="list-h"><span className="muted">{d?.items.length ? `Showing ${count(d.items.length)} on this page, newest first` : ""}</span><Pager p={p} label="Pages of token transfers" /></div>
      {d && d.items.length > 0 && (
        <div className="scroll">
          <table className="tbl">
            <thead><tr><th>Transaction hash</th><th>Block</th><th>From</th><th aria-hidden="true" /><th>To</th><th className="r">Amount</th><th>Token</th><th>Stage</th></tr></thead>
            <tbody>{d.items.map((x) => <TransferRow key={`${x.txHash}-${x.logIndex}-${x.batchIndex}`} a={a} x={x} />)}</tbody>
          </table>
        </div>
      )}
      {d && <Gap page={d} none="No token transfers." />}
      <p className="muted small">Transfers are read from the Transfer logs of final blocks.</p>
    </Frame>
  );
}

const callName = (c: { traceAddress: number[] }) => (c.traceAddress.length === 0 ? "Top call" : `t${c.traceAddress.join("-")}`);

function InternalRow({ a, c, coin }: { a: string; c: AddressInternalItem; coin: Coin }) {
  return (
    <tr>
      <td><HashLink value={c.txHash} to={`/tx/${c.txHash}`} /></td>
      <td><Link className="num" to={`/block/${c.block}`}>{c.block}</Link></td>
      <td>{callName(c)}</td>
      <td>{c.callType}</td>
      <td><HashLink value={c.from} to={`/address/${c.from}`} /></td>
      <td><Way me={a} from={c.from} to={c.to} /></td>
      <td>{c.to ? <HashLink value={c.to} to={`/address/${c.to}`} /> : <span className="muted">none</span>}</td>
      <td className="r"><CoinValue raw={c.value} coin={coin} /></td>
      <td>{c.error ? <span className="fact-bad">{c.error}</span> : <span className="fact-ok">true</span>}</td>
    </tr>
  );
}

export function InternalTab({ a, st }: { a: string; st: ApiStatus }) {
  const p = usePaged(["address-internal", a], (before) => getAddressInternal(a, before), 5000);
  const d = p.data;
  return (
    <Frame label="Internal calls" error={p.error} ready={!!d}>
      <div className="list-h"><span className="muted">{d?.items.length ? `Showing ${count(d.items.length)} on this page, newest first` : ""}</span><Pager p={p} label="Pages of internal calls" /></div>
      {d && d.items.length > 0 && (
        <div className="scroll">
          <table className="tbl">
            <thead><tr><th>Transaction hash</th><th>Block</th><th>Call</th><th>Type</th><th>From</th><th aria-hidden="true" /><th>To</th><th className="r">Value</th><th>Result</th></tr></thead>
            <tbody>{d.items.map((c) => <InternalRow key={`${c.txHash}-${c.traceAddress.join("-")}`} a={a} c={c} coin={st.coin} />)}</tbody>
          </table>
        </div>
      )}
      {d && <Gap page={d} none="No internal calls." />}
      <p className="muted small">This list holds only the calls that moved value. Every call is in the transaction's call tree.</p>
    </Frame>
  );
}

export function CoinTab({ a, st }: { a: string; st: ApiStatus }) {
  const p = usePaged(["address-coin", a], (before) => getCoinHistory(a, before), 5000);
  const d = p.data;
  return (
    <Frame label="Coin history" error={p.error} ready={!!d}>
      <div className="list-h"><span className="muted">{d?.items.length ? `The balance at the blocks where it changed, newest first` : ""}</span><Pager p={p} label="Pages of coin history" /></div>
      {d && d.items.length > 0 && (
        <div className="scroll">
          <table className="tbl">
            <thead><tr><th>Block</th><th className="r">{`Balance (${st.coin.symbol})`}</th></tr></thead>
            <tbody>{d.items.map((c) => <tr key={c.block}><td><Link className="num" to={`/block/${c.block}`}>{c.block}</Link></td><td className="r"><CoinValue raw={c.balance} coin={st.coin} /></td></tr>)}</tbody>
          </table>
        </div>
      )}
      {d && <Gap page={d} none="No change of balance has been recorded." />}
    </Frame>
  );
}

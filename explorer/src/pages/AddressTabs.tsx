import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { addressTransfersCsvPath, addressTxsCsvPath, getAddressContracts, getAddressInternal, getAddressTransfers, getAddressTxs, getCoinHistory, getFaucetAddress, getTokenInfo, type AddressInternalItem, type AddressTransferItem, type ApiStatus, type ContractListItem, type DerivedPage, type Label, type TxDirection, type TxListItem } from "../api.ts";
import { AddressCell } from "../components/AddressCell.tsx";
import { DownloadLink, ErrorCard, LoadingCard } from "../components/Cards.tsx";
import { Amount } from "../components/Amount.tsx";
import { Chip } from "../components/Chip.tsx";
import { HashLink } from "../components/HashLink.tsx";
import { Icon } from "../components/Icon.tsx";
import { Pager, usePaged } from "../components/Pager.tsx";
import { Seg } from "../components/Seg.tsx";
import { count, duration, exact, feeOf, short, units } from "../format.ts";
import { useLabels, type Labels } from "../labels.ts";
import { useNow } from "../useStatus.ts";
import { methodOf } from "../method.ts";
import { Moved } from "./HomeParts.tsx";
import { Who } from "./AddressParts.tsx";
import "./tx.css";

type Coin = ApiStatus["coin"];
const Dash = () => <span className="muted">—</span>;
const same = (a: string, b: string | null) => b !== null && a.toLowerCase() === b.toLowerCase();

/** Which way a row went for this address. A row that is neither (a call that merely passed through) has no badge. */
export function Way({ me, from, to }: { me: string; from: string; to: string | null }) {
  const out = same(me, from), into = same(me, to);
  if (out && into) return <span className="dir-tag dir-self">SELF</span>;
  return out ? <span className="dir-tag dir-out">OUT</span> : into ? <span className="dir-tag dir-in">IN</span> : null;
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
  if (error && !ready) return <section className="tab-body" aria-label={label}><ErrorCard message={error.message} retrying /></section>;
  if (!ready) return <section className="tab-body" aria-label={label}><LoadingCard>{`Reading the ${label}…`}</LoadingCard></section>;
  return <section className="tab-body" aria-label={label}>{children}</section>;
}

function TxRow({ a, t, now, coin, faucet, chain, labels }: { a: string; t: TxListItem; now: number; coin: Coin; faucet: string | null | undefined; chain: string; labels: Labels }) {
  const fee = (BigInt(t.gasUsed) * BigInt(t.gasPrice)).toString();
  return (
    <tr>
      <td><HashLink value={t.hash} to={`/tx/${t.hash}`} plain />{!t.success && <span className="fact-bad" role="img" aria-label="Failed (reverted)" title="Failed (reverted)"><Icon name="cross" size={13} /></span>}</td>
      <td><span className="tag method">{methodOf(t)}</span></td>
      <td><Link className="num" to={`/block/${t.block}`}>{t.block}</Link></td>
      <td title={new Date(t.timestamp * 1000).toISOString()}>{duration(now - t.timestamp * 1000)} ago</td>
      <td><Who address={t.from} faucet={faucet} chain={chain} labels={labels} /></td>
      <td><Way me={a} from={t.from} to={t.to} /></td>
      <td>{t.to ? <AddressCell address={t.to} label={labels.get(t.to)} /> : t.created ? <span className="create"><span className="muted">Create:</span> <AddressCell address={t.created} label={labels.get(t.created)} /></span> : <span className="muted">creates a contract</span>}</td>
      <td className="r"><Moved t={t} coin={coin} labels={labels} /></td>
      <td className="r"><span className="num" title={`${exact(fee, coin.decimals)} ${coin.symbol}`}>{feeOf(fee, coin.decimals)}</span></td>
      <td><Chip status="final" /></td>
    </tr>
  );
}

const DIRECTIONS: { id: TxDirection; text: string; noun: string }[] = [{ id: "all", text: "All", noun: "" }, { id: "sent", text: "Sent", noun: "sent " }, { id: "received", text: "Received", noun: "received " }];

export function TxsTab({ a, st, now }: { a: string; st: ApiStatus; now: number }) {
  const [dir, setDir] = useState<TxDirection>("all");
  const p = usePaged(["address-txs", a, dir], (before) => getAddressTxs(a, before, undefined, dir), 5000);
  const faucet = useQuery({ queryKey: ["faucet-address"], queryFn: getFaucetAddress, staleTime: 60_000, retry: false }).data;
  const items = p.data?.items;
  const labels = useLabels(items?.flatMap((t) => [t.from, t.to, t.created, t.tokenMoves?.first?.token]) ?? []);
  const noun = DIRECTIONS.find((d) => d.id === dir)!.noun;
  const whole = !p.hasPrev && !p.hasNext;
  return (
    <Frame label="Transactions" error={p.error} ready={!!items}>
      <div className="list-h">
        <span className="muted">{items?.length ? (whole ? `Showing all ${count(items.length)} ${noun}transaction${items.length === 1 ? "" : "s"}, newest first` : `Showing ${count(items.length)} on this page, newest first`) : `No ${noun}transactions yet.`}</span>
        <span className="list-tools">
          <Pager p={p} label="Pages of transactions" />
          <Seg label="Show transactions" value={dir} options={DIRECTIONS.map((d) => ({ id: d.id, text: d.text }))} onPick={setDir} />
          <DownloadLink href={addressTxsCsvPath(a, dir)} file={`transactions-${a}.csv`}>CSV</DownloadLink>
        </span>
      </div>
      {items && items.length > 0 && (
        <div className="scroll">
          <table className="tbl">
            <thead><tr><th>Transaction hash</th><th>Method</th><th>Block</th><th>Age</th><th>From</th><th aria-hidden="true" /><th>To</th><th className="r">Value</th><th className="r">{`Fee (${st.coin.symbol})`}</th><th>Stage</th></tr></thead>
            <tbody>{items.map((t) => <TxRow key={t.hash} a={a} t={t} now={now} coin={st.coin} faucet={faucet} chain={st.chainName} labels={labels} />)}</tbody>
          </table>
        </div>
      )}
      <p className="muted small">Only final transactions are listed. The balance above is read from reth at the final block, never from this list.</p>
    </Frame>
  );
}

function ContractRow({ c, now, labels }: { c: ContractListItem; now: number; labels: Labels }) {
  const at = c.createdAt ? Date.parse(c.createdAt) : null;
  return (
    <tr>
      <td><AddressCell address={c.address} label={labels.get(c.address) ?? { address: c.address, name: c.name, symbol: null, kind: "contract", standard: c.standard, decimals: null, verified: c.verified }} /></td>
      <td>{c.creationBlock === null ? <Dash /> : <Link className="num" to={`/block/${c.creationBlock}`}>{c.creationBlock}</Link>}</td>
      <td title={c.createdAt ?? undefined}>{at === null ? <Dash /> : `${duration(now - at)} ago`}</td>
      <td>{c.verified ? <span className="chip chip-final"><Icon name="check" size={12} />Verified</span> : <span className="muted">Not verified</span>}</td>
      <td className="r"><span className="num">{count(c.interactionCount)}</span></td>
    </tr>
  );
}

/** The contracts this address made, newest first, read from the derived stage. */
export function ContractsTab({ a, now }: { a: string; now: number }) {
  const p = usePaged(["address-contracts", a], (before) => getAddressContracts(a, before), 5000);
  const d = p.data;
  const labels = useLabels(d?.items.map((c) => c.address) ?? []);
  return (
    <Frame label="Contracts created" error={p.error} ready={!!d}>
      <div className="list-h"><span className="muted">{d?.items.length ? "The contracts this address made, newest first" : ""}</span><Pager p={p} label="Pages of contracts created" /></div>
      {d && d.items.length > 0 && (
        <div className="scroll">
          <table className="tbl">
            <thead><tr><th>Contract</th><th>Block</th><th>Age</th><th>Source code</th><th className="r">Interactions</th></tr></thead>
            <tbody>{d.items.map((c) => <ContractRow key={c.address} c={c} now={now} labels={labels} />)}</tbody>
          </table>
        </div>
      )}
      {d && <Gap page={d} none="This address has made no contracts." />}
    </Frame>
  );
}

const ZERO = "0x" + "00".repeat(20);

/** What moved, in the token's own units: the amount with its symbol where the decimals and the symbol are known, whole units (exact in the title) where only the decimals are, the raw count (and said so) where they are not; `#id` for an NFT, with an ERC-1155's count before it. */
function TransferAmount({ x, label, ready }: { x: AddressTransferItem; label: Label | undefined; ready: boolean }) {
  // The labels carry what the token has told; the token route (which reads no balance from reth) is asked only for one they do not describe.
  const need = ready && x.amount !== null && x.tokenId === null && label?.decimals == null;
  const info = useQuery({ queryKey: ["token-info", x.token], queryFn: () => getTokenInfo(x.token), retry: false, staleTime: 60_000, enabled: need }).data ?? null;
  if (x.tokenId !== null) return <span className="num">{x.amount !== null ? `${count(x.amount)} · ` : ""}#{x.tokenId}</span>;
  if (x.amount === null) return <Dash />;
  const decimals = label?.decimals ?? info?.decimals ?? null, symbol = label?.symbol ?? info?.symbol ?? null;
  if (decimals !== null && symbol) return <Amount raw={x.amount} decimals={decimals} symbol={symbol} />;
  if (decimals !== null) return <span className="num" title={exact(x.amount, decimals)}>{units(x.amount, decimals)}</span>;
  return <span className="num" title="The token's decimals are not known, so this is the raw amount">{count(x.amount)}</span>;
}

const Party = ({ address, labels }: { address: string; labels: Labels }) =>
  address === ZERO ? <span className="mono">{short(ZERO, 6, 6)}</span> : <AddressCell address={address} label={labels.get(address)} />;

function TransferRow({ a, x, now, labels }: { a: string; x: AddressTransferItem; now: number; labels: Labels }) {
  const token = labels.get(x.token);
  return (
    <tr>
      <td><HashLink value={x.txHash} to={`/tx/${x.txHash}`} plain /></td>
      <td><span className="tag method">{methodOf({ methodId: x.methodId, to: x.creation ? null : x.to, created: x.creation ? x.token : null, value: "0" })}</span></td>
      <td><Link className="num" to={`/block/${x.block}`}>{x.block}</Link></td>
      <td title={new Date(x.timestamp * 1000).toISOString()}>{duration(now - x.timestamp * 1000)} ago</td>
      <td><Party address={x.from} labels={labels} />{x.from === ZERO && <span className="tag">mint</span>}</td>
      <td><Way me={a} from={x.from} to={x.to} /></td>
      <td><Party address={x.to} labels={labels} />{x.to === ZERO && <span className="tag">burn</span>}</td>
      <td className="r"><TransferAmount x={x} label={token} ready={labels.ready} /></td>
      <td><AddressCell address={x.token} label={token} to={`/token/${x.token}`} /></td>
      <td><Chip status="final" /></td>
    </tr>
  );
}

/** The token transfers of an address: the ERC-20 ones, or the NFT ones (ERC-721 and ERC-1155) in their own list. */
export function TransfersTab({ a, nft = false }: { a: string; nft?: boolean }) {
  const kind = nft ? "NFT transfers" : "Token transfers";
  const standard = nft ? "nft" : "ERC-20";
  const [tok, setTok] = useState<string | null>(null);
  const [known, setKnown] = useState<string[]>([]);
  const now = useNow();
  const p = usePaged(["address-transfers", a, standard, tok], (before) => getAddressTransfers(a, before, undefined, { standard, token: tok ?? undefined }), 5000);
  const d = p.data;
  // The tokens to filter by are the ones this address's unfiltered list has shown; a filtered list could only ever show its own.
  const seen = tok === null && d ? [...new Set(d.items.map((x) => x.token))] : [];
  const fresh = seen.filter((t) => !known.includes(t));
  useEffect(() => { if (fresh.length > 0) setKnown((k) => [...k, ...fresh.filter((t) => !k.includes(t))]); }, [fresh.join()]);
  const labels = useLabels([...(d?.items ?? []).flatMap((x) => [x.from, x.to, x.token]), ...known]);
  const whole = !p.hasPrev && !p.hasNext;
  const n = d?.items.length ?? 0;
  // A token's name is the token's own text: bidi controls are stripped from it, and it is cut to a short form with the full name in the title.
  const l = (t: string) => labels.get(t), clean = (w: string) => w.replace(/[\u202A-\u202E\u2066-\u2069]/g, ""), name = (t: string) => { const w = clean(l(t)?.name ?? l(t)?.symbol ?? short(t, 8, 4)); return w.length > 24 ? `${w.slice(0, 23)}…` : w; }, full = (t: string) => clean(l(t)?.name ?? l(t)?.symbol ?? t);
  const total = whole && d?.derived !== false;
  return (
    <Frame label={kind} error={p.error} ready={!!d}>
      <div className="list-h">
        <span className="muted">{n ? (total ? <>{count(n)} {tok ? <bdi title={full(tok)}>{name(tok)}</bdi> : nft ? "NFT" : "ERC-20"} transfer{n === 1 ? "" : "s"} to or from this address</> : `Showing ${count(n)} on this page, newest first`) : ""}</span>
        <span className="list-tools">
          <Pager p={p} label={`Pages of ${kind.toLowerCase()}`} />
          {known.length > 0 && (known.length <= 3
            ? <Seg label="Show tokens" value={tok ?? "all"} options={[{ id: "all", text: "All tokens" }, ...known.map((t) => ({ id: t, text: <bdi>{name(t)}</bdi>, title: full(t) }))]} onPick={(id) => setTok(id === "all" ? null : id)} />
            : <select className="seg-select" aria-label="Show tokens" value={tok ?? "all"} onChange={(e) => setTok(e.target.value === "all" ? null : e.target.value)}>
                <option value="all">All tokens</option>{known.map((t) => <option key={t} value={t} title={full(t)}>{name(t)}</option>)}
              </select>)}
          <DownloadLink href={addressTransfersCsvPath(a, { standard, token: tok ?? undefined })} file={`${nft ? "nft" : "token"}-transfers-${a}.csv`}>CSV</DownloadLink>
        </span>
      </div>
      {d && d.items.length > 0 && (
        <div className="scroll">
          <table className="tbl">
            <thead><tr><th>Transaction hash</th><th>Method</th><th>Block</th><th>Age</th><th>From</th><th aria-hidden="true" /><th>To</th><th className="r">Amount</th><th>Token</th><th>Stage</th></tr></thead>
            <tbody>{d.items.map((x) => <TransferRow key={`${x.txHash}-${x.logIndex}-${x.batchIndex}`} a={a} x={x} now={now} labels={labels} />)}</tbody>
          </table>
        </div>
      )}
      {d && <Gap page={d} none={nft ? "No NFT transfers." : "No token transfers."} />}
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

import { Link, useParams, useSearchParams } from "react-router-dom";
import { getAddressDetail, getHoldings, type AddressDetail, type ApiStatus, type Holding } from "../api.ts";
import { Amount } from "../components/Amount.tsx";
import { unready } from "../components/Cards.tsx";
import { HashLink } from "../components/HashLink.tsx";
import { Item, Kv } from "../components/Kv.tsx";
import { Pager, usePaged } from "../components/Pager.tsx";
import { count, exact, units } from "../format.ts";
import { useFollowing, useNow, useStatus } from "../useStatus.ts";
import { CoinTab, InternalTab, TransfersTab, TxsTab } from "./AddressTabs.tsx";
import { Contract } from "./Contract.tsx";
import "./address.css";
import "./tx.css";

const KIND = { account: "Account", contract: "Contract", token: "Token" } as const;
const Dash = () => <span className="muted">—</span>;

/** The title: a token is named by its own name and symbol; an account and a contract are an address, and the chip says which. */
function Title({ a }: { a: AddressDetail }) {
  const t = a.token;
  const named = t && (t.name || t.symbol) ? <>{t.name ?? t.symbol} {t.name && t.symbol && <span className="muted thin">({t.symbol})</span>}</> : "Address";
  return <div className="ptitle"><h1>{named}</h1><span className="chip chip-kind">{KIND[a.kind]}</span></div>;
}

/** The balance is what reth says at the final block; with no final block yet it is not known, and is never drawn as 0. */
function Overview({ a, coin }: { a: AddressDetail; coin: ApiStatus["coin"] | undefined }) {
  return (
    <section className="card" aria-label="Overview">
      <h2>Overview</h2>
      <div className="muted small">{coin ? `${coin.symbol} balance` : "Balance"}</div>
      {a.balance === null ? <div className="addr-bal muted">Not known yet</div> : coin ? <div className="addr-bal" title={`${exact(a.balance, coin.decimals)} ${coin.symbol}`}>{units(a.balance, coin.decimals)} <small>{coin.symbol}</small></div> : <div className="addr-bal muted">…</div>}
      {a.balance === null
        ? <p className="small muted">There is no final block to read it at yet.</p>
        : <p className="small muted">as of final block {a.balanceBlock}, read from reth{coin && <> · exact: <span className="mono">{exact(a.balance, coin.decimals)} {coin.symbol}</span></>}</p>}
    </section>
  );
}

function HoldingRow({ h }: { h: Holding }) {
  const nft = h.standard !== "ERC-20";
  const name = h.name ?? h.symbol;
  return (
    <div className="hold">
      <div>
        {name ? <Link to={`/token/${h.token}`}>{name}</Link> : <HashLink value={h.token} to={`/token/${h.token}`} />}
        <div className="muted small">{h.symbol && <>{h.symbol}{nft && ` #${h.tokenId}`} · </>}{h.standard} · as of block {h.updatedBlock}</div>
      </div>
      <div className="r">
        {nft ? <span className="mono">{h.value === "1" ? "1" : h.value}</span>
          : h.decimals !== null && h.symbol ? <Amount raw={h.value} decimals={h.decimals} symbol={h.symbol} />
          : <span className="mono" title="The token's decimals are not known, so this is the raw value">{h.value}</span>}
      </div>
    </div>
  );
}

/** What the address holds, token by token, each as of the block it last moved. The list is the explorer's, so while it is behind it says it may be short. */
function Holdings({ addr }: { addr: string }) {
  const p = usePaged(["address-tokens", addr], (after) => getHoldings(addr, after), 5000);
  const d = p.data;
  return (
    <section className="card" aria-label="Token holdings">
      <h2>Token holdings</h2>
      {p.error && !d ? <p className="muted">{p.error.message}</p> : !d ? <p className="muted">Reading the token holdings…</p> : (
        <>
          {d.items.map((h) => <HoldingRow key={`${h.token}-${h.tokenId}`} h={h} />)}
          {d.items.length === 0 && d.derived !== false && <p className="muted">This address holds no tokens.</p>}
          {d.derived === false && <p className="small muted">The explorer is still reading blocks, so this list may be missing tokens.</p>}
          <Pager p={p} label="Pages of token holdings" />
        </>
      )}
    </section>
  );
}

function More({ a }: { a: AddressDetail }) {
  const blk = (n: number | null) => (n === null ? <Dash /> : <Link className="num" to={`/block/${n}`}>Block {n}</Link>);
  return (
    <section className="card" aria-label="More information">
      <h2>More information</h2>
      <Kv wide>
        {a.createdBy && <Item label="Created by">{a.createdBy.txHash ? <><HashLink value={a.createdBy.txHash} to={`/tx/${a.createdBy.txHash}`} /> in </> : "genesis, "}<Link className="num" to={`/block/${a.createdBy.block}`}>block {a.createdBy.block}</Link></Item>}
        <Item label="Transactions sent"><span className="mono">{count(a.sentCount)}</span></Item>
        <Item label="Transactions received"><span className="mono">{count(a.receivedCount)}</span></Item>
        <Item label="First seen">{blk(a.firstSeenBlock)}</Item>
        <Item label="Last active">{blk(a.lastActiveBlock)}</Item>
      </Kv>
      {!a.derived && <p className="small muted card-note">The explorer is still reading blocks, so these counts may be short.</p>}
    </section>
  );
}

type TabId = "transactions" | "token-transfers" | "internal" | "coin-history";

/**
 * What reth says about an address at the final block, and what the explorer's index holds of it: the balance is reth's, the counts, the lists and the
 * holdings are the index's, complete as far as the explorer has read. The tab is in the link.
 */
export function Address({ tracker = false }: { tracker?: boolean } = {}) {
  const { addr = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const st = useStatus().data;
  const now = useNow();
  const q = useFollowing(["address-detail", addr], () => getAddressDetail(addr), (d) => d.derived);
  const wait = unready(q, "Reading the address…");
  if (wait) return wait;
  const a = q.data!;
  // Design section 7: an address that holds code is the contract page. A token's own route keeps the tracker view.
  if (!tracker && a.kind !== "account") return <Contract addr={addr} />;
  const tabs: { id: TabId; label: string; n?: number }[] = [
    { id: "transactions", label: "Transactions" },
    { id: "token-transfers", label: "Token transfers", n: a.tokenTransferCount },
    { id: "internal", label: "Internal calls", n: a.internalCount },
    { id: "coin-history", label: "Coin history" },
  ];
  const asked = params.get("tab");
  const tab: TabId = tabs.find((t) => t.id === asked)?.id ?? "transactions";
  const pick = (id: TabId) => setParams((p) => { const n = new URLSearchParams(p); if (id === "transactions") n.delete("tab"); else n.set("tab", id); return n; }, { replace: true });
  return (
    <>
      <nav className="small muted" aria-label="Breadcrumb"><Link to="/addresses">Addresses</Link> / <span className="mono">{a.address.slice(0, 6)}…{a.address.slice(-4)}</span></nav>
      <Title a={a} />
      <div className="bighash"><HashLink value={a.address} full /></div>
      <div className="addr-cards">
        <Overview a={a} coin={st?.coin} />
        <Holdings addr={a.address} />
        <More a={a} />
      </div>
      <div className="tabs" role="tablist" aria-label="Address sections">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" id={`tab-${t.id}`} aria-selected={t.id === tab} aria-controls={`panel-${t.id}`} onClick={() => pick(t.id)}>
            {t.label}{t.n !== undefined && <> <span className="count">{count(t.n)}</span></>}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {!st ? null : tab === "transactions" ? <TxsTab a={a.address} st={st} now={now} />
          : tab === "token-transfers" ? <TransfersTab a={a.address} />
          : tab === "internal" ? <InternalTab a={a.address} st={st} />
          : <CoinTab a={a.address} st={st} />}
      </div>
    </>
  );
}

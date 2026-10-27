import { Link, useParams, useSearchParams } from "react-router-dom";
import { getAddressDetail, type AddressDetail, type ApiStatus } from "../api.ts";
import { unready } from "../components/Cards.tsx";
import { HashLink } from "../components/HashLink.tsx";
import { count, exact, units } from "../format.ts";
import { useFollowing, useNow, useStatus } from "../useStatus.ts";
import { CoinTab, ContractsTab, InternalTab, TransfersTab, TxsTab } from "./AddressTabs.tsx";
import { CreatedChip, Holdings, More } from "./AddressParts.tsx";
import { Contract } from "./Contract.tsx";
import "./address.css";
import "./tx.css";
import { Info } from "../components/Info.tsx";

/** The title: an address that holds no code. A contract and a token have their own pages. */
const Title = ({ a }: { a: AddressDetail }) => <div className="ptitle"><h1>Address</h1><span className="chip chip-kind">Account</span><CreatedChip a={a} to="?tab=contracts" /></div>;

/** The balance is what reth says at the final block; with no final block yet it is not known, and is never drawn as 0. */
function Overview({ a, coin }: { a: AddressDetail; coin: ApiStatus["coin"] | undefined }) {
  return (
    <section className="card" aria-label="Overview">
      <h2>Overview</h2>
      <div className="muted small">{coin ? `${coin.symbol} balance` : "Balance"}</div>
      {a.balance === null ? <div className="addr-bal muted">Not known yet</div> : coin ? <div className="addr-bal" title={`${exact(a.balance, coin.decimals)} ${coin.symbol}`}>{units(a.balance, coin.decimals)} <small>{coin.symbol}</small></div> : <div className="addr-bal muted">…</div>}
      {a.balance === null
        ? <p className="small muted">There is no final block to read it at yet.</p>
        : <p className="small muted">as of final block {a.balanceBlock}<Info about="the balance">Read from reth{coin && <>; exact: <span className="num">{exact(a.balance, coin.decimals)} {coin.symbol}</span></>}.</Info></p>}
    </section>
  );
}

type TabId = "transactions" | "token-transfers" | "nft-transfers" | "internal" | "contracts" | "coin-history";

/**
 * What reth says about an address at the final block, and what the explorer's index holds of it: the balance is reth's, the counts, the lists and the
 * holdings are the index's, complete as far as the explorer has read. The tab is in the link.
 */
export function Address() {
  const { addr = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const st = useStatus().data;
  const now = useNow();
  const q = useFollowing(["address-detail", addr], () => getAddressDetail(addr), (d) => d.derived);
  const wait = unready(q, "Reading the address…");
  if (wait) return wait;
  const a = q.data!;
  // Design section 7: an address that holds code (a token too) is the contract page; a token has its own page at /token.
  if (a.kind !== "account") return <Contract addr={addr} />;
  const made = typeof a.createdCount === "number" ? `${count(a.createdCount)}${a.createdCountCapped ? "+" : ""}` : undefined;
  // The transfer tabs count the list they hold (the server's own count of each, null past its ceiling), never `tokenTransferCount`, which adds every standard together.
  // While the derive stage is behind (`derived` is false) a count is only what has been derived so far, so the tabs show none.
  const exactTransfers = a.derived !== false;
  const tabs: { id: TabId; label: string; n?: number | string }[] = [
    { id: "transactions", label: "Transactions", n: a.sentCount + a.receivedCount },
    { id: "token-transfers", label: "Token transfers", n: exactTransfers ? a.erc20TransferCount ?? undefined : undefined },
    { id: "nft-transfers", label: "NFT transfers", n: exactTransfers ? a.nftTransferCount ?? undefined : undefined },
    { id: "internal", label: "Internal calls", n: a.internalCount },
    { id: "contracts", label: "Contracts created", n: made },
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
        <More a={a} st={st} />
      </div>
      <section className="card tab-card" aria-label="Activity">
        <div className="tabs" role="tablist" aria-label="Address sections">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" id={`tab-${t.id}`} aria-selected={t.id === tab} aria-controls={`panel-${t.id}`} onClick={() => pick(t.id)}>
              {t.label}{t.n !== undefined && <> <span className="count">{typeof t.n === "number" ? count(t.n) : t.n}</span></>}
            </button>
          ))}
        </div>
        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
          {!st ? null : tab === "transactions" ? <TxsTab a={a.address} st={st} now={now} />
            : tab === "token-transfers" ? <TransfersTab a={a.address} />
            : tab === "nft-transfers" ? <TransfersTab a={a.address} nft />
            : tab === "internal" ? <InternalTab a={a.address} st={st} />
            : tab === "contracts" ? <ContractsTab a={a.address} now={now} />
            : <CoinTab a={a.address} st={st} />}
        </div>
      </section>
    </>
  );
}

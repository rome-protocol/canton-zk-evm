import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import type { ApiStatus } from "../api.ts";
import { PaintedProvider, usePainted } from "../painted.tsx";
import { useHealth, useNow, useStatus } from "../useStatus.ts";
import { FOOTER_LINE, SOURCE_URL } from "../copy.ts";
import { baseFee, duration } from "../format.ts";
import { useBlocks } from "../stats.ts";
import { Icon } from "./Icon.tsx";
import { SearchBox } from "./SearchBox.tsx";

export { FOOTER_LINE };
/** Shown until the server has said what the chain is called. */
const DEFAULT_NAME = "Ostia";

/**
 * The pages of the header, in the order of the approved screens. A page is linked once its route exists (`built`): the others are listed here so that
 * the order is kept, and are drawn when their pages land. The API link is the page that describes the routes.
 */
export const NAV: ReadonlyArray<readonly [path: string, label: string, built: boolean]> = [
  ["/", "Home", true], ["/blocks", "Blocks", true], ["/txs", "Transactions", true], ["/contracts", "Contracts", true], ["/tokens", "Tokens", true],
  ["/canton", "Canton", true], ["/stats", "Stats", true], ["/faucet", "Faucet", true], ["/docs/api", "API", true],
];

/** The page of the header that owns a detail route: a block is read under Blocks, a transaction under Transactions. A route no page of the header owns keeps nothing lit. */
const PARENT: Readonly<Record<string, string>> = { block: "/blocks", tx: "/txs", contract: "/contracts", address: "/addresses", token: "/tokens", leg: "/legs", canton: "/canton", docs: "/docs/api" };
export function parentPath(pathname: string): string {
  if (pathname === "/") return "/";
  const [, first = "", ...rest] = pathname.split("/");
  const list = `/${first}`;
  if (rest.length === 0 && NAV.some(([to]) => to === list)) return list;
  return PARENT[first] ?? "";
}

/**
 * The words for the checks. With the list /api/health serves, the count is that list's: "All 16 checks ok", or how many of them are not ok. Without it (the route
 * did not answer) the status's own word stands, with no count, because none is known.
 */
function checksText(s: ApiStatus, checks: ReadonlyArray<{ status: string }> | undefined): ReactNode {
  if (s.starting && !s.problems.length) return "Starting";
  const bad = checks?.filter((c) => c.status !== "ok").length ?? 0;
  if (checks && bad) return <><b>{bad}</b> of <b>{checks.length}</b> checks not ok</>;
  if (s.problems.length) return "A check failed";
  if (!s.ok) return "Checks not complete";
  return checks ? <>All <b>{checks.length}</b> checks ok</> : "All checks ok";
}

/** The thin bar at the top: whether the checks pass, the newest final block, the block being proven, and the chain. It says only what the status says. The values are bold; on a phone only the first two stay. */
function TopBar({ status: s }: { status: ApiStatus }) {
  const now = useNow();
  const painted = usePainted();
  const health = useHealth(painted).data;
  // The base fee is the newest final block's: the list route carries it, so the bar reads one block.
  const newest = useBlocks(1, false, painted);
  const fee = newest.isError ? "Base fee cannot be read right now" : newest.data ? (newest.data.items[0] ? <>Base fee <b>{baseFee(newest.data.items[0].baseFee)}</b></> : "Base fee: no block yet") : "Base fee reading…";
  const tone = s.ok && !health?.checks.some((c) => c.status !== "ok") ? "ok" : s.ok ? "bad" : s.starting && !s.problems.length ? "off" : "bad";
  return (
    <section className="topbar" aria-label="Chain at a glance">
      <span className={`sd ${tone}`}><i />{checksText(s, health?.checks)}</span>
      {s.final && <span>Final block <b><Link className="num" to={`/block/${s.final.number}`}>{s.final.number}</Link></b> · {duration(now - Date.parse(s.final.recordTime))} ago</span>}
      {s.proving && <span className="tb-wide">Being proven <b><Link className="num" to={`/block/${s.proving.number}`}>block {s.proving.number}</Link></b></span>}
      <span className="tb-wide">{fee}</span>
      <span className="tb-wide">Chain <b>{s.chainId}</b> · coin <b>{s.coin.symbol}</b></span>
      {s.networkName && <span className="topbar-end tb-wide">{s.coin.symbol} is a test coin. It has no value.</span>}
    </section>
  );
}

/** The header every page has, and the line every page ends with. */
export function Shell({ children }: { children: ReactNode }) {
  return <PaintedProvider><ShellBody>{children}</ShellBody></PaintedProvider>;
}

function ShellBody({ children }: { children: ReactNode }) {
  const status = useStatus().data;
  const { pathname, hash } = useLocation();
  const home = pathname === "/";
  const parent = parentPath(pathname);
  // The menu button is for phones, where the pages are folded away; choosing a page closes it.
  const [menu, setMenu] = useState(false);
  useEffect(() => setMenu(false), [pathname]);
  // A link to a part of a page (the footer's wallet link) scrolls there once the page has drawn it.
  useEffect(() => { if (hash) document.getElementById(hash.slice(1))?.scrollIntoView?.(); }, [pathname, hash]);
  const name = status?.chainName ?? DEFAULT_NAME;
  return (
    <div className="page">
      {status && <TopBar status={status} />}
      <header className="top">
        <Link className="brand" to="/">
          <span className="mark" role="img" aria-label="Rome" />
          <span className="name">{name}</span>
          {status?.networkName && <span className="pill">{status.networkName}</span>}
        </Link>
        <button type="button" className="menu" aria-label="Menu" aria-expanded={menu} aria-controls="pages" onClick={() => setMenu((m) => !m)}><Icon name={menu ? "cross" : "menu"} size={18} /></button>
        <nav id="pages" className={`nav${menu ? " open" : ""}`} aria-label="Pages">
          {NAV.filter(([, , built]) => built).map(([to, label]) => <Link key={to} to={to} className={`navlink${to === parent ? " active" : ""}`} aria-current={to === parent ? "page" : undefined}>{label}</Link>)}
        </nav>
        {!home && <SearchBox />}
      </header>
      <div className="thread" />
      <main className="main">{children}</main>
      <footer className="foot">
        <p className="foot-text"><Icon name="lock" size={13} /><span>{FOOTER_LINE}</span></p>
        <nav className="foot-links" aria-label="Footer">
          <Link to="/docs/api">API</Link>
          <a href="/api/health">Health</a>
          {status?.publicRpc && <Link to="/docs/api#rpc-h">Add {name} to your wallet</Link>}
          <a href={SOURCE_URL}>Source code</a>
        </nav>
      </footer>
    </div>
  );
}

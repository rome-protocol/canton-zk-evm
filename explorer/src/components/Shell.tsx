import type { ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import type { ApiStatus } from "../api.ts";
import { PaintedProvider, usePainted } from "../painted.tsx";
import { useNow, useStatus } from "../useStatus.ts";
import { baseFee, duration } from "../format.ts";
import { useBlocks } from "../stats.ts";
import { Icon } from "./Icon.tsx";
import { SearchBox } from "./SearchBox.tsx";

export const FOOTER_LINE = "This explorer reads Canton as the chain's reader party, which is shown the record of every block and nothing else on Canton.";
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

/** The thin bar at the top: whether the checks pass, the newest final block, the block being proven, and the chain. It says only what the status says. */
function TopBar({ status: s }: { status: ApiStatus }) {
  const now = useNow();
  const checks = s.starting && !s.problems.length ? "Starting" : s.problems.length ? "A check failed" : s.ok ? "All checks ok" : "Checks not complete";
  // The base fee is the newest final block's: the list route carries it, so the bar reads one block.
  const newest = useBlocks(1, false, usePainted());
  const fee = newest.isError ? "Base fee cannot be read right now" : newest.data ? (newest.data.items[0] ? `Base fee ${baseFee(newest.data.items[0].baseFee)}` : "Base fee: no block yet") : "Base fee reading…";
  const tone = s.ok ? "ok" : s.starting && !s.problems.length ? "off" : "bad";
  return (
    <section className="topbar" aria-label="Chain at a glance">
      <span className={`sd ${tone}`}><i />{checks}</span>
      {s.final && <span>Final block <Link className="num" to={`/block/${s.final.number}`}>{s.final.number}</Link> · {duration(now - Date.parse(s.final.recordTime))} ago</span>}
      {s.proving && <span>Being proven <Link className="num" to={`/block/${s.proving.number}`}>block {s.proving.number}</Link></span>}
      <span>{fee}</span>
      <span>Chain {s.chainId} · coin {s.coin.symbol}</span>
      {s.networkName && <span className="topbar-end">{s.coin.symbol} is a test coin. It has no value.</span>}
    </section>
  );
}

/** The header every page has, and the line every page ends with. */
export function Shell({ children }: { children: ReactNode }) {
  return <PaintedProvider><ShellBody>{children}</ShellBody></PaintedProvider>;
}

function ShellBody({ children }: { children: ReactNode }) {
  const status = useStatus().data;
  const home = useLocation().pathname === "/";
  return (
    <div className="page">
      {status && <TopBar status={status} />}
      <header className="top">
        <Link className="brand" to="/">
          <span className="mark" role="img" aria-label="Rome" />
          <span className="name">{status?.chainName ?? DEFAULT_NAME}</span>
          {status?.networkName && <span className="pill">{status.networkName}</span>}
        </Link>
        <nav className="nav" aria-label="Pages">
          {NAV.filter(([, , built]) => built).map(([to, label]) => <NavLink key={to} to={to} end={to === "/"} className="navlink">{label}</NavLink>)}
        </nav>
        {!home && <SearchBox />}
      </header>
      <div className="thread" />
      <main className="main">{children}</main>
      <footer className="foot"><Icon name="lock" size={13} /><span>{FOOTER_LINE}</span></footer>
    </div>
  );
}

import type { ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import type { ApiStatus } from "../api.ts";
import { useNow, useStatus } from "../useStatus.ts";
import { duration } from "../format.ts";
import { Icon } from "./Icon.tsx";
import { SearchBox } from "./SearchBox.tsx";

export const FOOTER_LINE = "This explorer reads Canton as the chain's reader party, which is shown the record of every block and nothing else on Canton.";
/** Shown until the server has said what the chain is called. */
const DEFAULT_NAME = "Ostia";

/** The pages of the header, in the order of the approved screens. */
export const NAV = [
  ["/", "Home"], ["/blocks", "Blocks"], ["/txs", "Transactions"], ["/contracts", "Contracts"], ["/tokens", "Tokens"],
  ["/canton", "Canton"], ["/stats", "Stats"], ["/faucet", "Faucet"], ["/docs/api", "API"],
] as const;

/** The thin bar at the top: whether the checks pass, the newest final block, the block being proven, and the chain. It says only what the status says. */
function TopBar({ status: s }: { status: ApiStatus }) {
  const now = useNow();
  const checks = s.starting && !s.problems.length ? "Starting" : s.problems.length ? "A check failed" : s.ok ? "All checks ok" : "Checks not complete";
  const tone = s.ok ? "ok" : s.starting && !s.problems.length ? "off" : "bad";
  return (
    <div className="topbar" aria-label="Chain at a glance">
      <span className={`sd ${tone}`}><i />{checks}</span>
      {s.final && <span>Final block <Link className="num" to={`/block/${s.final.number}`}>{s.final.number}</Link> · {duration(now - Date.parse(s.final.recordTime))} ago</span>}
      {s.proving && <span>Being proven <Link className="num" to={`/block/${s.proving.number}`}>block {s.proving.number}</Link></span>}
      <span className="topbar-end">Chain {s.chainId} · coin {s.coin.symbol}</span>
    </div>
  );
}

/** The header every page has, and the line every page ends with. */
export function Shell({ children }: { children: ReactNode }) {
  const status = useStatus().data;
  const home = useLocation().pathname === "/";
  return (
    <div className="page">
      {status && <TopBar status={status} />}
      <header className="top">
        <Link className="brand" to="/">
          <span className="mark" role="img" aria-label="Rome" />
          <span className="name">{status?.chainName ?? DEFAULT_NAME}</span>
          {status && <span className="pill mono">chain {status.chainId}</span>}
        </Link>
        <nav className="nav" aria-label="Pages">
          {NAV.map(([to, label]) => <NavLink key={to} to={to} end={to === "/"} className="navlink">{label}</NavLink>)}
        </nav>
        {!home && <SearchBox />}
      </header>
      <div className="thread" />
      <main className="main">{children}</main>
      <footer className="foot"><Icon name="lock" size={13} /><span>{FOOTER_LINE}</span></footer>
    </div>
  );
}

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Link, useLocation } from "react-router-dom";
import type { ApiStatus } from "../api.ts";
import { PaintedProvider, usePainted } from "../painted.tsx";
import { useHealth, useNow, useStatus } from "../useStatus.ts";
import { DOCS_URL, FOOTER_LINE, ISSUES_URL, SOURCE_URL } from "../copy.ts";
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
  ["/canton", "External calls", true], ["/stats", "Stats", true], ["/bridge", "Bridge", true], ["/faucet", "Faucet", true], ["/docs/api", "API", true],
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

/** Pages outside the header that still have a name of their own in the tab. */
const OTHER_PAGES = ["about", "twins", "swaps", "swap", "legs", "leg", "search", "address", "addresses"];
/** The tab's title: "Bridge · Ostia DevNet". On the signing page it also says which site is asking. A page of one item ("/block/12") is named in the singular. */
export function pageTitle(pathname: string, name: string, network: string | null): string {
  const site = network ? `${name} ${network}` : name;
  const [, first = "", ...rest] = pathname.split("/");
  const listed = NAV.find(([to]) => to === parentPath(pathname))?.[1];
  const label = listed && listed !== "Home" ? (rest.length > 0 && first !== "docs" ? listed.replace(/s$/, "") : listed) : OTHER_PAGES.includes(first) ? first[0]!.toUpperCase() + first.slice(1) : null;
  return label ? `${label} · ${site}` : site;
}

/**
 * The words for the checks. With the list /api/health serves, the count is that list's, less the API's own rows (see TopBar): "All 16 checks ok", or how many of them are not ok. Without it (the route
 * did not answer) the status's own word stands, with no count, because none is known.
 */
function checksText(s: ApiStatus, checks: ReadonlyArray<{ status: string }> | undefined): ReactNode {
  if (s.starting && !s.problems.length) return "Starting";
  const bad = checks?.filter((c) => c.status !== "ok").length ?? 0;
  if (checks && bad) return <b>{bad} of {checks.length} checks not ok</b>;
  if (s.problems.length) return "A check failed";
  if (!s.ok) return "Checks not complete";
  return checks ? <b>All {checks.length} checks ok</b> : "All checks ok";
}

/** The thin bar at the top: whether the checks pass, the newest final block, the block being proven, and the chain. It says only what the status says. The values are bold; on a phone only the first two stay. */
function TopBar({ status: s }: { status: ApiStatus }) {
  const now = useNow();
  const painted = usePainted();
  // The count is of the checks the indexer writes, the rows /api/status counts too (it leaves out the API's own rows: the faucet, the tracker and each instance's reads), so the bar and the home page never disagree.
  const checks = useHealth(painted).data?.checks.filter((c) => c.role !== "api");
  // The base fee is the newest final block's: the list route carries it, so the bar reads one block.
  const newest = useBlocks(1, false, painted);
  const fee = newest.isError ? "Base fee cannot be read right now" : newest.data ? (newest.data.items[0] ? <>Base fee <b>{baseFee(newest.data.items[0].baseFee)}</b></> : "Base fee: no block yet") : "Base fee reading…";
  const tone = s.ok && !checks?.some((c) => c.status !== "ok") ? "ok" : s.ok ? "bad" : s.starting && !s.problems.length ? "off" : "bad";
  return (
    <section className="topbar" aria-label="Chain at a glance">
      <span className={`sd ${tone}`}><i />{checksText(s, checks)}</span>
      {s.final && <span>Final block <b><Link className="num" to={`/block/${s.final.number}`}>{s.final.number}</Link></b> · {duration(now - Date.parse(s.final.recordTime))} ago</span>}
      {s.proving && <span className="sd warn tb-wide"><i /><span>Being proven <b><Link className="num" to={`/block/${s.proving.number}`}>block {s.proving.number}</Link></b></span></span>}
      <span className="tb-wide">{fee}</span>
      <span className="tb-wide">Chain <b>{s.chainId}</b> · coin <b>{s.coin.symbol}</b></span>
      {s.networkName && <span className="topbar-end tb-wide">{s.coin.symbol} is a test coin. It has no value.</span>}
    </section>
  );
}

/** Room left over, in px, that the header keeps beyond what its parts need before the links are drawn inline: sub-pixel rounding must never put the last link on a second row. */
const FIT_SLACK = 1;

/**
 * True when the header's parts (the name, every link, and the search box at its compact width) do not fit on one row, so the links are folded into the menu button.
 * It measures each part's own width, which does not depend on whether the links are folded, so it cannot flip back and forth, and it stays right when a link is added or a font loads:
 * the header, the name and every link are watched, and the check runs again when any of them changes size.
 */
function useFolded(header: RefObject<HTMLElement | null>, deps: readonly unknown[]): boolean {
  const [folded, setFolded] = useState(false);
  useLayoutEffect(() => {
    const el = header.current;
    if (!el) return;
    const check = () => {
      const css = getComputedStyle(el);
      const gap = parseFloat(css.columnGap) || 0;
      const room = el.clientWidth - (parseFloat(css.paddingLeft) || 0) - (parseFloat(css.paddingRight) || 0);
      const links = [...el.querySelectorAll<HTMLElement>(".nav .navlink")];
      const navGap = parseFloat(getComputedStyle(el.querySelector(".nav")!).columnGap) || 0;
      const nav = links.reduce((n, a) => n + a.offsetWidth, 0) + navGap * Math.max(0, links.length - 1);
      const others = [...el.querySelectorAll<HTMLElement>(".brand, .search-slot")];
      const need = others.reduce((n, a) => n + a.offsetWidth, 0) + nav + gap * others.length;
      setFolded(need + FIT_SLACK > room);
    };
    check();
    const watch = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(check);
    watch?.observe(el);
    for (const a of el.querySelectorAll(".brand, .nav .navlink")) watch?.observe(a);
    void document.fonts?.ready.then(check);
    return () => watch?.disconnect();
  }, deps);
  return folded;
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
  // Above a phone the links share the header's row with the name and the search box; when they do not fit there, they fold into the same menu button (useFolded).
  const header = useRef<HTMLElement>(null);
  const folded = useFolded(header, [home, status?.chainName, status?.networkName]);
  useEffect(() => { if (!folded) setMenu(false); }, [folded]);
  // A link to a part of a page (the footer's wallet link) scrolls there once the page has drawn it, and again as the sections above it fill in
  // during the next two seconds, unless the reader has started to scroll.
  useEffect(() => {
    // A page opens at its top: following a link at the bottom of a long page must not land at the bottom of the next one.
    if (!hash) { window.scrollTo?.(0, 0); return; }
    const id = hash.slice(1);
    const go = () => document.getElementById(id)?.scrollIntoView?.();
    go();
    const watch = new MutationObserver(go);
    watch.observe(document.body, { childList: true, subtree: true });
    const stop = () => watch.disconnect();
    const timer = setTimeout(stop, 2000);
    for (const ev of ["wheel", "touchstart", "pointerdown", "keydown"]) window.addEventListener(ev, stop, { once: true, passive: true });
    return () => { stop(); clearTimeout(timer); for (const ev of ["wheel", "touchstart", "pointerdown", "keydown"]) window.removeEventListener(ev, stop); };
  }, [pathname, hash]);
  const name = status?.chainName ?? DEFAULT_NAME;
  const title = pageTitle(pathname, name, status?.networkName ?? null);
  useEffect(() => { document.title = title; }, [title]);
  return (
    <div className="page">
      {status && <TopBar status={status} />}
      <header ref={header} className={`top${home ? " home" : ""}${folded ? " folded" : ""}`}>
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
          <Link to="/about">About</Link>
          <Link to="/docs/api">API</Link>
          <a href="/api/health">Health</a>
          {status?.publicRpc && <Link to="/docs/api#rpc-h">Add {name} to your wallet</Link>}
          <a href={DOCS_URL} target="_blank" rel="noopener noreferrer">Docs</a>
          <a href={ISSUES_URL} target="_blank" rel="noopener noreferrer">Get help</a>
          <a href={SOURCE_URL}>Source code</a>
        </nav>
      </footer>
    </div>
  );
}

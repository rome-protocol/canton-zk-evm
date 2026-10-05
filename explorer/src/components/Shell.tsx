import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useStatus } from "../useStatus.ts";
import { Icon } from "./Icon.tsx";

export const FOOTER_LINE = "This explorer reads Canton as the chain's reader party, which is shown the record of every block and nothing else on Canton.";
/** Shown until the server has said what the chain is called. */
const DEFAULT_NAME = "Ostia";
const PHONE = "(max-width: 720px)";
const HINT = "Block number, transaction or block hash, address, or Canton update id";
const SHORT_HINT = "Block, transaction, address or Canton update";

/** True at phone width, where the search box sits under the name and has room for a shorter hint. */
function usePhone(): boolean {
  const query = typeof window !== "undefined" && window.matchMedia ? window.matchMedia(PHONE) : null;
  const [phone, setPhone] = useState(query?.matches ?? false);
  useEffect(() => {
    if (!query) return;
    const change = () => setPhone(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  return phone;
}

/** The search box. It sends what was typed to the search page, which asks the server what it is and opens it, so that a search is also a link. */
function SearchBox() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const shown = pathname === "/search" ? params.get("q") ?? "" : "";
  const phone = usePhone();
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  function submit(e: FormEvent) {
    e.preventDefault();
    const q = text.trim();
    if (q) navigate(`/search?q=${encodeURIComponent(q)}`);
  }
  return (
    <form className="search" role="search" onSubmit={submit}>
      <Icon name="search" />
      <input type="search" aria-label="Search" placeholder={phone ? SHORT_HINT : HINT} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} autoComplete="off" />
    </form>
  );
}

/** The header every page has, and the line every page ends with. */
export function Shell({ children }: { children: ReactNode }) {
  const status = useStatus().data;
  return (
    <div className="page">
      <header className="top">
        <Link className="brand" to="/">
          <span className="mark" role="img" aria-label="Rome" />
          <span className="name">{status?.chainName ?? DEFAULT_NAME}</span>
          {status && <span className="pill mono">chain {status.chainId}</span>}
        </Link>
        <SearchBox />
        <Link className="navlink" to="/faucet">Faucet</Link>
      </header>
      <div className="thread" />
      <main className="main">{children}</main>
      <footer className="foot"><Icon name="lock" size={13} /><span>{FOOTER_LINE}</span></footer>
    </div>
  );
}

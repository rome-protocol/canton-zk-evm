import { useEffect, useRef, useState, type FormEvent } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Icon } from "./Icon.tsx";

const PHONE = "(max-width: 720px)";
const HINT = "Search by block number, transaction or block hash, address, or Canton update id";
const SHORT_HINT = "Block, transaction, address or Canton update";
/** The header's box is narrower than the home page's, and says the same in fewer words. */
const HEADER_HINT = "Block, transaction, address or Canton update id";
/** At phone width the header's box is under the name and is no wider than the screen (328 px at 360), so its hint is shorter still. */
const HEADER_SHORT_HINT = "Block, tx, address or Canton update";

/** True where a typed "/" belongs to the field the person is typing in. */
function typing(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}

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

/** The search box, in the header or (with `hero`) big, with a button, on the home page. It sends what was typed to the search page, which asks the server what it is and opens it, so that a search is also a link. */
export function SearchBox({ hero = false }: { hero?: boolean }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const shown = pathname === "/search" ? params.get("q") ?? "" : "";
  const phone = usePhone();
  const input = useRef<HTMLInputElement>(null);
  // "/" focuses the search box from anywhere that is not a field, as on GitHub.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || typing(e.target)) return;
      e.preventDefault();
      input.current?.focus();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  function submit(e: FormEvent) {
    e.preventDefault();
    const q = text.trim();
    if (q) navigate(`/search?q=${encodeURIComponent(q)}`);
  }
  const form = (
    <form className={`search${hero ? " hero-search" : ""}`} role="search" aria-label="Search" onSubmit={submit}>
      <Icon name="search" />
      <input ref={input} type="search" aria-label="Search" placeholder={hero ? (phone ? SHORT_HINT : HINT) : phone ? HEADER_SHORT_HINT : HEADER_HINT} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={hero ? undefined : (e) => { if (e.key === "Escape") e.currentTarget.blur(); }} spellCheck={false} autoComplete="off" />
      {hero ? <button type="submit" className="btn">Search</button> : <kbd className="kbd" aria-hidden="true">/</kbd>}
    </form>
  );
  // The header's box sits in a slot of its own width: it opens wider on focus over the slot's side, so the links never move.
  return hero ? form : <div className="search-slot">{form}</div>;
}


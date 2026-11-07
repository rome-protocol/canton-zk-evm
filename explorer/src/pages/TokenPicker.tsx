import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "../components/Icon.tsx";
import { Info } from "../components/Info.tsx";
import { factsOf, groupsOf, search, type Pair, type Token } from "../bridge/tokens.ts";

/**
 * One list of tokens in two groups ("On Ostia", "On Canton"), a search box, and an i per token with its facts. It offers only the tokens it is given. Escape or the Close button closes it.
 */
export function TokenPicker({ pairs, chainName, selected, onPick, onClose }: { pairs: Pair[]; chainName: string; selected: string | null; onPick: (t: Token) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const title = useId();
  const box = useRef<HTMLInputElement>(null);
  // The search box is focused once, when the picker opens. The card draws again every few seconds (balances) and hands a new onClose each time: that must not pull the focus back, which would
  // reopen a phone's keyboard and close an open token note.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => { box.current?.focus(); }, []);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") close.current(); };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, []);
  const groups = groupsOf(pairs);
  const shown = [{ name: `On ${chainName}`, rows: search(groups.ostia, pairs, query) }, { name: "On Canton", rows: search(groups.canton, pairs, query) }];
  const none = shown.every((g) => g.rows.length === 0);
  return (
    <div className="picker-back" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="picker card" role="dialog" aria-modal="true" aria-labelledby={title}>
        <div className="picker-h"><h2 id={title}>Choose a token</h2><button type="button" className="icon-b" aria-label="Close" onClick={onClose}><Icon name="cross" size={14} /></button></div>
        <label className="picker-s"><Icon name="search" size={14} /><input ref={box} type="search" aria-label="Search tokens" placeholder="Search by name or address" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
        {shown.map((g) => g.rows.length === 0 ? null : (
          <section key={g.name} aria-label={g.name}>
            <h3 className="picker-g">{g.name}</h3>
            <ul className="picker-l">
              {g.rows.map((t) => { const where = g.name.replace(/^On /, "on "); return (
                <li key={t.key} className={t.key === selected ? "on" : undefined}>
                  <button type="button" className="pick" aria-label={`${t.symbol} ${where}`} onClick={() => onPick(t)}><b>{t.symbol}</b><span className="muted small">{where}</span></button>
                  <Info about={`${t.symbol} ${where}`}>
                    <dl className="tok-facts">{factsOf(t, pairs, chainName).map((f) => <div key={f.label}><dt>{f.label}</dt><dd className={f.label === "Address" || f.label === "Token id" || f.label.endsWith("address") ? "mono" : undefined}>{f.value}</dd></div>)}</dl>
                  </Info>
                </li>
              ); })}
            </ul>
          </section>
        ))}
        {none && <p className="muted" role="status">No token matches.</p>}
      </div>
    </div>
  );
}

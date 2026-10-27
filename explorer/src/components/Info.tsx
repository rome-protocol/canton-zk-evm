import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** The gap the note keeps to each edge of the screen. */
const EDGE = 8;

/**
 * A small "i" that holds the sentence a card does not need to say outright. The note shows on hover, on keyboard focus and on a tap, and a screen
 * reader reads it with the button (aria-describedby). `about` is what the note is about: the button's name is "About <about>". Escape, a second tap
 * or a tap elsewhere closes it, and it stays closed until the pointer and the focus have left the i (WCAG 1.4.13). The note is moved sideways, when
 * it has to be, so that it sits inside the screen wherever the i is.
 */
export function Info({ about, children }: { about: string; children: ReactNode }) {
  const id = useId();
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [tapped, setTapped] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const note = useRef<HTMLSpanElement>(null);
  const shown = !dismissed && (hover || focus || tapped);
  // Once pointer and focus are both gone the i starts afresh, so the next hover or focus shows the note again.
  useEffect(() => { if (!hover && !focus) { setDismissed(false); setTapped(false); } }, [hover, focus]);
  useEffect(() => {
    if (!shown) return;
    const away = (e: Event) => { if (!box.current?.contains(e.target as Node)) { setTapped(false); setDismissed(true); } };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [shown]);
  useLayoutEffect(() => {
    const n = note.current;
    if (!n) return;
    n.style.transform = "";
    if (!shown) return;
    const r = n.getBoundingClientRect(), w = document.documentElement.clientWidth;
    if (r.width === 0 || w === 0) return;
    const dx = r.left < EDGE ? EDGE - r.left : r.right > w - EDGE ? w - EDGE - r.right : 0;
    if (dx !== 0) n.style.transform = `translateX(${Math.round(dx)}px)`;
  }, [shown]);
  const close = () => { setTapped(false); setDismissed(true); };
  return (
    <span className={`info${shown ? " open" : ""}`} ref={box} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} onKeyDown={(e) => { if (e.key === "Escape" && shown) close(); }}>
      <button type="button" className="info-b" aria-label={`About ${about}`} aria-describedby={id} aria-expanded={shown} onFocus={() => setFocus(true)} onBlur={() => setFocus(false)} onClick={() => { if (shown && tapped) close(); else if (shown) setTapped(true); else { setDismissed(false); setTapped(true); } }}><span aria-hidden="true">i</span></button>
      <span className="info-t" role="tooltip" id={id} ref={note}>{children}</span>
    </span>
  );
}

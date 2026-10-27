import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** The gap the note keeps to each edge of the screen. */
const EDGE = 8;
/** The gap between the i and its note. */
const GAP = 8;

/**
 * A small "i" that holds the sentence a card does not need to say outright. The note shows on hover, on keyboard focus and on a tap, and a screen
 * reader reads it with the button (aria-describedby). `about` is what the note is about: the button's name is "About <about>". Escape, a second tap
 * or a tap elsewhere closes it (Escape works wherever the focus is, so a note opened by the pointer alone closes too), and it stays closed until
 * the pointer and the focus have left the i (WCAG 1.4.13). The note is fixed to the screen, so a card that clips what overflows it (overflow: hidden) cannot cut it, and
 * is placed from the i's box: below it, or above it when there is no room below, and moved sideways so that it sits inside the screen.
 */
export function Info({ about, children }: { about: string; children: ReactNode }) {
  const id = useId();
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [tapped, setTapped] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const note = useRef<HTMLSpanElement>(null);
  const shown = !dismissed && (hover || focus || tapped);
  // Once pointer and focus are both gone the i starts afresh, so the next hover or focus shows the note again.
  useEffect(() => { if (!hover && !focus) { setDismissed(false); setTapped(false); } }, [hover, focus]);
  const close = () => { setTapped(false); setDismissed(true); };
  useEffect(() => {
    if (!shown) return;
    const away = (e: Event) => { const t = e.target as Node; if (!box.current?.contains(t)) close(); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", esc); };
  }, [shown]);
  useLayoutEffect(() => {
    const n = note.current, b = button.current;
    if (!n || !b || !shown) return;
    const place = () => {
      const w = document.documentElement.clientWidth, h = document.documentElement.clientHeight;
      const nr = n.getBoundingClientRect(), br = b.getBoundingClientRect();
      if (nr.width === 0 || w === 0) return;
      const left = Math.max(EDGE, Math.min(br.right + EDGE - nr.width, w - EDGE - nr.width));
      let top = br.bottom + GAP;
      if (h > 0 && top + nr.height > h - EDGE && br.top - GAP - nr.height >= EDGE) top = br.top - GAP - nr.height;
      n.style.left = `${Math.round(left)}px`;
      n.style.top = `${Math.round(top)}px`;
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => { window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); };
  }, [shown]);
  return (
    <span className={`info${shown ? " open" : ""}`} ref={box} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <button type="button" className="info-b" ref={button} aria-label={`About ${about}`} aria-describedby={id} aria-expanded={shown} onFocus={() => setFocus(true)} onBlur={() => setFocus(false)} onClick={() => { if (shown && tapped) close(); else if (shown) setTapped(true); else { setDismissed(false); setTapped(true); } }}><span aria-hidden="true">i</span></button>
      <span className={`info-t${shown ? " open" : ""}`} role="tooltip" id={id} ref={note}>{children}</span>
    </span>
  );
}

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/**
 * A small "i" that holds the sentence a card does not need to say outright. The note shows on hover, on keyboard focus and on a tap, and a screen reader
 * reads it with the button (aria-describedby). `about` is what the note is about: the button's name is "About <about>". Escape or a tap elsewhere closes it.
 */
export function Info({ about, children }: { about: string; children: ReactNode }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  return (
    <span className={`info${open ? " open" : ""}`} ref={box} onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}>
      <button type="button" className="info-b" aria-label={`About ${about}`} aria-describedby={id} aria-expanded={open} onClick={() => setOpen((o) => !o)}><span aria-hidden="true">i</span></button>
      <span className="info-t" role="tooltip" id={id}>{children}</span>
    </span>
  );
}

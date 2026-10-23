import type { ReactNode } from "react";
/** A small switch between a few views of the same thing: one button is pressed. */
export function Seg<T extends string>({ label, value, options, onPick }: { label: string; value: T; options: { id: T; text: ReactNode; title?: string }[]; onPick: (id: T) => void }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => <button key={o.id} type="button" title={o.title} aria-pressed={o.id === value} onClick={() => onPick(o.id)}>{o.text}</button>)}
    </div>
  );
}

import type { ReactNode } from "react";

/** A list of facts: a label and its value, row by row. At phone width the value sits under its label. */
export function Kv({ children, wide = false, label }: { children: ReactNode; wide?: boolean; label?: string }) {
  return <dl className={`kv${wide ? " wide" : ""}`} aria-label={label}>{children}</dl>;
}

export function Item({ label, children }: { label: string; children: ReactNode }) {
  return <><dt className="kv-k">{label}</dt><dd className="kv-v">{children}</dd></>;
}

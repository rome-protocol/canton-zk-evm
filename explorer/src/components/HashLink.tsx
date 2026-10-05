import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { party, short, shortUpdate } from "../format.ts";
import { Icon } from "./Icon.tsx";

/** Copies to the clipboard. Where the browser keeps the clipboard from a page (an address that is not secure), it falls back to selecting a hidden field. */
async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const field = document.createElement("textarea");
    field.value = value;
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.append(field);
    field.select();
    const done = document.execCommand("copy");
    field.remove();
    return done;
  }
}

/** A button that copies a value, and says so for a moment. */
export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button type="button" className="copy" aria-label={copied ? "Copied" : label} onClick={async () => {
      if (!(await copyText(value))) return;
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    }}><Icon name={copied ? "check" : "copy"} size={13} /></button>
  );
}

interface Props {
  value: string;
  /** Where the shortened value leads. With none, it is text. */
  to?: string;
  /** A Canton update id and a Canton party id are each shortened their own way. */
  kind?: "hash" | "update" | "party";
  /** Shown in full from the start, as a page's own hash is. Otherwise a button shows it in full. */
  full?: boolean;
  /** Ten characters and eight instead of six and four: for the hash a page is about. */
  long?: boolean;
}

/** A hash or an id, shortened, with a button to copy the whole value and one to read it in full. */
export function HashLink({ value, to, kind = "hash", full = false, long = false }: Props) {
  const [open, setOpen] = useState(full);
  const text = open ? value : kind === "update" ? shortUpdate(value) : kind === "party" ? party(value) : long ? short(value, 10, 8) : short(value);
  const body = <span className={`mono${open ? " wrap" : ""}`}>{text}</span>;
  return (
    <span className="hl">
      {to ? <Link className="hx" to={to}>{body}</Link> : <span className="hx">{body}</span>}
      <CopyButton value={value} />
      {!full && <button type="button" className="copy" aria-label={open ? "Show shortened" : "Show in full"} onClick={() => setOpen(!open)}><Icon name="expand" size={13} /></button>}
    </span>
  );
}

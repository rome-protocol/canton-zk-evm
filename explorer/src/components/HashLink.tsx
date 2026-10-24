import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { party, short, shortUpdate } from "../format.ts";
import { Icon } from "./Icon.tsx";

/** Copies to the clipboard. Where the browser keeps the clipboard from a page (an address that is not secure), it falls back to selecting a hidden field. */
export async function copyText(value: string): Promise<boolean> {
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
  /** Ten characters and eight instead of six and four (an update id: twelve and eight): for the hash a page is about. */
  long?: boolean;
  /** How many characters to keep at the start and at the end, where a screen shows a hash its own way. They win over `long` and `plain`. */
  lead?: number;
  tail?: number;
  /** For a row in a list: the shortened value and nothing else, as the list screens show it ("0x1105282d…7abfe4": 0x and eight, then six). The copy and expand buttons belong in the header of a detail page, which is the default. */
  plain?: boolean;
}

/** A hash or an id, shortened, with a button to copy the whole value and one to read it in full. */
export function HashLink({ value, to, kind = "hash", full = false, long = false, lead, tail, plain = false }: Props) {
  const [open, setOpen] = useState(full);
  const text = open ? value : kind === "party" ? party(value) : kind === "update" ? shortUpdate(value, lead ?? (long ? 12 : 8), tail ?? (long ? 8 : 4)) : short(value, lead ?? (long ? 10 : plain ? 10 : 6), tail ?? (long ? 8 : plain ? 6 : 4));
  const body = <span className={`mono${open ? " wrap" : ""}`}>{text}</span>;
  return (
    <span className="hl">
      {to ? <Link className="hx" to={to} title={open ? undefined : value}>{body}</Link> : <span className="hx" title={open ? undefined : value}>{body}</span>}
      {!plain && <CopyButton value={value} />}
      {!plain && !full && <button type="button" className="copy" aria-label={open ? "Show shortened" : "Show in full"} onClick={() => setOpen(!open)}><Icon name="expand" size={13} /></button>}
    </span>
  );
}

import { useMemo } from "react";
import { DOCS_URL, ISSUES_URL } from "../copy.ts";

/** A link that leaves the site: it opens in its own tab and says nothing to the other page about this one. */
export const OutLink = ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;

/** The small line of a page where a visitor may need a hand: the docs, and where to ask. */
export const HelpLine = () => <p className="small muted help">Need help? <OutLink href={DOCS_URL}>Read the docs</OutLink> or <OutLink href={ISSUES_URL}>open an issue</OutLink>.</p>;

/** The time to quote in a report, to the minute, in UTC: "2026-11-11 14:05 UTC". */
export const reportTime = (at: Date = new Date()): string => `${at.toISOString().slice(0, 10)} ${at.toISOString().slice(11, 16)} UTC`;

/** Under an error: where to go next, with the time of the error to put in a report. The time is taken when the error first shows. */
export function StillStuck() {
  const at = useMemo(() => reportTime(), []);
  return <p className="small muted help">Still stuck? <OutLink href={ISSUES_URL}>Open an issue</OutLink> and quote {at}, or <OutLink href={DOCS_URL}>read the docs</OutLink>.</p>;
}

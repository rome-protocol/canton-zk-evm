import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { explorerHref, inApp } from "../bridge-app/where.ts";
import { Icon } from "./Icon.tsx";

/**
 * A link from a Bridge page to a page of the explorer. In the explorer it is the router's own link; in the Bridge's own site, where the explorer is another site, it is a plain
 * link to the explorer's address that opens in a new tab and carries the outside-link mark (a 44 px target on a phone, see app.css).
 */
export function ExplorerLink({ to, className, children }: { to: string; className?: string; children: ReactNode }) {
  if (!inApp()) return <Link to={to} className={className}>{children}</Link>;
  return (
    <a href={explorerHref(to)} target="_blank" rel="noopener" className={className ? `${className} out` : "out"}>
      {children}<Icon name="out" size={12} />
    </a>
  );
}

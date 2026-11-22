import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { bridgeHref, bridgeOrigin } from "../bridge-app/where.ts";
import { Icon } from "./Icon.tsx";

/**
 * A link from the explorer to the Bridge. While the Bridge is a page of the explorer (no VITE_BRIDGE_ORIGIN) it is the router's link to /bridge. Once the Bridge has its own site it is a
 * plain link to that site that opens in a new tab and carries the outside-link mark.
 */
export function BridgeLink({ className, search = "", children }: { className?: string; search?: string; children: ReactNode }) {
  if (bridgeOrigin() === null) return <Link to={`/bridge${search}`} className={className}>{children}</Link>;
  return (
    <a href={bridgeHref(search)} target="_blank" rel="noopener" className={className ? `${className} out` : "out"}>
      {children}<Icon name="out" size={12} />
    </a>
  );
}

import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { bridgeHref, bridgeOrigin } from "../bridge-app/where.ts";
import type { StoreLike } from "../bridge/moves/state.ts";
import { BridgeLink } from "../components/BridgeLink.tsx";
import { LoadingCard } from "../components/Cards.tsx";

/**
 * The explorer's /bridge address. While the Bridge is a page of the explorer (no VITE_BRIDGE_ORIGIN) it is that page, as it was. Once the Bridge has its own site, the address sends the visitor there,
 * with the query and the hash kept, so /bridge?tab=other-chains lands on the same view: unless this browser keeps a move that is not over. Storage belongs to one site, so the Bridge site cannot see
 * that move; the page then shows here as it was, with a line that says where the Bridge is now. The check's code is fetched only when the Bridge has its own site, so the explorer's first load does not carry it. If that code cannot be fetched or run, the page shows here as it was, with the line, and does not send the visitor away.
 */
export function BridgeMoved({ children, store, go = (to: string) => window.location.replace(to) }: { children: ReactNode; store?: StoreLike | null; go?: (to: string) => void }) {
  const { search, hash } = useLocation();
  const origin = bridgeOrigin();
  const [keeps, setKeeps] = useState<boolean | null>(null);
  useEffect(() => {
    if (origin === null) return;
    let live = true;
    void Promise.all([import("../bridge/unfinished.ts"), import("../bridge/moves/state.ts")]).then(([u, s]) => {
      if (live) setKeeps(u.hasUnfinished(store === undefined ? s.moveStore() : store));
    }).catch(() => { if (live) setKeeps(true); });
    return () => { live = false; };
  }, [origin, store]);
  useEffect(() => { if (origin !== null && keeps === false) go(bridgeHref(search) + hash); }, [origin, keeps, search, hash, go]);
  if (origin === null) return <>{children}</>;
  if (keeps !== true) return <LoadingCard>Opening the Bridge…</LoadingCard>;
  return (
    <>
      <p className="moved-line small" role="status">The Bridge has its own site now. Moves you started on this page finish here. <BridgeLink search={search}>Open the Bridge</BridgeLink></p>
      {children}
    </>
  );
}

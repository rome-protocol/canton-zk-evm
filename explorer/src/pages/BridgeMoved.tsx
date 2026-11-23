import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { bridgeHref, bridgeOrigin } from "../bridge-site.ts";
import { LoadingCard } from "../components/Cards.tsx";

/** The explorer's /bridge address: it sends the visitor to the same view on the Bridge site, with the query and the hash kept. A build with no Bridge origin (a local run) has nowhere to send them and says so. */
export function BridgeMoved({ go = (to: string) => window.location.replace(to) }: { go?: (to: string) => void }) {
  const { search, hash } = useLocation();
  const origin = bridgeOrigin();
  useEffect(() => { if (origin !== null) go(bridgeHref(search) + hash); }, [origin, search, hash, go]);
  if (origin === null) return <section className="card nf"><h1>The Bridge is its own site</h1><p>This build has no address for it.</p></section>;
  return <LoadingCard>Opening the Bridge…</LoadingCard>;
}

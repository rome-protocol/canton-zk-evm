import { lazy, Suspense, useState, type ComponentType } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { LoadingCard, NoPage } from "./components/Cards.tsx";
import { Shell } from "./components/Shell.tsx";
import { Home } from "./pages/Home.tsx";

const loads: (() => Promise<unknown>)[] = [];
/** A page that is fetched when its route is first visited, so a page's script is not carried by the pages that do not use it. One loaded ahead of its first draw (see `loadPages`) is drawn at once, with no gap. The app does not keep a failed fetch, so a later visit asks again; a browser may still fail the same address on its own, and the error card's "Reload it" is the way out then. */
function page(load: () => Promise<Record<string, unknown>>, name: string): ComponentType {
  let drawn: ComponentType | undefined, loading: Promise<ComponentType> | undefined;
  const get = () => (loading ??= load().then((m) => (drawn = m[name] as ComponentType), (e: unknown) => { loading = undefined; throw e; }));
  loads.push(get);
  return function Page() {
    const [Ready] = useState(() => drawn);
    const [Fetched] = useState(() => lazy(() => get().then((component) => ({ default: component }))));
    return Ready ? <Ready /> : <Fetched />;
  };
}
/** Fetches every page now. The tests wait for this once, so a page is on the screen as soon as its route is drawn. */
export const loadPages = () => Promise.all(loads.map((get) => get()));

const About = page(() => import("./pages/About.tsx"), "About");
const Address = page(() => import("./pages/Address.tsx"), "Address");
const Addresses = page(() => import("./pages/Addresses.tsx"), "Addresses");
const Contract = page(() => import("./pages/Contract.tsx"), "Contract");
const Contracts = page(() => import("./pages/Contracts.tsx"), "Contracts");
const Blocks = page(() => import("./pages/Blocks.tsx"), "Blocks");
const Block = page(() => import("./pages/Block.tsx"), "Block");
const CantonUpdate = page(() => import("./pages/Canton.tsx"), "CantonUpdate");
const CantonUpdates = page(() => import("./pages/Canton.tsx"), "CantonUpdates");
const Faucet = page(() => import("./pages/Faucet.tsx"), "Faucet");
const Leg = page(() => import("./pages/Leg.tsx"), "Leg");
const Legs = page(() => import("./pages/Legs.tsx"), "Legs");
const Swaps = page(() => import("./pages/Swaps.tsx"), "Swaps");
const SwapPage = page(() => import("./pages/SwapPage.tsx"), "SwapPage");
const Search = page(() => import("./pages/Search.tsx"), "Search");
const ApiDocs = page(() => import("./pages/ApiDocs.tsx"), "ApiDocs");
const Stats = page(() => import("./pages/Stats.tsx"), "Stats");
const Token = page(() => import("./pages/Token.tsx"), "Token");
const Tokens = page(() => import("./pages/Tokens.tsx"), "Tokens");
const Twins = page(() => import("./pages/Twins.tsx"), "Twins");
const Tx = page(() => import("./pages/Tx.tsx"), "Tx");
const Txs = page(() => import("./pages/Txs.tsx"), "Txs");

/** Every route the pages have. A page that does not exist gets its own plain answer, and a page that fails is forgotten as soon as the visitor goes somewhere else. */
export function App() {
  const { key } = useLocation();
  return (
    <Shell>
      <ErrorBoundary key={key}>
        <Suspense fallback={<LoadingCard>Loading…</LoadingCard>}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/blocks" element={<Blocks />} />
          <Route path="/block/:id" element={<Block />} />
          <Route path="/canton" element={<CantonUpdates />} />
          <Route path="/canton/:updateId" element={<CantonUpdate />} />
          <Route path="/swaps" element={<Swaps />} />
          <Route path="/swap/:id" element={<SwapPage />} />
          <Route path="/faucet" element={<Faucet />} />
          <Route path="/addresses" element={<Addresses />} />
          <Route path="/contracts" element={<Contracts />} />
          <Route path="/contract/:addr" element={<Contract />} />
          <Route path="/address/:addr" element={<Address />} />
          <Route path="/tokens" element={<Tokens />} />
          <Route path="/token/:addr" element={<Token />} />
          <Route path="/twins" element={<Twins />} />
          <Route path="/legs" element={<Legs />} />
          <Route path="/leg/:id" element={<Leg />} />
          <Route path="/txs" element={<Txs />} />
          <Route path="/tx/:hash" element={<Tx />} />
          <Route path="/search" element={<Search />} />
          <Route path="/stats" element={<Stats />} />
          <Route path="/about" element={<About />} />
          <Route path="/docs/api" element={<ApiDocs />} />
          <Route path="*" element={<NoPage />} />
        </Routes>
        </Suspense>
      </ErrorBoundary>
    </Shell>
  );
}

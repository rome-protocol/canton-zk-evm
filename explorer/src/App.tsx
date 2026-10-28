import { Route, Routes, useLocation } from "react-router-dom";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { NoPage } from "./components/Cards.tsx";
import { Shell } from "./components/Shell.tsx";
import { About } from "./pages/About.tsx";
import { Address } from "./pages/Address.tsx";
import { Addresses } from "./pages/Addresses.tsx";
import { Contract } from "./pages/Contract.tsx";
import { Contracts } from "./pages/Contracts.tsx";
import { Blocks } from "./pages/Blocks.tsx";
import { Block } from "./pages/Block.tsx";
import { CantonUpdate, CantonUpdates } from "./pages/Canton.tsx";
import { Faucet } from "./pages/Faucet.tsx";
import { Leg } from "./pages/Leg.tsx";
import { Legs } from "./pages/Legs.tsx";
import { Home } from "./pages/Home.tsx";
import { Swaps } from "./pages/Swaps.tsx";
import { SwapPage } from "./pages/SwapPage.tsx";
import { Search } from "./pages/Search.tsx";
import { ApiDocs } from "./pages/ApiDocs.tsx";
import { Stats } from "./pages/Stats.tsx";
import { Token } from "./pages/Token.tsx";
import { Tokens } from "./pages/Tokens.tsx";
import { Tx } from "./pages/Tx.tsx";
import { Txs } from "./pages/Txs.tsx";

/** Every route the pages have. A page that does not exist gets its own plain answer, and a page that fails is forgotten as soon as the visitor goes somewhere else. */
export function App() {
  const { key } = useLocation();
  return (
    <Shell>
      <ErrorBoundary key={key}>
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
      </ErrorBoundary>
    </Shell>
  );
}

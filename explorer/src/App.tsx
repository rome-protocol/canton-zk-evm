import { Route, Routes, useLocation } from "react-router-dom";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { NoPage } from "./components/Cards.tsx";
import { Shell } from "./components/Shell.tsx";
import { Address } from "./pages/Address.tsx";
import { Addresses } from "./pages/Addresses.tsx";
import { Contract } from "./pages/Contract.tsx";
import { Contracts } from "./pages/Contracts.tsx";
import { Blocks } from "./pages/Blocks.tsx";
import { Block } from "./pages/Block.tsx";
import { CantonUpdate, CantonUpdates } from "./pages/Canton.tsx";
import { Faucet } from "./pages/Faucet.tsx";
import { Home } from "./pages/Home.tsx";
import { Search } from "./pages/Search.tsx";
import { ApiDocs } from "./pages/ApiDocs.tsx";
import { Stats } from "./pages/Stats.tsx";
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
          <Route path="/faucet" element={<Faucet />} />
          <Route path="/addresses" element={<Addresses />} />
          <Route path="/contracts" element={<Contracts />} />
          <Route path="/contract/:addr" element={<Contract />} />
          <Route path="/address/:addr" element={<Address />} />
          <Route path="/token/:addr" element={<Address />} />
          <Route path="/txs" element={<Txs />} />
          <Route path="/tx/:hash" element={<Tx />} />
          <Route path="/search" element={<Search />} />
          <Route path="/stats" element={<Stats />} />
          <Route path="/docs/api" element={<ApiDocs />} />
          <Route path="*" element={<NoPage />} />
        </Routes>
      </ErrorBoundary>
    </Shell>
  );
}

import { Route, Routes, useLocation } from "react-router-dom";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { NoPage } from "./components/Cards.tsx";
import { Shell } from "./components/Shell.tsx";
import { Address } from "./pages/Address.tsx";
import { Block } from "./pages/Block.tsx";
import { Faucet } from "./pages/Faucet.tsx";
import { Home } from "./pages/Home.tsx";
import { Search } from "./pages/Search.tsx";
import { Tx } from "./pages/Tx.tsx";

/** Every route the pages have. A page that does not exist gets its own plain answer, and a page that fails is forgotten as soon as the visitor goes somewhere else. */
export function App() {
  const { key } = useLocation();
  return (
    <Shell>
      <ErrorBoundary key={key}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/block/:id" element={<Block />} />
          <Route path="/faucet" element={<Faucet />} />
          <Route path="/address/:addr" element={<Address />} />
          <Route path="/token/:addr" element={<Address />} />
          <Route path="/tx/:hash" element={<Tx />} />
          <Route path="/search" element={<Search />} />
          <Route path="*" element={<NoPage />} />
        </Routes>
      </ErrorBoundary>
    </Shell>
  );
}

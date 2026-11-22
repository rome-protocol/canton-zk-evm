import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { ErrorBoundary } from "../components/ErrorBoundary.tsx";
import { NoticeBanners } from "../components/Notice.tsx";
import { DOCS_URL, SOURCE_URL } from "../copy.ts";
import { Bridge } from "../pages/Bridge.tsx";
import { useStatus } from "../useStatus.ts";
import { AppHeader } from "./AppHeader.tsx";
import "./app.css";

/**
 * The Bridge as its own site: a full-screen frame with its own header around the Bridge page, which is the explorer's page and its code, unchanged. The app has one route, `/`; any other path shows
 * the app at `/` with the query kept. (`/bridge.html` is the app's own file, which a local run opens when the build has no Bridge origin.)
 */
export function BridgeApp() {
  const { search, hash } = useLocation();
  const status = useStatus().data;
  return (
    <div className="bapp">
      <NoticeBanners notices={status?.notices} notice={status?.notice} />
      <AppHeader />
      <main className="bapp-main">
        <ErrorBoundary>
          <Routes>
            <Route path="/" element={<Bridge />} />
            <Route path="/bridge.html" element={<Bridge />} />
            <Route path="*" element={<Navigate to={{ pathname: "/", search, hash }} replace />} />
          </Routes>
        </ErrorBoundary>
      </main>
      <footer className="bapp-foot">
        <a href={DOCS_URL} target="_blank" rel="noopener noreferrer">Docs</a>
        <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">Source code</a>
      </footer>
    </div>
  );
}

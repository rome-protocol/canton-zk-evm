import { Icon } from "../components/Icon.tsx";
import { useStatus } from "../useStatus.ts";
import { explorerHref } from "./where.ts";

/** The Bridge site's header: its name, the network, and the way to the explorer (a new tab). The explorer's menu, search box and status bar are not here. */
export function AppHeader() {
  const status = useStatus().data;
  return (
    <header className="app-top">
      <div className="app-brand">
        <span className="mark" role="img" aria-label="Rome" />
        <h1 className="name">Ostia Bridge</h1>
        {status?.networkName && <span className="pill">{status.networkName}</span>}
      </div>
      <a className="app-explorer" href={explorerHref("/")} target="_blank" rel="noopener">Explorer<Icon name="out" size={13} /></a>
    </header>
  );
}

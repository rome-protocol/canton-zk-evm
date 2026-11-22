import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readDeposit, type Deposit } from "../bridge/other/reads.ts";
import { transferStore } from "../bridge/other/record.ts";
import type { OpenRow, OstiaChain } from "../bridge/other/setup.ts";
import { notAvailable, otherWords } from "../bridge/other/words.ts";
import { claimOwn, keptClaim } from "../bridge/route/claim.ts";
import { minimumWords, ROUTE_NAME, START_NOTE, TRUST, capWords } from "../bridge/route/words.ts";
import { readMoves, type Move, type RouteOn } from "../bridge/route/setup.ts";
import { viewOfMove } from "../bridge/route/view.ts";
import { CardHead } from "../components/Cards.tsx";
import { OutLink } from "../components/Help.tsx";
import { TRUST_MODEL_PAGE } from "../copy.ts";
import { timeoutSignal } from "../timeout.ts";
import { injected } from "../wallet.ts";
import { useStatus } from "../useStatus.ts";
import { BackRows, type Faucet } from "./BackRows.tsx";
import { CantonBack } from "./CantonBack.tsx";
import { useBack } from "./useBack.ts";
import { RouteForm, type SendInput } from "./RouteForm.tsx";
import { RouteMoves } from "./RouteMoves.tsx";
import "./bridge.css";

type Tab = "move" | "activity" | "claim";
/** How long a move that arrived stays under the card, and the most open moves whose stage is asked for in one look (the bridge routes allow 30 reads a minute). */
const JUST_ARRIVED_MS = 5 * 60_000;
const LOOKS_MAX = 4;

/**
 * Canton to Ethereum Sepolia through Ostia: the limits and states of the route, the moves of the connected wallet (found by their destination, kept on the chain and on Canton, so a reload loses none) and the
 * person's own claim. The page reads and the wallet signs. The form that starts a move on Canton is given by the page only where a Canton wallet can connect.
 */
export function CantonRoute({ setup, ostia, sepolia, account, connectNote, onConnect, pollMs, start, topic0, walletChainId, faucet }: {
  setup: RouteOn; ostia: OstiaChain; sepolia: OpenRow; account: string | null; connectNote: string | null; onConnect(): void; pollMs: number;
  /** What the way back to Canton needs: the bridge's deposit event, the chain the wallet is on, and the test coin of Ostia. */
  topic0: string; walletChainId: number | null; faucet: Faucet | null;
  /** Starts a move in the Canton wallet; given only once the page can. */
  start?: (input: SendInput) => Promise<void>;
}) {
  const [tab, setTab] = useState<Tab>("move");
  const [moves, setMoves] = useState<Move[]>([]);
  const [deposits, setDeposits] = useState<Record<string, Deposit>>({});
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, string>>({});
  const store = useMemo(transferStore, []);
  const asset = setup.assets[0] ?? null;
  const st = useStatus();
  const back = useBack({ setup, asset, ostia, status: st.data, sepolia, topic0, account, pollMs });
  const backShown = back.rows.filter((r) => r.view.open || (r.row.episode !== null && now - r.row.episode.lastAt < JUST_ARRIVED_MS));
  const backClaimable = back.rows.filter((r) => r.view.claimable);
  const looking = useRef(false);
  const seen = useRef<Record<string, Deposit>>({});

  const look = useCallback(async () => {
    if (!account || looking.current) return;
    looking.current = true;
    try {
      const found = await readMoves("evm", account, timeoutSignal());
      if (!found) return;
      setMoves(found.moves);
      // A move that is paid out is not asked about again; the others, newest first, up to the limit.
      const open = found.moves.filter((m) => m.state === "taken" && m.depositCount !== null && seen.current[m.id]?.stage !== "claimed").slice(0, LOOKS_MAX);
      for (const m of open) {
        try { seen.current = { ...seen.current, [m.id]: await readDeposit(ostia.networkId, m.depositCount!, timeoutSignal()) }; } catch { /* the stage stays as it was */ }
      }
      setDeposits(seen.current);
    } finally { looking.current = false; setNow(Date.now()); }
  }, [account, ostia.networkId]);
  useEffect(() => { void look(); const id = setInterval(() => void look(), pollMs); return () => clearInterval(id); }, [look, pollMs]);

  const claiming = (m: Move) => keptClaim(store, m.id, now) !== null;
  const views = moves.map((m) => ({ m, v: viewOfMove(m, deposits[m.id] ?? null, setup, asset, claiming(m), now) }));
  const shown = views.filter((x) => x.v.open || x.v.phase === "lapsed" || (x.m.state === "taken" && deposits[x.m.id]?.stage === "claimed" && x.m.at !== null && now - Date.parse(x.m.at) < JUST_ARRIVED_MS)).map((x) => x.m);
  const claimable = views.filter((x) => x.v.claimable).map((x) => x.m);
  const onItsWay = views.filter((x) => x.v.open).length + back.open;
  const count = (n: number) => (n > 0 ? <span className="count">{n}</span> : null);

  async function claim(m: Move) {
    if (!account) return;
    const wallet = injected();
    if (!wallet) return;
    setBusy(m.id); setMessages((x) => ({ ...x, [m.id]: "" }));
    try { await claimOwn({ wallet, account, move: m, sepolia, ostiaNetwork: ostia.networkId, store }); }
    catch (e) { setMessages((x) => ({ ...x, [m.id]: otherWords(e, sepolia.name, "Sepolia ETH") })); }
    finally { setBusy(null); setNow(Date.now()); void look(); }
  }
  const actions = { onClaim: (m: Move) => void claim(m), ...(start ? { onTryAgain: () => setTab("move") } : {}) };

  const unavailable = setup.route !== "open" || !setup.available;
  const connect = <p className="small muted">Connect your wallet to see the moves sent to it. <button type="button" className="link-b" onClick={onConnect}>Connect wallet</button></p>;
  const least = asset ? [asset.minAmount, asset.feeOut + asset.claimFee + setup.unit].reduce((x, y) => (x > y ? x : y)) : 0n;
  return (
    <>
      <div className="tabs" role="tablist" aria-label="Canton to Ethereum Sepolia">
        <button type="button" role="tab" id="route-tab-move" aria-selected={tab === "move"} aria-controls="route-panel-move" onClick={() => setTab("move")}>Move</button>
        <button type="button" role="tab" id="route-tab-activity" aria-selected={tab === "activity"} aria-controls="route-panel-activity" onClick={() => setTab("activity")}>Activity{count(onItsWay)}</button>
        <button type="button" role="tab" id="route-tab-claim" aria-selected={tab === "claim"} aria-controls="route-panel-claim" onClick={() => setTab("claim")}>Claim{count(claimable.length + backClaimable.length)}</button>
      </div>
      {tab === "move" && (
        <div className="panel" role="tabpanel" id="route-panel-move" aria-labelledby="route-tab-move">
          <section className="card move" aria-label={ROUTE_NAME}>
            <CardHead title={ROUTE_NAME} as="h2" />
            {unavailable || !asset
              ? <p className="small bad" role="status">{notAvailable(ROUTE_NAME)}</p>
              : (
                <>
                  {capWords(asset) && <p className="small" role="status">{capWords(asset)}</p>}
                  <p className="small muted">{minimumWords(asset, least)}</p>
                  {start ? <RouteForm setup={setup} asset={asset} account={account} onSend={start} /> : <p className="small muted">{START_NOTE}</p>}
                  {!start && <p className="small muted">{TRUST(asset)} <OutLink href={TRUST_MODEL_PAGE}>Limits</OutLink></p>}
                </>
              )}
            {connectNote && <p className="small bad" role="alert">{connectNote}</p>}
          </section>
          {setup.in && setup.in.route !== "closed" && <CantonBack setup={setup} asset={asset} sepolia={sepolia} account={account} walletChainId={walletChainId} back={back} pollMs={pollMs} onConnect={onConnect} />}
          {account === null ? connect : <RouteMoves items={shown} deposits={deposits} setup={setup} asset={asset} claiming={claiming} now={now} busy={busy} messages={messages} empty="" actions={actions} />}
          <BackRows items={backShown} back={back} faucet={faucet} />
        </div>
      )}
      {tab === "activity" && (
        <div className="panel" role="tabpanel" id="route-panel-activity" aria-labelledby="route-tab-activity">
          {account === null ? connect : <RouteMoves items={moves} deposits={deposits} setup={setup} asset={asset} claiming={claiming} now={now} busy={busy} messages={messages} empty={back.rows.length > 0 ? "" : "No moves have been sent to this wallet yet."} actions={actions} />}
          {account !== null && <BackRows items={back.rows} back={back} faucet={faucet} />}
        </div>
      )}
      {tab === "claim" && (
        <div className="panel" role="tabpanel" id="route-panel-claim" aria-labelledby="route-tab-claim">
          {account === null ? connect : <RouteMoves items={claimable} deposits={deposits} setup={setup} asset={asset} claiming={claiming} now={now} busy={busy} messages={messages} empty={backClaimable.length > 0 ? "" : "Nothing is ready to claim."} actions={actions} />}
          {account !== null && <BackRows items={backClaimable} back={back} faucet={faucet} />}
        </div>
      )}
    </>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { rpc } from "../rpc.ts";
import { timeoutSignal } from "../timeout.ts";
import { CardHead, unready } from "../components/Cards.tsx";
import { TRUST_MODEL_PAGE } from "../copy.ts";
import { HelpLine, OutLink } from "../components/Help.tsx";
import { createFaucetClient, type FaucetInfo } from "../faucet/faucet-client.ts";
import { formatCoin } from "../faucet/format.ts";
import { useStatus } from "../useStatus.ts";
import { injected, noWalletWords, useWallet } from "../wallet.ts";
import { plainText } from "../bridge/words.ts";
import type { LocksLike } from "../bridge/moves/moves.ts";
import { keptTransfers, transferStore, type Transfer } from "../bridge/other/record.ts";
import { readSetup, type OpenRow, type Setup } from "../bridge/other/setup.ts";
import { adopt, advance, giveUp, look, readStop, resendSend, signClaim, startSend, sides, Stop, askingOf, watchAsking, type Live, type SendInput } from "../bridge/other/transfer.ts";
import { viewOf, type Names } from "../bridge/other/view.ts";
import { createEnv } from "../bridge/other/wire.ts";
import { feeCoin, movedWords, noCountWords, notSentWords, NOT_YET_OPEN, otherWords, TRUST_ALWAYS, TRUST_ETH, ACTIVITY_NOTE } from "../bridge/other/words.ts";
import { OtherCard } from "./OtherCard.tsx";
import { Transfers, type RowActions } from "./OtherTransfers.tsx";
import "./bridge.css";
import "./other-chains.css";

type On = Extract<Setup, { on: true }>;
type Tab = "move" | "activity" | "claim";
const faucet = createFaucetClient();

/** How often the transfers and the setup are looked at again. */
const POLL_MS = 10_000;
/** How long a transfer that has arrived stays under the card. */
const JUST_ARRIVED_MS = 5 * 60_000;
const explorerRead = (method: string, params: unknown[]) => rpc(method, params, timeoutSignal());
const webLocks = (): LocksLike | null => (typeof navigator !== "undefined" && "locks" in navigator ? (navigator.locks as unknown as LocksLike) : null);

/**
 * The "AggLayer Bridge" tab of the Bridge: routes between Ostia and other chains over AggLayer. The page reads, the wallet signs; the browser keeps a record of each transfer it started (no list of
 * transfers started elsewhere), so a reload carries on where it was and signs nothing twice.
 */
export function OtherChains({ tabs, setup: first, pollMs = POLL_MS }: { tabs: ReactNode; setup: On; pollMs?: number }) {
  const st = useStatus();
  const wallet = useWallet(st.data);
  const [setup, setSetup] = useState<On>(first);
  const [routeId, setRouteId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("move");
  const store = useMemo(transferStore, []);
  const [records, setRecords] = useState<Transfer[]>([]);
  const [live, setLive] = useState<Record<string, Live>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [refresh, setRefresh] = useState(0);
  const [info, setInfo] = useState<FaucetInfo | null>(null);
  const [coin, setCoin] = useState<{ busy: boolean; coming: boolean; note: string | null }>({ busy: false, coming: false, note: null });
  const [now, setNow] = useState(() => Date.now());
  const account = wallet.account;

  // The setup is read again now and then: a route can stop being available, and a time can be set.
  useEffect(() => {
    const id = setInterval(() => { void readSetup(timeoutSignal()).then((s) => { if (s.on) setSetup(s); }); }, pollMs);
    return () => clearInterval(id);
  }, [pollMs]);

  const open = setup.routes.filter((r): r is OpenRow => r.open);
  const row = open.find((r) => r.id === routeId) ?? open[0] ?? null;
  const chain = setup.chain;
  // The parts of the route that decide what a transfer does. A change of availability or of a time does not start the wallet's machinery again.
  const planKey = row ? JSON.stringify([chain, row.id, row.name, row.networkId, row.chainId, row.bridge, row.assets, setup.bridgeEvent.topic0]) : "";
  const plan = useMemo(() => (row ? { ostia: chain, other: row, topic0: setup.bridgeEvent.topic0 } : null), [planKey]);   // eslint-disable-line react-hooks/exhaustive-deps
  const status = st.data;
  const env = useMemo(() => {
    const w = injected();
    return plan && account && w && status ? createEnv({ wallet: w, account, plan, ostia: status, read: explorerRead, store, locks: webLocks() }) : null;
  }, [plan, account, status?.chainId, store]);   // eslint-disable-line react-hooks/exhaustive-deps
  const ostiaCoin = status?.coin.symbol ?? "tROME";
  const names: Names | null = row ? { ostia: chain, other: row, ostiaCoin } : null;

  const reload = useCallback(() => { setRecords(account ? keptTransfers(store, account).filter((t) => t.route === (row?.id ?? t.route)) : []); setNow(Date.now()); }, [account, store, row?.id]);
  useEffect(reload, [reload]);
  // A step that starts or stops being asked of the wallet shows at once, not at the next look.
  useEffect(() => watchAsking(reload), [reload]);

  // One look at each open transfer, every few seconds: it reads, and never signs.
  const looking = useRef(false);
  useEffect(() => {
    if (!env) return;
    let on = true;
    const run = async () => {
      if (looking.current) return;
      looking.current = true;
      try {
        for (const t of keptTransfers(store, env.account).filter((x) => x.done === undefined && x.route === env.plan.other.id)) {
          const r = await advance(env, t.id);
          if (!on) return;
          setLive((l) => ({ ...l, [t.id]: r.live }));
        }
      } finally { looking.current = false; }
      if (on) reload();
    };
    void run();
    const id = setInterval(() => void run(), pollMs);
    return () => { on = false; clearInterval(id); };
  }, [env, store, reload, pollMs]);

  useEffect(() => { if (account) faucet.info().then(setInfo, () => setInfo(null)); }, [account]);
  const faucetOn = info !== null && info.on;
  const amount = info && status ? `${formatCoin(info.amount, status.coin.decimals)} ${ostiaCoin}` : `test ${ostiaCoin}`;
  async function getCoin() {
    if (!account) return;
    setCoin({ busy: true, coming: false, note: null });
    const r = await faucet.request(account);
    const note = r.kind === "queued" ? `${amount} is on its way to your wallet.` : r.kind === "captcha" ? "The faucet asks for a human check first. Ask for it on the Faucet page." : plainText(r.message);
    setCoin({ busy: false, coming: r.kind === "queued", note });
    if (r.kind === "queued") setTimeout(() => { setCoin((c) => ({ ...c, coming: false })); setRefresh((n) => n + 1); }, 60_000);
    setRefresh((n) => n + 1);
  }

  /** One action on a transfer: marks it busy, says in words why it failed, and shows the record as it is afterwards. */
  async function run(id: string, fn: () => Promise<unknown>, where?: () => { name: string; coin: string }) {
    setBusy(id); setMessages((m) => ({ ...m, [id]: "" }));
    try { await fn(); }
    catch (e) {
      const w = where?.() ?? { name: row?.name ?? "the chain", coin: "" };
      setMessages((m) => ({ ...m, [id]: otherWords(readStop(e), w.name, w.coin) }));
    } finally { setBusy(null); reload(); setRefresh((n) => n + 1); }
  }
  const claimWhere = (t: Transfer) => () => { const s = sides({ ostia: chain, other: row!, topic0: "" }, t.dir); return { name: s.claimName, coin: feeCoin(row!, ostiaCoin, t.dir === "in" ? "ostia" : "other") }; };
  const sendWhere = (t: Transfer) => () => { const s = sides({ ostia: chain, other: row!, topic0: "" }, t.dir); return { name: s.sendName, coin: feeCoin(row!, ostiaCoin, t.dir === "in" ? "other" : "ostia") }; };
  const actions: RowActions = {
    onSend: (t) => env && void run(t.id, () => resendSend(env, t.id), sendWhere(t)),
    onClaim: (t) => env && void run(t.id, () => signClaim(env, t.id), claimWhere(t)),
    onLook: (t, which) => env && void run(t.id, async () => {
      const s = sides({ ostia: chain, other: row!, topic0: "" }, t.dir);
      const found = await look(env, t.id, which);
      const name = which === "send" ? s.sendName : s.claimName;
      // A send that was not made shows as "not sent" with these words under it; a claim goes back to its button, so it is told here.
      if (found === "not-sent" && which === "claim") throw new Stop(notSentWords("claim"));
      if (found === "unknown") throw new Stop(movedWords(name));
      if (found === "no-count") throw new Stop(noCountWords(name));
      if (found === "elsewhere") throw new Stop(`Put your wallet on ${name} to look.`);
    }, () => ({ name: "", coin: "" })),
    onAdopt: (t, which, hash) => env && void run(t.id, () => adopt(env, t.id, which, hash), which === "send" ? sendWhere(t) : claimWhere(t)),
    onPutWallet: (chainId) => env && void env.ensure(chainId).then((why) => { if (why) setMessages((m) => ({ ...m, wallet: why })); }),
    onRemove: (t) => { if (env) { giveUp(env, t.id); reload(); } },
  };

  async function onStart(input: SendInput) {
    if (!env) throw new Error("Connect your wallet first.");
    try { await startSend(env, input); } finally { reload(); setRefresh((n) => n + 1); }
  }

  const wait = unready(st, "Looking up the chain…");
  if (wait) return wait;
  const connectNote = wallet.error ? plainText(wallet.error) : null;
  const connect = () => { if (!injected()) setMessages((m) => ({ ...m, wallet: noWalletWords() })); else void wallet.connect(); };
  const views = names ? records.map((t) => ({ t, v: viewOf(t, live[t.id]?.deposit ?? null, names, now, askingOf(t.id)) })) : [];
  const onItsWay = views.filter((x) => x.v.open).map((x) => x.t);
  // A transfer that arrived stays on the Move tab for a few minutes, so that the person sees it arrive.
  const shown = views.filter((x) => x.v.open || (x.t.done !== undefined && now - x.t.done < JUST_ARRIVED_MS)).map((x) => x.t);
  const claimable = views.filter((x) => x.v.claimable).map((x) => x.t);
  const hasEth = row?.assets.some((a) => a.sepolia === "native") ?? false;
  const count = (n: number) => (n > 0 ? <span className="count">{n}</span> : null);

  return (
    <div className="bridge-page other-chains">
      <div className="ptitle"><h1>Bridge</h1><span className="muted psub">Move tokens to and from {chain.name} over the AggLayer Bridge</span></div>
      {tabs}
      <section className="card routes" aria-label="Route">
        <CardHead title="Route" as="h2" />
        <ul>
          {setup.routes.map((r) => r.open
            ? <li key={r.id}><button type="button" className={`route${row?.id === r.id ? " on" : ""}`} aria-pressed={row?.id === r.id} onClick={() => setRouteId(r.id)}><span>{chain.name} <span aria-hidden="true">↔</span><span className="sr-only"> and </span> {r.name}</span><span className="muted small">via AggLayer</span></button></li>
            : <li key={r.id} className="route closed"><span>{chain.name} <span aria-hidden="true">↔</span><span className="sr-only"> and </span> {r.name}</span><span className="muted small">{NOT_YET_OPEN}</span></li>)}
        </ul>
      </section>
      {row && names && (
        <>
          <div className="tabs" role="tablist" aria-label="AggLayer Bridge">
            <button type="button" role="tab" id="other-tab-move" aria-selected={tab === "move"} aria-controls="other-panel-move" onClick={() => setTab("move")}>Move</button>
            <button type="button" role="tab" id="other-tab-activity" aria-selected={tab === "activity"} aria-controls="other-panel-activity" onClick={() => setTab("activity")}>Activity{count(onItsWay.length)}</button>
            <button type="button" role="tab" id="other-tab-claim" aria-selected={tab === "claim"} aria-controls="other-panel-claim" onClick={() => setTab("claim")}>Claim{count(claimable.length)}</button>
          </div>
          {tab === "move" && (
            <div className="panel" role="tabpanel" id="other-panel-move" aria-labelledby="other-tab-move">
              <OtherCard
                row={row} chain={chain} ostiaCoin={ostiaCoin} account={account} connectNote={messages.wallet ?? connectNote} onConnect={connect} walletChainId={wallet.chainId} read={explorerRead}
                faucet={faucetOn ? { label: `Get ${amount}`, busy: coin.busy, coming: coin.coming, onGet: () => void getCoin() } : null} onStart={onStart} refresh={refresh} busy={busy !== null}
              />
              {coin.note && <p className="small muted" role="status">{coin.note}</p>}
              {account && shown.length > 0 && <Transfers items={shown} live={live} names={names} busy={busy} messages={messages} now={now} empty="" actions={actions} />}
              {hasEth && <p className="small muted">{TRUST_ETH} <OutLink href={TRUST_MODEL_PAGE}>Limits</OutLink></p>}
            </div>
          )}
          {tab === "activity" && (
            <div className="panel" role="tabpanel" id="other-panel-activity" aria-labelledby="other-tab-activity">
              {account
                ? <><Transfers items={records} live={live} names={names} busy={busy} messages={messages} now={now} empty="No transfers have been started in this browser yet." actions={actions} /><p className="small muted">{ACTIVITY_NOTE}</p></>
                : <p className="small muted">Connect your wallet to see the transfers started in this browser. <button type="button" className="link-b" onClick={connect}>Connect wallet</button></p>}
            </div>
          )}
          {tab === "claim" && (
            <div className="panel" role="tabpanel" id="other-panel-claim" aria-labelledby="other-tab-claim">
              {account
                ? <Transfers items={claimable} live={live} names={names} busy={busy} messages={messages} now={now} empty="Nothing is ready to claim." actions={actions} />
                : <p className="small muted">Connect your wallet to see what is ready to claim. <button type="button" className="link-b" onClick={connect}>Connect wallet</button></p>}
            </div>
          )}
        </>
      )}
      {!row && <section className="card"><p className="muted">No route is open yet.</p></section>}
      <p className="small muted">{TRUST_ALWAYS}</p>
      <HelpLine />
    </div>
  );
}

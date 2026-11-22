// The way back to Canton, as the Canton route's page lives it: the browser's records of the sends it made, the router's events for the wallet's way back, the bridge's stage of each deposit, and the person's own
// steps on Ostia. The page reads and the wallet signs: a step that signs is a call the person asked for, and nothing here signs on its own.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Hex } from "viem";
import type { ApiStatus } from "../api.ts";
import { checkInRead, claimCall, holdCall, isClaimInto } from "../bridge/route/in.ts";
import { rowsOf, viewOfRow, type InRow, type InView } from "../bridge/route/back.ts";
import { keptAct, signOwn } from "../bridge/route/own.ts";
import { claimOwn } from "../bridge/route/claim.ts";
import { readMoves, type BackEvent, type Move, type RouteAsset, type RouteOn } from "../bridge/route/setup.ts";
import { readClaim, readDeposit, ReadError, type Deposit } from "../bridge/other/reads.ts";
import { keptTransfers, removeTransfer, saveTransfer, transferStore, type Transfer } from "../bridge/other/record.ts";
import type { OpenRow, OstiaChain } from "../bridge/other/setup.ts";
import { advance, resendSend, startSend, Stop, watchAsking, readStop, type SendInput } from "../bridge/other/transfer.ts";
import { createEnv } from "../bridge/other/wire.ts";
import { otherWords } from "../bridge/other/words.ts";
import { explorerTx, type LocksLike } from "../bridge/moves/moves.ts";
import { ethCall, finalBlock, rpc } from "../rpc.ts";
import { timeoutSignal } from "../timeout.ts";
import { injected } from "../wallet.ts";

/** The id of a send to a Canton account's Ostia address in the browser's records: the plain transfers' list never shows it. */
export const BACK_ROUTE = "canton-in";
/** How many deposits that are not yet paid out are asked about in one look (the bridge routes allow 30 reads a minute). */
const LOOKS_MAX = 4;
const explorerRead = (method: string, params: unknown[]) => rpc(method, params, timeoutSignal());
const webLocks = (): LocksLike | null => (typeof navigator !== "undefined" && "locks" in navigator ? (navigator.locks as unknown as LocksLike) : null);

export interface BackRow { row: InRow; view: InView }
export interface Back {
  rows: BackRow[];
  /** Rows on their way, and rows that wait for the person. */
  open: number;
  claimable: number;
  busy: string | null;
  messages: Record<string, string>;
  send(input: SendInput): Promise<Transfer>;
  act(row: BackRow, kind: InView["actions"][number]["kind"]): void;
  /** Gives up a record that was never sent. */
  giveUp(row: BackRow): void;
  /** Whether the account takes withdrawals now, as the last look said; null when not known. */
  accepts(party: string): boolean | null;
}

export function useBack(o: { setup: RouteOn; asset: RouteAsset | null; ostia: OstiaChain; status: ApiStatus | undefined; sepolia: OpenRow; topic0: string; account: string | null; pollMs: number }): Back {
  const { setup, asset, ostia, status, sepolia, topic0, account, pollMs } = o;
  const flow = setup.in;
  const store = useMemo(transferStore, []);
  const [records, setRecords] = useState<Transfer[]>([]);
  const [events, setEvents] = useState<BackEvent[]>([]);
  const [acceptsBy, setAccepts] = useState<Record<string, boolean> | null>(null);
  const [deposits, setDeposits] = useState<Record<string, Deposit>>({});
  const [inBlock, setInBlock] = useState<Record<string, true>>({});
  const [checkIn, setCheckIn] = useState<boolean | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, string>>({});
  const seen = useRef<Record<string, Deposit>>({});
  const inBlockSeen = useRef<Record<string, true>>({});
  const looking = useRef(false);
  const eventsNow = useRef<BackEvent[]>([]);
  /** Only the listed coin's events: anyone may put another coin into an address and call the router's mark, and that must not show as a holding of this one. */
  const listed = useCallback((all: BackEvent[]) => all.filter((e) => e.erc20 === null || (asset !== null && e.erc20 === asset.erc20)), [asset]);
  eventsNow.current = events;

  const plan = useMemo(() => ({ ostia, other: sepolia, topic0 }), [ostia, sepolia, topic0]);
  const env = useMemo(() => {
    const w = injected();
    return account && w && status ? createEnv({ wallet: w, account, plan, ostia: status, read: explorerRead, store, locks: webLocks() }) : null;
  }, [plan, account, status?.chainId, store]);   // eslint-disable-line react-hooks/exhaustive-deps

  const reload = useCallback(() => { setRecords(account ? keptTransfers(store, account).filter((t) => t.route === BACK_ROUTE) : []); setNow(Date.now()); }, [account, store]);
  useEffect(reload, [reload]);
  useEffect(() => watchAsking(reload), [reload]);

  const look = useCallback(async () => {
    if (!account || !flow || looking.current) return;
    looking.current = true;
    try {
      const found = await readMoves("evm", account, timeoutSignal());
      if (found) { setEvents(listed(found.back)); setAccepts(found.accepts); }
      const mine = keptTransfers(store, account).filter((t) => t.route === BACK_ROUTE);
      // One look at each send that is not paid out yet: it reads the send's block and the deposit's stage, and never signs.
      if (env) for (const t of mine.filter((x) => x.done === undefined)) {
        const r = await advance(env, t.id);
        if (r.live.deposit) seen.current = { ...seen.current, [t.id]: r.live.deposit };
      }
      // A way back is a deposit on Ostia: its stage is read for the newest ones that have not arrived.
      const back = rowsOf(mine, listed(found?.back ?? eventsNow.current));
      const refunds = back.filter((r) => r.episode?.state === "refunded" && r.episode.amount !== 0n && r.episode.depositCount !== null && seen.current[r.id]?.stage !== "claimed").slice(0, LOOKS_MAX);
      for (const r of refunds) { try { seen.current = { ...seen.current, [r.id]: await readDeposit(ostia.networkId, r.episode!.depositCount!, timeoutSignal()) }; } catch { /* the stage stays as it was */ } }
      // A step of the person's own that is in an Ostia block is not a left-out transaction, whatever the time. One that waits in the pool, or that was replaced or dropped, is in no block: it is left out.
      for (const r of back) {
        const k = keptAct(store, r.id, Date.now());
        if (k && !inBlockSeen.current[k.hash]) { try { const tx = await explorerTx(k.hash as Hex); if (tx !== null && tx.block !== null) inBlockSeen.current = { ...inBlockSeen.current, [k.hash]: true }; } catch { /* looked at again next time */ } }
      }
      setInBlock(inBlockSeen.current);
      // A send whose coin was paid on or sent back is finished: it is no longer looked at.
      for (const r of back) if (r.record && r.record.done === undefined && (r.episode?.state === "arrived" || r.episode?.state === "refunded")) saveTransfer(store, { ...r.record, done: Date.now() });
      if (asset && mine.some((t) => seen.current[t.id]?.stage === "ready" || seen.current[t.id]?.stage === "claimed")) {
        const block = await finalBlock();
        const read = checkInRead(flow.book, asset.erc20);
        setCheckIn(await ethCall(read.to, read.data, block).then(() => true, () => false));
      }
      setDeposits(seen.current);
    } catch { /* a read that failed is made again at the next look */ } finally { looking.current = false; reload(); }
  }, [account, flow, env, store, ostia.networkId, asset, reload, listed]);
  useEffect(() => { void look(); const id = setInterval(() => void look(), pollMs); return () => clearInterval(id); }, [look, pollMs]);

  const rows: BackRow[] = useMemo(() => {
    if (!flow || !asset || !account) return [];
    return rowsOf(records, events).map((row) => ({
      row,
      view: viewOfRow(row, { setup, asset, wallet: account, deposit: deposits[row.id] ?? null, accepts: row.party !== null && acceptsBy ? acceptsBy[row.party] ?? null : null, checkIn, kept: keptAct(store, row.id, now), keptSeen: (() => { const k = keptAct(store, row.id, now); return k !== null && inBlock[k.hash] === true; })(), coin: status?.coin.symbol ?? "tROME", now }),
    }));
  }, [flow, asset, account, records, events, deposits, inBlock, acceptsBy, checkIn, store, now, setup, status?.coin.symbol]);

  const send = useCallback(async (input: SendInput) => {
    if (!env) throw new Stop("Connect your wallet first.");
    try { return await startSend(env, input); } finally { reload(); void look(); }
  }, [env, reload, look]);

  const act = useCallback((r: BackRow, kind: InView["actions"][number]["kind"]) => {
    const wallet = injected();
    if (!account || !flow || !asset || !wallet || !status) return;
    const w = wallet;
    const [me, router, token, coin] = [account, flow.router, asset.erc20, status.coin.symbol];
    const { row } = r;
    const own = (call: Parameters<typeof signOwn>[0]["call"], as: "claim" | "forward" | "refund") => signOwn({ wallet: w, account: me, ostia: status, id: row.id, kind: as, call, store });
    async function run(): Promise<void> {
      const party = row.party;
      if (kind === "send-again") { if (!env) throw new Stop("Connect your wallet first."); await resendSend(env, row.id); return; }
      if (kind === "claim-sepolia") {
        const ep = row.episode;
        if (!ep || ep.depositCount === null || ep.amount === null) throw new Stop("This is not ready to claim yet.");
        const move: Move = { id: row.id, state: "taken", party: party ?? "", destAddress: me, erc20: ep.erc20, amount: ep.amount, send: ep.amount, fee: ep.fee, depositCount: ep.depositCount, txHash: ep.txHash, block: ep.block, at: new Date(ep.lastAt).toISOString(), settleBefore: null };
        await claimOwn({ wallet: w, account: me, move, sepolia: { chainId: sepolia.chainId, bridge: sepolia.bridge }, ostiaNetwork: ostia.networkId, store });
        return;
      }
      if (party === null) throw new Stop("This account's Ostia address cannot be read right now. Try again in a moment.");
      if (kind === "forward" || kind === "refund") { await own(holdCall(kind, router, party, me, token), kind); return; }
      const t = row.record;
      if (!t || t.count === null || !t.receiver) throw new Stop("This send is not kept in this browser, so it cannot be claimed from here.");
      let claim;
      try { claim = await readClaim(sepolia.networkId, t.count); } catch (e) { throw e instanceof ReadError ? readStop(e) : e; }
      if (claim.claimed) throw new Stop("Already claimed on Ostia.");
      if (!isClaimInto(claim.args, { inbox: t.receiver, ostiaNetwork: ostia.networkId, amount: BigInt(t.amount), count: t.count, erc20: token })) throw new Stop("The bridge sent back a claim that is not this send's, so nothing was signed. Try again in a moment.");
      await own(claimCall(r.view.claimPays ? "claimAndWithdraw" : "claimToInbox", router, claim.args, party, me), "claim");
    }
    setBusy(row.id); setMessages((m) => ({ ...m, [row.id]: "" }));
    run().catch((e: unknown) => setMessages((m) => ({ ...m, [row.id]: otherWords(e, kind === "claim-sepolia" ? sepolia.name : ostia.name, kind === "claim-sepolia" ? "Sepolia ETH" : coin) })))
      .finally(() => { setBusy(null); reload(); void look(); });
  }, [account, flow, asset, status, env, store, sepolia, ostia, reload, look]);

  const giveUp = useCallback((r: BackRow) => {
    if (!r.row.record) return;
    removeTransfer(store, r.row.record.id);
    reload();
  }, [store, reload]);

  return {
    rows, busy, messages, send, act, giveUp,
    open: rows.filter((r) => r.view.open).length, claimable: rows.filter((r) => r.view.claimable).length,
    accepts: (party) => (acceptsBy ? acceptsBy[party] ?? null : null),
  };
}

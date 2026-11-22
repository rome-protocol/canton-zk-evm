// An account's Ostia address, for the way back: read from the server, worked out by the page on Ostia, and asked for once per (account, way back) when it is not open. The ask is kept in this browser, so that a
// reload carries on waiting and does not ask again.
import { useCallback, useEffect, useRef, useState } from "react";
import { addressState, PARTY, type AddressState } from "../bridge/route/address.ts";
import { inboxFrom, inboxRead } from "../bridge/route/in.ts";
import { transferStore } from "../bridge/other/record.ts";
import { askAddress, readAddress, type AddressRead } from "../bridge/route/setup.ts";
import { ethCall, finalBlock } from "../rpc.ts";
import { timeoutSignal } from "../timeout.ts";

const key = (party: string, wallet: string) => `ostia-in-asked:${party}:${wallet}`;
const store = transferStore();
const kept = (party: string, wallet: string): number | null => { try { const v = Number(store?.getItem(key(party, wallet))); return Number.isFinite(v) && v > 0 ? v : null; } catch { return null; } };
const keep = (party: string, wallet: string, at: number | null) => { try { if (at === null) store?.removeItem(key(party, wallet)); else store?.setItem(key(party, wallet), String(at)); } catch { /* a browser that keeps nothing asks again after a reload; the intake takes a second ask */ } };

/** How long the typed account must stand still before anything is asked about it: a half-typed id is never looked up. */
const SETTLE_MS = 500;

export function useAddress(o: { party: string; wallet: string | null; router: string; setupSeconds: number; pollMs: number }): AddressState {
  const { wallet, router, setupSeconds, pollMs } = o;
  const [party, setParty] = useState("");
  useEffect(() => { if (o.party === party) return; const id = setTimeout(() => setParty(o.party), o.party === "" ? 0 : SETTLE_MS); return () => clearTimeout(id); }, [o.party, party]);
  const valid = wallet !== null && PARTY.test(party) && party === o.party;
  const [read, setRead] = useState<AddressRead | null | "unread">("unread");
  const [mine, setMine] = useState<string | null>(null);
  const [askedAt, setAskedAt] = useState<number | null>(null);
  const [askFailed, setAskFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const asking = useRef(false);
  /** The pair now typed: an answer that comes back for another pair is dropped. */
  const current = useRef("");
  current.current = valid ? `${party}|${wallet!.toLowerCase()}` : "";

  useEffect(() => {
    setRead("unread"); setMine(null); setAskFailed(false);
    // An ask that went out longer ago than the set time, with no opening since, is expired: a later visit asks again.
    const at = valid ? kept(party, wallet!) : null;
    if (valid && at !== null && Date.now() - at >= setupSeconds * 1000) { keep(party, wallet!, null); setAskedAt(null); } else setAskedAt(at);
  }, [party, wallet, valid, setupSeconds]);

  const look = useCallback(async () => {
    if (!valid) return;
    const me = `${party}|${wallet!.toLowerCase()}`;
    const r = await readAddress(party, wallet!, timeoutSignal());
    if (current.current !== me) return;
    setRead(r);
    setNow(Date.now());
    if (!r || r.accepts !== true) return;
    if (r.opened) {
      keep(party, wallet!, null);
      if (mine === null) {
        try {
          const read = inboxRead(router, party, wallet!);
          const found = inboxFrom((await ethCall(read.to, read.data, await finalBlock())).result);
          if (current.current === me) setMine(found);
        } catch { /* looked at again next time */ }
      }
      return;
    }
    if (kept(party, wallet!) === null && !asking.current) {
      asking.current = true;
      const ok = await askAddress(party, wallet!, timeoutSignal());
      asking.current = false;
      const at = Date.now();
      if (ok) keep(party, wallet!, at);
      if (current.current !== me) return;
      if (ok) setAskedAt(at); else setAskFailed(true);
    }
  }, [valid, party, wallet, router, mine]);
  useEffect(() => { void look(); const id = setInterval(() => void look(), pollMs); return () => clearInterval(id); }, [look, pollMs]);

  return valid ? addressState({ party, wallet: wallet!, read, mine, askedAt, askFailed, now, setupSeconds }) : { kind: "idle" };
}

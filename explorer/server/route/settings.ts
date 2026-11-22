/** The settings of the Canton route's routes (Canton Coin to Ethereum Sepolia, through Ostia's router), read from the environment. With OSTIA_ROUTE_OUT off, nothing else is read. */
import type { AgglayerSettings, TimeRange } from "../agglayer/settings.ts";

export interface GatewayAuth {
  party: string;
  tokenFile: string;
}
export interface RouteSettings {
  router: string;
  book: string;
  /** How long after a move is signed on Canton, with no Ostia block that took it, the page says it is not taken yet. */
  notTakenSeconds: number;
  /** How long after "Confirmed on Ethereum Sepolia", with no claim, the page offers the person's own claim. */
  ownClaimSeconds: number;
  /** The measured time of a whole move; null until one is set, and the page then shows no time. */
  time: TimeRange | null;
  /** The gateway party and its read-only credential file: the Canton read of the move's open requests. Null: no request is read, and the page shows only moves Ostia has taken. */
  gateway: GatewayAuth | null;
}

type Env = Record<string, string | undefined>;
type Fail = (message: string) => Error;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function routeSettings(env: Env, agglayer: AgglayerSettings | null, fail: Fail): RouteSettings | null {
  const raw = env.OSTIA_ROUTE_OUT;
  if (raw === undefined || raw === "" || raw === "0") return null;
  if (raw !== "1") throw fail(`OSTIA_ROUTE_OUT must be 1 or 0, not "${raw.slice(0, 20)}"`);
  if (!agglayer) throw fail("OSTIA_ROUTE_OUT needs AGGLAYER_BRIDGE=1: the move's last steps are read from the AggLayer bridge");
  const address = (name: string): string => {
    const v = env[name]?.trim() ?? "";
    if (!ADDRESS.test(v)) throw fail(`${name} must be set to a contract address (0x and 40 hex digits) when OSTIA_ROUTE_OUT is on`);
    return v.toLowerCase();
  };
  const seconds = (name: string): number => {
    const v = env[name]?.trim() ?? "";
    if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 7 * 86_400) throw fail(`${name} must be set to a whole number of seconds from 1 to 604800 when OSTIA_ROUTE_OUT is on (a measured time: the page has none of its own)`);
    return Number(v);
  };
  const time = ((): TimeRange | null => {
    const text = env.OSTIA_ROUTE_TIME?.trim();
    if (!text) return null;
    let v: unknown;
    try { v = JSON.parse(text); } catch { throw fail("OSTIA_ROUTE_TIME must be JSON: {\"minSeconds\": …, \"maxSeconds\": …}"); }
    const r = v as Record<string, unknown> | null;
    const ok = r !== null && typeof r === "object" && Object.keys(r).every((k) => k === "minSeconds" || k === "maxSeconds") && Number.isInteger(r.minSeconds) && Number.isInteger(r.maxSeconds)
      && (r.minSeconds as number) >= 1 && (r.maxSeconds as number) >= (r.minSeconds as number) && (r.maxSeconds as number) <= 86_400;
    if (!ok) throw fail("OSTIA_ROUTE_TIME is minSeconds and maxSeconds, whole numbers from 1 to 86400, with the first not above the second");
    return { minSeconds: r!.minSeconds as number, maxSeconds: r!.maxSeconds as number };
  })();
  const [party, tokenFile] = [env.GATEWAY_PARTY, env.GATEWAY_LEDGER_TOKEN_FILE].map((v) => v?.trim() ?? "") as [string, string];
  if ((party === "") !== (tokenFile === "")) throw fail("GATEWAY_PARTY and GATEWAY_LEDGER_TOKEN_FILE must be set together");
  return { router: address("OSTIA_ROUTER"), book: address("OSTIA_BOOK"), notTakenSeconds: seconds("OSTIA_ROUTE_NOT_TAKEN_SECONDS"), ownClaimSeconds: seconds("OSTIA_ROUTE_OWN_CLAIM_SECONDS"), time, gateway: party ? { party, tokenFile } : null };
}

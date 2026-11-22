/** The settings of the Canton route's routes (Canton Coin to Ethereum Sepolia, through Ostia's router), read from the environment. With OSTIA_ROUTE_OUT off, nothing else is read. */
import type { AgglayerSettings, TimeRange } from "../agglayer/settings.ts";

export interface GatewayAuth {
  party: string;
  tokenFile: string;
}
/** Flow C, back to Canton (OSTIA_ROUTE_IN): the waits of the page and where the intake of the account's Ostia address is. */
export interface RouteIn {
  /** How long after the page asks for an account's Ostia address, with no Sent mark, setting it up is counted as not done. */
  setupSeconds: number;
  /** The measured time of setting up an address; null until one is set, and the page then shows no time. */
  setupTime: TimeRange | null;
  /** The intake that opens an account's Ostia address on the page's request: only its answer's status is read, never the address. */
  intake: string;
  /** The person's own "Claim on Ostia" and "Send on to Canton" (OSTIA_CLAIM_OSTIA): the wait at "Ready on Ostia" (and while held, with Canton able to pay) before they are offered, and how long a transaction of the person's own may be in no block before the page says so. Null: not offered. */
  claimOstia: { afterSeconds: number; leftOutSeconds: number } | null;
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
  /** Flow C, or null while OSTIA_ROUTE_IN is off. */
  in: RouteIn | null;
}

type Env = Record<string, string | undefined>;
type Fail = (message: string) => Error;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const seconds = (env: Env, fail: Fail, name: string, why: string): number => {
  const v = env[name]?.trim() ?? "";
  if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 7 * 86_400) throw fail(`${name} must be set to a whole number of seconds from 1 to 604800 when ${why} (a measured time: the page has none of its own)`);
  return Number(v);
};
const range = (env: Env, fail: Fail, name: string): TimeRange | null => {
  const text = env[name]?.trim();
  if (!text) return null;
  let v: unknown;
  try { v = JSON.parse(text); } catch { throw fail(`${name} must be JSON: {"minSeconds": …, "maxSeconds": …}`); }
  const r = v as Record<string, unknown> | null;
  const ok = r !== null && typeof r === "object" && Object.keys(r).every((k) => k === "minSeconds" || k === "maxSeconds") && Number.isInteger(r.minSeconds) && Number.isInteger(r.maxSeconds)
    && (r.minSeconds as number) >= 1 && (r.maxSeconds as number) >= (r.minSeconds as number) && (r.maxSeconds as number) <= 86_400;
  if (!ok) throw fail(`${name} is minSeconds and maxSeconds, whole numbers from 1 to 86400, with the first not above the second`);
  return { minSeconds: r!.minSeconds as number, maxSeconds: r!.maxSeconds as number };
};
const flag = (env: Env, fail: Fail, name: string): boolean => {
  const raw = env[name];
  if (raw === undefined || raw === "" || raw === "0") return false;
  if (raw !== "1") throw fail(`${name} must be 1 or 0, not "${raw.slice(0, 20)}"`);
  return true;
};

function inSettings(env: Env, fail: Fail): RouteIn | null {
  if (!flag(env, fail, "OSTIA_ROUTE_IN")) return null;
  if (!flag(env, fail, "OSTIA_ROUTE_OUT")) throw fail("OSTIA_ROUTE_IN needs OSTIA_ROUTE_OUT=1: the two directions share the book, the router and the route's page");
  const intake = env.OSTIA_INTAKE_URL?.trim() ?? "";
  if (!/^https?:\/\/[^\s/]+(\/\S*)?$/.test(intake) || intake.length > 300) throw fail("OSTIA_INTAKE_URL must be set to the intake's http or https address when OSTIA_ROUTE_IN is on");
  const claimOstia = flag(env, fail, "OSTIA_CLAIM_OSTIA")
    ? { afterSeconds: seconds(env, fail, "OSTIA_ROUTE_CLAIM_OSTIA_SECONDS", "OSTIA_CLAIM_OSTIA is on"), leftOutSeconds: seconds(env, fail, "OSTIA_ROUTE_LEFT_OUT_SECONDS", "OSTIA_CLAIM_OSTIA is on") }
    : null;
  return { setupSeconds: seconds(env, fail, "OSTIA_ROUTE_SETUP_SECONDS", "OSTIA_ROUTE_IN is on"), setupTime: range(env, fail, "OSTIA_ROUTE_SETUP_TIME"), intake, claimOstia };
}

export function routeSettings(env: Env, agglayer: AgglayerSettings | null, fail: Fail): RouteSettings | null {
  const raw = env.OSTIA_ROUTE_OUT;
  if (raw === undefined || raw === "" || raw === "0") {
    if (flag(env, fail, "OSTIA_ROUTE_IN")) throw fail("OSTIA_ROUTE_IN needs OSTIA_ROUTE_OUT=1: the two directions share the book, the router and the route's page");
    if (flag(env, fail, "OSTIA_CLAIM_OSTIA")) throw fail("OSTIA_CLAIM_OSTIA needs OSTIA_ROUTE_IN=1");
    return null;
  }
  if (raw !== "1") throw fail(`OSTIA_ROUTE_OUT must be 1 or 0, not "${raw.slice(0, 20)}"`);
  if (!agglayer) throw fail("OSTIA_ROUTE_OUT needs AGGLAYER_BRIDGE=1: the move's last steps are read from the AggLayer bridge");
  const address = (name: string): string => {
    const v = env[name]?.trim() ?? "";
    if (!ADDRESS.test(v)) throw fail(`${name} must be set to a contract address (0x and 40 hex digits) when OSTIA_ROUTE_OUT is on`);
    return v.toLowerCase();
  };
  const [party, tokenFile] = [env.GATEWAY_PARTY, env.GATEWAY_LEDGER_TOKEN_FILE].map((v) => v?.trim() ?? "") as [string, string];
  if ((party === "") !== (tokenFile === "")) throw fail("GATEWAY_PARTY and GATEWAY_LEDGER_TOKEN_FILE must be set together");
  const flowIn = inSettings(env, fail);
  if (flowIn && !party) throw fail("OSTIA_ROUTE_IN reads the account's acceptance and Canton's payout limit as the gateway party: set GATEWAY_PARTY and GATEWAY_LEDGER_TOKEN_FILE");
  if (!flowIn && flag(env, fail, "OSTIA_CLAIM_OSTIA")) throw fail("OSTIA_CLAIM_OSTIA needs OSTIA_ROUTE_IN=1");
  return {
    router: address("OSTIA_ROUTER"), book: address("OSTIA_BOOK"), notTakenSeconds: seconds(env, fail, "OSTIA_ROUTE_NOT_TAKEN_SECONDS", "OSTIA_ROUTE_OUT is on"), ownClaimSeconds: seconds(env, fail, "OSTIA_ROUTE_OWN_CLAIM_SECONDS", "OSTIA_ROUTE_OUT is on"),
    time: range(env, fail, "OSTIA_ROUTE_TIME"), gateway: party ? { party, tokenFile } : null, in: flowIn,
  };
}

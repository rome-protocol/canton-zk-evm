/** What `GET /api/faucet` says. Amounts are whole numbers as decimal strings, in the coin's smallest unit. */
export interface FaucetInfo {
  on: boolean; address: string | null; balance: string | null; amount: string; perAddressSeconds: number;
  perIpSeconds?: number; maxPerHour?: number;
  /** How many requests are waiting for a batch. */
  queue?: number;
  /** The human check, when the faucet asks for one: the script to load and the key to give it. */
  captcha?: { siteKey: string; scriptUrl: string; widgetClass: string } | null;
}

/** Where a ticket is: waiting for a batch, sent and not final, final on Canton, or failed. */
export interface Ticket {
  ticket: string;
  status: "queued" | "sent" | "final" | "failed";
  position: number | null;
  to: string;
  amount: string;
  hash: string | null;
  /** The tracker's word for a sent transfer: pending or proving. */
  state: string | null;
  block: number | null;
  reason: string | null;
}

/** The ways a request for coin can end. `waitSeconds` is the answer's Retry-After, or null when it gave none. */
export type CoinResult =
  | { kind: "queued"; ticket: string; position: number; to: string; amount: string }
  | { kind: "limit"; which: "address" | "ip" | "hour"; waitSeconds: number | null; message: string }
  | { kind: "full"; waitSeconds: number | null; message: string }
  | { kind: "captcha"; message: string }
  | { kind: "problem"; message: string };

/** What reading a ticket gives: its state, or that the explorer does not know it, or that it could not be asked just now. */
export type TicketResult = { kind: "ticket"; ticket: Ticket } | { kind: "unknown" } | { kind: "unreachable" };

export interface FaucetClient {
  /** Throws an Error with a message fit to show when the faucet's information cannot be read. */
  info(): Promise<FaucetInfo>;
  /** Never throws: every outcome is a result. `captcha` is the human check's token, when the faucet asks for one. */
  request(address: string, captcha?: string): Promise<CoinResult>;
  /** Never throws. */
  ticket(id: string): Promise<TicketResult>;
}

const UNREACHABLE = "The explorer cannot be reached. Try again in a moment.";
const UNREADABLE = "The explorer did not answer in a way this page can read.";

async function read(fetchFn: typeof fetch, path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown>; wait: number | null } | null> {
  let response: Response;
  try {
    response = await fetchFn(path, init);
  } catch {
    return null;
  }
  const header = response.headers.get("Retry-After");
  const wait = header !== null && /^\d+$/.test(header) ? Number(header) : null;
  try {
    const body = await response.json();
    return typeof body === "object" && body !== null ? { status: response.status, body: body as Record<string, unknown>, wait } : { status: response.status, body: {}, wait };
  } catch {
    return { status: response.status, body: {}, wait };
  }
}

const message = (body: Record<string, unknown>, fallback: string) => (typeof body.error === "string" && body.error ? body.error : fallback);
const STATUSES = ["queued", "sent", "final", "failed"];

export function createFaucetClient(fetchFn: typeof fetch = (...args) => fetch(...args)): FaucetClient {
  return {
    async info() {
      const answer = await read(fetchFn, "/api/faucet");
      if (!answer) throw new Error(UNREACHABLE);
      if (answer.status !== 200) throw new Error(message(answer.body, UNREADABLE));
      return answer.body as unknown as FaucetInfo;
    },

    async request(address, captcha) {
      const answer = await read(fetchFn, "/api/faucet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(captcha ? { address, captcha } : { address }) });
      if (!answer) return { kind: "problem", message: UNREACHABLE };
      const { status, body, wait } = answer;
      if (status === 202) {
        return typeof body.ticket === "string" && typeof body.position === "number" && typeof body.to === "string" && typeof body.amount === "string"
          ? { kind: "queued", ticket: body.ticket, position: body.position, to: body.to, amount: body.amount }
          : { kind: "problem", message: UNREADABLE };
      }
      if (status === 429) {
        const which = body.reason === "address" || body.reason === "ip" ? body.reason : "hour";
        return { kind: "limit", which, waitSeconds: wait, message: message(body, "Try again later.") };
      }
      if (status === 503 && body.reason === "queue") return { kind: "full", waitSeconds: wait, message: message(body, "The line is full. Try again in a little while.") };
      if (status === 403 && body.reason === "captcha") return { kind: "captcha", message: message(body, "Complete the human check first.") };
      return { kind: "problem", message: message(body, UNREADABLE) };
    },

    async ticket(id) {
      const answer = await read(fetchFn, `/api/faucet/ticket/${encodeURIComponent(id)}`);
      if (!answer) return { kind: "unreachable" };
      if (answer.status === 404) return { kind: "unknown" };
      const t = answer.body;
      if (answer.status !== 200 || typeof t.ticket !== "string" || !STATUSES.includes(t.status as string)) return { kind: "unreachable" };
      return { kind: "ticket", ticket: t as unknown as Ticket };
    },
  };
}

/** What `GET /api/faucet` says. Amounts are whole numbers as decimal strings, in the coin's smallest unit. */
export interface FaucetInfo { on: boolean; address: string | null; balance: string | null; amount: string; perAddressSeconds: number }

/** The ways a request for coin can end. `waitSeconds` is the answer's Retry-After, or null when it gave none. */
export type CoinResult =
  | { kind: "sent"; hash: string; to: string; amount: string }
  | { kind: "limit"; waitSeconds: number | null }
  | { kind: "busy"; waitSeconds: number | null }
  | { kind: "problem"; message: string };

export interface FaucetClient {
  /** Throws an Error with a message fit to show when the faucet's information cannot be read. */
  info(): Promise<FaucetInfo>;
  /** Never throws: every outcome is a result. */
  request(address: string): Promise<CoinResult>;
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

export function createFaucetClient(fetchFn: typeof fetch = (...args) => fetch(...args)): FaucetClient {
  return {
    async info() {
      const answer = await read(fetchFn, "/api/faucet");
      if (!answer) throw new Error(UNREACHABLE);
      if (answer.status !== 200) throw new Error(message(answer.body, UNREADABLE));
      return answer.body as unknown as FaucetInfo;
    },

    async request(address) {
      const answer = await read(fetchFn, "/api/faucet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address }) });
      if (!answer) return { kind: "problem", message: UNREACHABLE };
      const { status, body, wait } = answer;
      if (status === 200) {
        return typeof body.hash === "string" && typeof body.to === "string" && typeof body.amount === "string"
          ? { kind: "sent", hash: body.hash, to: body.to, amount: body.amount }
          : { kind: "problem", message: UNREADABLE };
      }
      if (status === 429) return { kind: body.reason === "address" ? "limit" : "busy", waitSeconds: wait };
      return { kind: "problem", message: message(body, UNREADABLE) };
    },
  };
}

// The account service's client (apps/accounts). The page holds the account's key: it signs the multi-hash of its own onboarding (after checking it, topology.ts), each prepared
// transaction's hash, and each account-scoped request (X-Account-Signature). `signPrepared` in sign.ts is the only way a prepared transaction is signed here.
import { base64, hex, signOnboarding, signRequest, type CantonKey } from "./key.ts";
import { partyOf, verifyOnboarding } from "./topology.ts";

export type Command = { CreateCommand: { templateId: string; createArguments: object } } | { ExerciseCommand: { templateId: string; contractId: string; choice: string; choiceArgument: object } };
export interface DisclosedContract { templateId: string; contractId: string; createdEventBlob: string; synchronizerId: string }
export interface Prepared { party: string; preparedTransaction: string; preparedTransactionHash: string; hashingSchemeVersion: string }
export interface Holding { contractId: string; instrumentId: { admin: string; id: string }; amount: string; locked: boolean }
/** An allocation the account sent, by the contract id the participant committed. `allocation` is the token standard's specification (settlement and leg). */
export interface AllocationView {
  contractId: string;
  allocation: { settlement: { settlementRef: { id: string } } & Record<string, unknown>; transferLegId: string; transferLeg: { sender: string; receiver: string; amount: string; instrumentId: { admin: string; id: string } } };
  holdingCids: string[];
}
export interface OpenRequest { contractId: string; arguments: Record<string, unknown> }

const KINDS: Record<number, AccountsErrorKind> = { 400: "bad-request", 401: "unauthorized", 403: "forbidden", 404: "not-found", 409: "conflict", 422: "refused", 429: "rate-limited", 502: "unavailable", 503: "unavailable" };
export type AccountsErrorKind = "bad-request" | "unauthorized" | "forbidden" | "not-found" | "conflict" | "refused" | "rate-limited" | "unavailable" | "server" | "network";

/** An answer that is not a success. `retryAfter` (seconds) is set on a 429 and on a 503 that says it; `code` and `detail` carry the participant's refusal (422). */
export class AccountsError extends Error {
  readonly kind: AccountsErrorKind;
  readonly status: number;
  readonly retryAfter?: number;
  readonly code?: string;
  readonly detail?: unknown;
  constructor(kind: AccountsErrorKind, status: number, message: string, retryAfter?: number, code?: string, detail?: unknown) {
    super(message);
    this.name = "AccountsError";
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
    this.code = code;
    this.detail = detail;
  }
}

/** Retry-After as seconds: a number of seconds, or an HTTP date. */
export function retryAfterSeconds(value: string | null, now = Date.now()): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim());
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - now) / 1000));
}

const sha256Hex = async (text: string) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));

export class AccountsClient {
  private used = new Set<string>();   // the service takes each (account, second, signature) once: a repeat of a request takes an earlier second
  private base: string;
  private fetcher: typeof fetch;
  private clock: () => number;
  /** `base` is the service's origin ("" for this site). The reverse proxy passes the path unchanged, and the account signs that path. */
  constructor(base = "", fetcher: typeof fetch = (...a) => fetch(...a), clock: () => number = Date.now) {
    [this.base, this.fetcher, this.clock] = [base, fetcher, clock];
  }

  private async send(method: "GET" | "POST", path: string, body?: unknown, key?: CantonKey): Promise<any> {
    const text = body === undefined ? "" : JSON.stringify(body);   // signed exactly as it is sent
    const headers: Record<string, string> = body === undefined ? {} : { "content-type": "application/json" };
    if (key) headers["X-Account-Signature"] = await this.accountSignature(key, method, path, text);
    let r: Response;
    try { r = await this.fetcher(this.base + path, { method, headers, body: body === undefined ? undefined : text }); }
    catch (e) { throw new AccountsError("network", 0, e instanceof Error ? e.message : "the account service could not be reached"); }
    const answer = await r.json().catch(() => ({}));
    if (r.ok) return answer;
    const message = typeof answer?.error === "string" ? answer.error : `the account service answered ${r.status}`;
    throw new AccountsError(KINDS[r.status] ?? "server", r.status, message, retryAfterSeconds(r.headers.get("Retry-After"), this.clock()), answer?.code, answer?.detail);
  }

  /** `<unix seconds>.<base64 signature>` over "accounts-v1", the method, the path, the body's sha256 and the seconds, on five lines. */
  async accountSignature(key: CantonKey, method: string, path: string, body: string): Promise<string> {
    const digest = await sha256Hex(body);
    const now = Math.floor(this.clock() / 1000);
    let seconds = now;
    while (this.used.has(`${method} ${path} ${digest} ${seconds}`) && seconds > now - 50) seconds--;
    this.used.add(`${method} ${path} ${digest} ${seconds}`);
    const message = `accounts-v1\n${method}\n${path}\n${digest}\n${seconds}`;
    return `${seconds}.${base64(await signRequest(key, message))}`;
  }

  topology(publicKey: Uint8Array): Promise<{ party: string; exists: boolean; multiHash?: string; topologyTransactions?: string[]; blob?: string }> {
    return this.send("POST", "/accounts/v1/topology", { publicKey: base64(publicKey) });
  }
  allocate(blob: string, signature: Uint8Array): Promise<{ party: string; created: boolean }> {
    return this.send("POST", "/accounts/v1/allocate", { blob, signature: base64(signature) });
  }
  prepare(key: CantonKey, party: string, commands: Command[], disclosedContracts: DisclosedContract[] = []): Promise<Prepared> {
    return this.send("POST", "/accounts/v1/prepare", { party, commands, disclosedContracts }, key);
  }
  execute(key: CantonKey, preparedTransaction: string, party: string, signature: Uint8Array): Promise<{ updateId: string }> {
    return this.send("POST", "/accounts/v1/execute", { preparedTransaction, partySignatures: [{ party, signature: base64(signature) }] }, key);
  }
  async holdings(key: CantonKey, party: string): Promise<Holding[]> {
    return (await this.send("GET", `/accounts/v1/holdings/${party}`, undefined, key)).holdings;
  }

  async allocations(key: CantonKey, party: string): Promise<AllocationView[]> {
    return (await this.send("GET", `/accounts/v1/allocations/${party}`, undefined, key)).allocations;
  }
  /** The account's open deposit and redeem requests, by contract id: where a page resumes. */
  async openRequests(key: CantonKey, party: string): Promise<{ depositRequests: OpenRequest[]; redeemRequests: OpenRequest[] }> {
    return this.send("GET", `/accounts/v1/open/${party}`, undefined, key);
  }

  /** The account of this key. The party is the page's own (the key's fingerprint), never the service's word. A found account is returned. A new account is made only from a topology that is
   * this key's onboarding on `participant` and nothing else (topology.ts): the page decodes it, computes the multi-hash itself, and signs its own multi-hash if the service's is the same.
   * `confirm` runs after that check and before anything is signed (the wallet is asked again, and refused if it signs another way: `confirmKey`). */
  async open(key: CantonKey, participant: string, confirm?: () => Promise<void>): Promise<string> {
    const party = await partyOf(key.publicKey);
    const found = await this.topology(key.publicKey);
    if (found.party !== party) throw new AccountsError("server", 200, `the account service names ${found.party}, not this key's account ${party}`);
    if (found.exists) return party;
    if (!found.multiHash || !found.blob || !Array.isArray(found.topologyTransactions)) throw new AccountsError("server", 200, "the topology has no multi-hash, blob or transactions");
    const answer = { party: found.party, multiHash: found.multiHash, topologyTransactions: found.topologyTransactions };
    await verifyOnboarding(answer, key.publicKey, participant);   // the check comes before the wallet is asked again; signOnboarding runs it again, so nothing is signed without it
    await confirm?.();
    const made = await this.allocate(found.blob, await signOnboarding(key, answer, participant));
    if (made.party !== party) throw new AccountsError("server", 200, `the account service made ${made.party}, not this key's account ${party}`);
    return party;
  }
}

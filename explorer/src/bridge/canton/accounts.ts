// The account service's client (apps/accounts). The page holds the account's key: it signs the multi-hash of its own onboarding (after checking it, topology.ts), each prepared
// transaction's hash, and each account-scoped request (X-Account-Signature). `signPrepared` in sign.ts is the only way a prepared transaction is signed here.
import { base64, hex, signOnboarding, signRequest, type CantonKey } from "./key.ts";
import { partyOf, verifyOnboarding } from "./topology.ts";
import { timeoutSignal } from "../../timeout.ts";

export type Command = { CreateCommand: { templateId: string; createArguments: object } } | { ExerciseCommand: { templateId: string; contractId: string; choice: string; choiceArgument: object } };
export interface DisclosedContract { templateId: string; contractId: string; createdEventBlob: string; synchronizerId: string }
export interface Prepared { party: string; preparedTransaction: string; preparedTransactionHash: string; hashingSchemeVersion: string; maxRecordTime?: string }
export interface Holding { contractId: string; instrumentId: { admin: string; id: string }; amount: string; locked: boolean }
/** An allocation the account sent, by the contract id the participant committed. `allocation` is the token standard's specification (settlement and leg). */
export interface AllocationView {
  contractId: string;
  allocation: { settlement: { settlementRef: { id: string } } & Record<string, unknown>; transferLegId: string; transferLeg: { sender: string; receiver: string; amount: string; instrumentId: { admin: string; id: string } } };
  holdingCids: string[];
}
/** A transfer waiting for its receiver to accept it, which the account sent or was offered (`GET /accounts/v1/transfers`): the transfer instruction's contract id and the token standard's description of the transfer. */
export interface TransferView {
  contractId: string;
  transfer: { sender: string; receiver: string; amount: string; instrumentId: { admin: string; id: string }; requestedAt?: string | null; executeBefore?: string | null };
  status?: unknown;
  /** The ledger's package name of the template that implements the contract. */
  packageName?: string | null;
}
export interface OpenRequest { contractId: string; arguments: Record<string, unknown> }
/** What `GET /accounts/v1/open` says: the open requests, and the account's two standing acceptances (null when the account has none). */
export interface OpenState { depositRequests: OpenRequest[]; redeemRequests: OpenRequest[]; twinAcceptance: OpenRequest | null; withdrawalAcceptance: OpenRequest | null }
/** The token standard's `ChoiceContext`: the registry's context for a choice and the contracts the transaction discloses. The registry's accept-context answer is exactly this, at its top level. */
export interface ChoiceContext { choiceContextData: object; disclosedContracts?: DisclosedContract[] }
/** The allocation factory's answer: the factory and its `ChoiceContext` (the token standard's `FactoryWithChoiceContext`). */
export interface FactoryAnswer { factoryId: string; choiceContext: ChoiceContext }
/** The transfer factory's answer: the same, and how the registry will carry the transfer out: `direct` (the receiver has a preapproval, or the registry completes it at once), `self`, or `offer` (the receiver has to accept). */
export interface TransferFactoryAnswer extends FactoryAnswer { transferKind?: string }
export type Choice = { context: object; disclosedContracts: DisclosedContract[] };

const isObject = (x: unknown): x is object => typeof x === "object" && x !== null && !Array.isArray(x);
/** The context and the disclosed contracts of a `ChoiceContext`: `choiceContextData` must be there (an object), or nothing is built from the answer. */
export function choiceOf(c: unknown): Choice {
  const answer = c as { choiceContextData?: unknown; disclosedContracts?: unknown } | null;
  if (!isObject(c) || !isObject(answer?.choiceContextData)) throw new AccountsError("server", 200, "the registry's answer has no choiceContextData", undefined, "no_choice_context");
  if (answer!.disclosedContracts !== undefined && !Array.isArray(answer!.disclosedContracts)) throw new AccountsError("server", 200, "the registry's disclosedContracts is not a list", undefined, "no_choice_context");
  return { context: answer!.choiceContextData as object, disclosedContracts: (answer!.disclosedContracts ?? []) as DisclosedContract[] };
}
/** The accept-context answer is a `ChoiceContext` itself: read from its top level (and never from a nested `choiceContext`). */
export const acceptChoice = (answer: unknown): Choice => choiceOf(answer);
/** The withdraw-context answer is a `ChoiceContext` itself, too. */
export const withdrawChoice = (answer: unknown): Choice => choiceOf(answer);
/** The factory's choice context, which the token standard nests under `choiceContext`. */
export const factoryChoice = (answer: { choiceContext?: unknown }): Choice => choiceOf(answer?.choiceContext);

const KINDS: Record<number, AccountsErrorKind> = { 400: "bad-request", 401: "unauthorized", 403: "forbidden", 404: "not-found", 409: "conflict", 422: "refused", 424: "unavailable", 429: "rate-limited", 502: "unavailable", 503: "unavailable" };
export type AccountsErrorKind = "bad-request" | "unauthorized" | "forbidden" | "not-found" | "conflict" | "refused" | "rate-limited" | "unavailable" | "server" | "network";

/** An answer that is not a success. `retryAfter` (seconds) is set on a 429 and on a 503 that says it; `code` and `detail` carry the participant's refusal (422). */
export class AccountsError extends Error {
  readonly kind: AccountsErrorKind;
  readonly status: number;
  readonly retryAfter?: number;
  readonly code?: string;
  readonly detail?: unknown;
  /** On a 424 (or, from an older service, a 502) the service relayed from the token registry: the status the registry itself answered. */
  readonly registryStatus?: number;
  constructor(kind: AccountsErrorKind, status: number, message: string, retryAfter?: number, code?: string, detail?: unknown, registryStatus?: number) {
    super(message);
    this.name = "AccountsError";
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
    this.code = code;
    this.detail = detail;
    this.registryStatus = registryStatus;
  }
}

/**
 * An execute that got no definite answer (the request was lost or timed out, or the service answered 5xx): the transaction may still be recorded, up to `recordBy` (ms since 1970, the
 * service's `maxRecordTime`). Until then nothing may be signed again for the same step; after it the transaction can never commit.
 */
export class Unanswered extends AccountsError {
  readonly recordBy: number;
  constructor(cause: AccountsError, recordBy: number) {
    super(cause.kind, cause.status, cause.message, cause.retryAfter, cause.code, cause.detail, cause.registryStatus);
    this.name = "Unanswered";
    this.recordBy = recordBy;
  }
}
/** How long the page waits for the service's answer to an execute: above the service's own 60 s wait for the ledger, so the page hears the service's answer and not its own timeout. */
export const EXECUTE_MS = 90_000;
/** Used when the service did not say its record time: its transaction is recorded within ten minutes of its prepare, and a prepare is not older than the page's own look. */
const RECORD_WINDOW_MS = 11 * 60_000;

/** Retry-After as seconds: a number of seconds, or an HTTP date. */
export function retryAfterSeconds(value: string | null, now = Date.now()): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim());
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - now) / 1000));
}

const sha256Hex = async (text: string) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));

export class AccountsClient {
  private used = new Set<string>();   // the service takes each POST's (account, second, signature) once and does not remember GETs: a repeat of a request takes an earlier second (harmless for a GET)
  private base: string;
  private fetcher: typeof fetch;
  private clock: () => number;
  /** `base` is the service's origin ("" for this site). The reverse proxy passes the path unchanged, and the account signs that path. */
  constructor(base = "", fetcher: typeof fetch = (...a) => fetch(...a), clock: () => number = Date.now) {
    [this.base, this.fetcher, this.clock] = [base, fetcher, clock];
  }

  private recordBy = new Map<string, number>();   // a prepared transaction -> the time (ms) the service will record it by, until it is executed

  private reading = new Map<string, Promise<any>>();   // the signed GETs on their way: an identical one asked for meanwhile gets the same answer

  private send(method: "GET" | "POST", path: string, body?: unknown, key?: CantonKey, timeoutMs?: number): Promise<any> {
    // A read that changes nothing is shared while it is in flight: one request and one answer for the same path and account (the page never sends two at once).
    // A write forgets the reads on their way, when it is sent and when it ends, so a read asked after a write never joins one that started before it.
    if (method !== "GET" || !key || body !== undefined) {
      this.reading.clear();
      return this.request(method, path, body, key, timeoutMs).finally(() => this.reading.clear());
    }
    const id = `${path} ${hex(key.publicKey)}`;
    const going = this.reading.get(id);
    if (going) return going;
    const p = this.request(method, path, body, key, timeoutMs).finally(() => { if (this.reading.get(id) === p) this.reading.delete(id); });
    this.reading.set(id, p);
    return p;
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown, key?: CantonKey, timeoutMs?: number): Promise<any> {
    const text = body === undefined ? "" : JSON.stringify(body);   // signed exactly as it is sent
    const headers: Record<string, string> = body === undefined ? {} : { "content-type": "application/json" };
    if (key) headers["X-Account-Signature"] = await this.accountSignature(key, method, path, text);
    let r: Response;
    try { r = await this.fetcher(this.base + path, { method, headers, body: body === undefined ? undefined : text, signal: timeoutSignal(timeoutMs) }); }
    catch (e) { throw new AccountsError("network", 0, e instanceof Error ? e.message : "the account service could not be reached"); }
    const answer = await r.json().catch(() => ({}));
    if (r.ok) return answer;
    // A 409 answers {error: <stable code>, message: <words>}; every other error answers {error: <message>} (a 422 adds `code` and `detail`).
    const conflict = r.status === 409 && typeof answer?.error === "string";
    const message = conflict && typeof answer?.message === "string" ? answer.message : typeof answer?.error === "string" ? answer.error : `the account service answered ${r.status}`;
    throw new AccountsError(KINDS[r.status] ?? "server", r.status, message, retryAfterSeconds(r.headers.get("Retry-After"), this.clock()), conflict ? answer.error : answer?.code, answer?.detail, typeof answer?.registryStatus === "number" ? answer.registryStatus : undefined);
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
  async prepare(key: CantonKey, party: string, commands: Command[], disclosedContracts: DisclosedContract[] = []): Promise<Prepared> {
    const prepared: Prepared = await this.send("POST", "/accounts/v1/prepare", { party, commands, disclosedContracts }, key);
    const by = Date.parse(String(prepared.maxRecordTime));
    if (typeof prepared.preparedTransaction === "string") {
      this.recordBy.set(prepared.preparedTransaction, Number.isNaN(by) ? this.clock() + RECORD_WINDOW_MS : by);
      if (this.recordBy.size > 20) this.recordBy.delete(this.recordBy.keys().next().value!);
    }
    return prepared;
  }
  /** Executes a prepared transaction. An answer that is not definite (the page's request failed or timed out, or the service answered 500, 502 or 503) throws `Unanswered`: the ledger may still record it. */
  async execute(key: CantonKey, preparedTransaction: string, party: string, signature: Uint8Array): Promise<{ updateId: string }> {
    try {
      const done = await this.send("POST", "/accounts/v1/execute", { preparedTransaction, partySignatures: [{ party, signature: base64(signature) }] }, key, EXECUTE_MS);
      this.recordBy.delete(preparedTransaction);
      return done;
    } catch (e) {
      if (e instanceof AccountsError && (e.kind === "network" || e.status >= 500)) throw new Unanswered(e, this.recordBy.get(preparedTransaction) ?? this.clock() + RECORD_WINDOW_MS);
      this.recordBy.delete(preparedTransaction);
      throw e;
    }
  }
  async holdings(key: CantonKey, party: string): Promise<Holding[]> {
    return (await this.send("GET", `/accounts/v1/holdings/${party}`, undefined, key)).holdings;
  }

  async allocations(key: CantonKey, party: string): Promise<AllocationView[]> {
    return (await this.send("GET", `/accounts/v1/allocations/${party}`, undefined, key)).allocations;
  }
  /** The account's open deposit and redeem requests, by contract id (where a page resumes), and its two acceptances. */
  async openRequests(key: CantonKey, party: string): Promise<OpenState> {
    return this.send("GET", `/accounts/v1/open/${party}`, undefined, key);
  }

  /** The token standard's allocation factory of the registry `admin`: `choiceArguments` is the choice's argument as the account will sign it, with an empty context. */
  allocationFactory(key: CantonKey, admin: string, party: string, choiceArguments: object): Promise<FactoryAnswer> {
    return this.send("POST", `/accounts/v1/registry/${admin}/allocation-factory`, { choiceArguments, excludeDebugFields: true, party }, key);
  }
  /** The token standard's transfer factory of the registry `admin`: `choiceArguments` is the choice's argument as the account will sign it, with an empty context. */
  transferFactory(key: CantonKey, admin: string, party: string, choiceArguments: object): Promise<TransferFactoryAnswer> {
    return this.send("POST", `/accounts/v1/registry/${admin}/transfer-factory`, { choiceArguments, excludeDebugFields: true, party }, key);
  }
  /** The transfers waiting for a receiver's acceptance that the account sends or is offered (at most 100: `more` says there are others). */
  async transfers(key: CantonKey, party: string): Promise<{ transfers: TransferView[]; more: boolean }> {
    const answer = await this.send("GET", `/accounts/v1/transfers/${party}`, undefined, key);
    return { transfers: Array.isArray(answer?.transfers) ? answer.transfers : [], more: answer?.more === true };
  }
  /** The context for the account to accept the transfer `instruction` (a transfer offered to it) at the registry `admin`. */
  acceptContext(key: CantonKey, admin: string, instruction: string, party: string): Promise<ChoiceContext> {
    return this.send("POST", `/accounts/v1/registry/${admin}/transfer-instruction/${instruction}/accept-context`, { party, meta: {}, excludeDebugFields: true }, key);
  }
  /** The context for the account to withdraw (take back) the transfer `instruction` that it sent, at the registry `admin`. */
  transferWithdrawContext(key: CantonKey, admin: string, instruction: string, party: string): Promise<ChoiceContext> {
    return this.send("POST", `/accounts/v1/registry/${admin}/transfer-instruction/${instruction}/withdraw-context`, { party, meta: {}, excludeDebugFields: true }, key);
  }
  /** The context for the account to withdraw its allocation `allocation` at the registry `admin`. */
  allocationWithdrawContext(key: CantonKey, admin: string, allocation: string, party: string): Promise<ChoiceContext> {
    return this.send("POST", `/accounts/v1/registry/${admin}/allocation/${allocation}/withdraw-context`, { party, meta: {}, excludeDebugFields: true }, key);
  }
  /** Test Canton Coin for the account: an offer to accept, or done. A 404 means the faucet is off here. */
  faucet(key: CantonKey, party: string): Promise<{ transferInstructionCid?: string; completed?: boolean }> {
    return this.send("POST", "/accounts/v1/faucet", { party }, key);
  }

  /** Whether the service knows this key's account (it is there already). It never makes one and signs nothing: the party is the page's own (its hint and the key's fingerprint), never the service's word. */
  async find(publicKey: Uint8Array, hint: string): Promise<string | null> {
    const party = await partyOf(publicKey, hint);
    const found = await this.topology(publicKey);
    if (found.party !== party) throw new AccountsError("server", 200, `the account service names ${found.party}, not this key's account ${party}`);
    return found.exists ? party : null;
  }

  /** The account of this key. The party is the page's own (the key's fingerprint), never the service's word. A found account is returned. A new account is made only from a topology that is
   * this key's onboarding on `participant`, named `hint::fingerprint`, and nothing else (topology.ts): the page decodes it, computes the multi-hash itself, and signs its own multi-hash if the service's is the same.
   * `confirm` runs after that check and before anything is signed (the wallet is asked again, and refused if it signs another way: `confirmKey`). */
  async open(key: CantonKey, participant: string, hint: string, confirm?: () => Promise<void>): Promise<string> {
    const party = await partyOf(key.publicKey, hint);
    const found = await this.topology(key.publicKey);
    if (found.party !== party) throw new AccountsError("server", 200, `the account service names ${found.party}, not this key's account ${party}`);
    if (found.exists) return party;
    if (!found.multiHash || !found.blob || !Array.isArray(found.topologyTransactions)) throw new AccountsError("server", 200, "the topology has no multi-hash, blob or transactions");
    const answer = { party: found.party, multiHash: found.multiHash, topologyTransactions: found.topologyTransactions };
    await verifyOnboarding(answer, key.publicKey, participant, hint);   // the check comes before the wallet is asked again; signOnboarding runs it again, so nothing is signed without it
    await confirm?.();
    const made = await this.allocate(found.blob, await signOnboarding(key, answer, participant, hint));
    if (made.party !== party) throw new AccountsError("server", 200, `the account service made ${made.party}, not this key's account ${party}`);
    return party;
  }
}

// What the account service and a connected wallet's ledger answer, and what a move's code reads of the answers: the types, the errors and the registry's choice context. These files hold no key and sign
// nothing, so a build without the Bridge account (VITE_BRIDGE_ACCOUNT) still has them; the service's client (accounts.ts) and the key (key.ts) are only in a build that has the account.

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

/** Retry-After as seconds: a number of seconds, or an HTTP date. */
export function retryAfterSeconds(value: string | null, now = Date.now()): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim());
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - now) / 1000));
}

/** The transaction is not what the page asked for (or could not be checked): nothing is signed. */
export class UnexpectedTransaction extends Error {
  constructor(why: string) { super(`The prepared transaction is not what was asked for: ${why}`); this.name = "UnexpectedTransaction"; }
}

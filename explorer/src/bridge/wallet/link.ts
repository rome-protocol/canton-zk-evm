// A connected Canton wallet, as the Bridge uses it: the account it holds (a party id), what it is called, the one call that has it show, sign and send a command, and the one call that reads the ledger as
// that party. The wallet speaks the dApp standard (CIP-0103: `request({ method, params })` and events), so any provider of that shape fits: the SDK's, Loop's, or a fake one in a test.
// The page never signs here: the wallet decides what it signs, and shows it to its person first. Nothing in this file imports the wallet libraries.
import { AccountsError, Unanswered } from "../canton/accounts.ts";
import type { Built } from "../canton/commands.ts";
import { PROVISIONAL_RECORD_MS, Refused } from "../moves/moves.ts";

/** The part of a CIP-0103 provider the page uses. */
export interface Cip103 {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
  on(event: string, listener: (payload: any) => void): unknown;
  removeListener(event: string, listener: (payload: any) => void): unknown;
}
/** A JSON Ledger API call through the wallet: it answers only for the connected party. */
export interface LedgerRequest { requestMethod: "get" | "post"; resource: string; body?: object; query?: object }

export interface WalletLink {
  /** The wallet's name as the screen shows it. */
  readonly name: string;
  /** The Canton party the wallet holds for its person: the account the moves are made for. */
  readonly party: string;
  /** Has the wallet show, sign and send one command. Gives the update id. One command at a time: the same command, while it is on its way, gets the one answer and is not sent twice. */
  submit(built: Built): Promise<string>;
  ledgerApi(request: LedgerRequest): Promise<unknown>;
  /** Ends the connection. */
  disconnect(): Promise<void>;
  /** Says once when the wallet's account is no longer this one (disconnected, or another account chosen). Returns a function that stops listening. */
  onLost(fn: () => void): () => void;
  /** True once the wallet's account is gone: nothing more is sent. */
  readonly closed: boolean;
}

export interface LinkOptions {
  name: string;
  /** How the connection is ended where the library holds more than the provider (the SDK's session). Default: the provider's own `disconnect`. */
  disconnect?: () => Promise<unknown>;
  /** How long one command may wait for the wallet's answer (a person has to approve it). */
  waitMs?: number;
  now?: () => number;
  newCommandId?: () => string;
}

/** The longest a person is given to approve one command in the wallet. */
export const APPROVAL_MS = 6 * 60_000;
const PARTY = /^[^:\s]+::1220[0-9a-f]{64}$/;

const NOT_CONNECTED = "Your Canton wallet is not connected. Connect it again, then continue.";
export const WALLET_WORDS = {
  declined: "You declined it in your wallet.",
  notConnected: NOT_CONNECTED,
  rejected: "Canton did not accept this step. Nothing was changed.",
  cannot: "Your Canton wallet cannot make this step.",
  busy: "Your Canton wallet is busy. Wait a minute, then continue.",
  failed: "Your Canton wallet did not complete this step. Nothing was changed.",
  cannotRead: "Your Canton wallet does not let this page read your account.",
} as const;

const code = (e: unknown): unknown => (e as { code?: unknown } | null | undefined)?.code;

/** What a refusal of the wallet means, in the page's own sentences. Null for an error that says nothing certain about whether the command was taken. */
export function refusalOf(e: unknown): Refused | null {
  switch (code(e)) {
    case 4001: return new Refused(WALLET_WORDS.declined);
    case 4100: case 4900: case 4901: return new Refused(WALLET_WORDS.notConnected);
    case -32003: return new Refused(WALLET_WORDS.rejected);
    case 4200: case -32601: case -32004: return new Refused(WALLET_WORDS.cannot);
    case -32005: return new Refused(WALLET_WORDS.busy);
    default: return null;
  }
}

const newCommandId = (): string => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

/** The party the wallet holds for its person: the primary account, which must be set up and be a Canton party id. */
async function partyOf(provider: Cip103): Promise<string> {
  let account: { partyId?: unknown; status?: unknown; primary?: unknown } | undefined;
  try { account = (await provider.request({ method: "getPrimaryAccount" })) as typeof account; } catch (e) {
    const refused = refusalOf(e);
    if (refused && code(e) !== 4200 && code(e) !== -32601) throw refused;
  }
  if (!account?.partyId) {
    const all = (await provider.request({ method: "listAccounts" }).catch(() => [])) as { partyId?: unknown; status?: unknown; primary?: unknown }[];
    account = Array.isArray(all) ? all.find((a) => a?.primary === true) ?? all[0] : undefined;
  }
  if (!account || typeof account.partyId !== "string") throw new Refused("Your Canton wallet has no account to use yet. Set one up in the wallet, then connect again.");
  if (typeof account.status === "string" && account.status !== "allocated") throw new Refused("Your Canton wallet has not finished setting up its account. Finish in the wallet, then connect again.");
  if (!PARTY.test(account.partyId)) throw new Refused("This Canton account is not one this page can use.");
  return account.partyId;
}

/** One command at a time. The same command, while it is on its way (running or waiting its turn), gets the one answer and is not sent twice; a different command waits for the one before it. */
function oneAtATime(run: (built: Built) => Promise<string>): (built: Built) => Promise<string> {
  const pending = new Map<string, Promise<string>>();
  let tail: Promise<unknown> = Promise.resolve();
  return (built) => {
    const same = JSON.stringify(built.command);
    const on = pending.get(same);
    if (on) return on;
    const mine = tail.then(() => run(built)).finally(() => pending.delete(same));
    pending.set(same, mine);
    tail = mine.catch(() => {});
    return mine;
  };
}

/** The link to a wallet whose provider is connected: reads its account, listens for it changing. Throws `Refused` (in words) when the wallet holds no account the page can use. */
export async function linkWallet(provider: Cip103, o: LinkOptions): Promise<WalletLink> {
  const party = await partyOf(provider);
  const now = o.now ?? Date.now, waitMs = o.waitMs ?? APPROVAL_MS, fresh = o.newCommandId ?? newCommandId;
  const lost = new Set<() => void>();
  let closed = false;
  const lose = () => { if (closed) return; closed = true; stop(); for (const f of [...lost]) f(); lost.clear(); };
  const accounts = (list: unknown) => {
    const all = Array.isArray(list) ? (list as { partyId?: unknown; primary?: unknown }[]) : [];
    const primary = all.find((a) => a?.primary === true) ?? all[0];
    if (!primary || primary.partyId !== party) lose();
  };
  const status = (event: { connection?: { isConnected?: unknown } } | undefined) => { if (event?.connection?.isConnected === false) lose(); };
  provider.on("accountsChanged", accounts);
  provider.on("statusChanged", status);
  const stop = () => { provider.removeListener("accountsChanged", accounts); provider.removeListener("statusChanged", status); };
  const unanswered = () => new Unanswered(new AccountsError("unavailable", 0, "the wallet gave no answer"), now() + PROVISIONAL_RECORD_MS);

  const send = oneAtATime(async (built) => {
    if (closed) throw new Refused(NOT_CONNECTED);
    const commandId = fresh();
    let listener: (event: { status?: string; commandId?: string; payload?: { updateId?: unknown } }) => void = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The events are listened for before the command is sent: the wallet may answer before its request returns.
    const outcome = new Promise<string>((resolve, reject) => {
      listener = (event) => {
        if (event?.commandId !== commandId) return;
        if (event.status === "executed") resolve(typeof event.payload?.updateId === "string" ? event.payload.updateId : "");
        else if (event.status === "failed") reject(new Refused(WALLET_WORDS.failed));
      };
      timer = setTimeout(() => reject(unanswered()), waitMs);
    });
    outcome.catch(() => {});
    provider.on("txChanged", listener);
    try {
      try {
        await provider.request({
          method: "prepareExecute",
          params: { commandId, commands: [built.command], actAs: [party], ...(built.disclosedContracts.length > 0 ? { disclosedContracts: built.disclosedContracts } : {}) },
        });
      } catch (e) {
        if (e instanceof Refused || e instanceof Unanswered) throw e;
        throw refusalOf(e) ?? unanswered();   // any other answer says nothing of whether the wallet took it: the move waits and looks before it signs again
      }
      return await outcome;
    } finally {
      clearTimeout(timer);
      provider.removeListener("txChanged", listener);
    }
  });

  return {
    name: o.name, party,
    get closed() { return closed; },
    submit: send,
    async ledgerApi(request) {
      if (closed) throw new Refused(NOT_CONNECTED);
      return provider.request({ method: "ledgerApi", params: request });
    },
    async disconnect() {
      lose();
      try { await (o.disconnect ? o.disconnect() : provider.request({ method: "disconnect" })); } catch { /* the wallet is let go either way */ }
    },
    onLost(fn) { if (closed) { queueMicrotask(fn); return () => {}; } lost.add(fn); return () => { lost.delete(fn); }; },
  };
}

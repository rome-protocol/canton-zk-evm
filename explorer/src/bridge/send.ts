// Send and receive on Canton: what the account panel's "Send on Canton" and "Incoming" do with the person's Canton account. The Bridge page loads this file once the account is open, so none of it
// is in the page's first script. Nothing here asks the wallet: the page signs each Canton step with the account's key, after it has held the prepared transaction to what the person typed (canton/sign.ts).
import { parseAmount, showUnits, tenDecimals } from "./amounts.ts";
import { cover } from "./adapter.ts";
import type { Account } from "./account.ts";
import { acceptChoice, factoryChoice, type TransferView } from "./canton/accounts.ts";
import { acceptTransfer, implementationOf, transfer, transferTimes } from "./canton/commands.ts";
import { Refused } from "./moves/moves.ts";
import type { Pair } from "./tokens.ts";
import { checkAmount, checkReceiver } from "./sendwords.ts";
import { PageError } from "./words.ts";

/** Whether this page can sign for a token, which it can when the package that implements it is known (Canton Coin and the twins). */
export function canSend(pair: Pair): boolean {
  try { implementationOf(pair.canton.id); return true; } catch { return false; }
}

export interface SendResult {
  /** The Canton update that holds the transfer, for the explorer's link. */
  updateId: string;
  /** The receiver has to accept it first (an offer, or the registry did not say it was done); it is in their account only when the registry says `direct`. */
  waiting: boolean;
}

/** A transfer offered to the account, for a token this build lists. */
export interface Incoming {
  /** The transfer's contract id (what the account accepts). */
  id: string;
  pair: Pair;
  /** The amount as the person reads it. */
  amount: string;
  from: string;
  /** When the offer lapses (ms since 1970), or null. */
  until: number | null;
}

/** A transfer the account sent that its receiver has not accepted yet: the tokens are in it, not in the receiver's account. */
export interface Sent {
  id: string;
  pair: Pair;
  amount: string;
  to: string;
}

export interface Sender {
  /** Sends `amount` (typed) of the pair's token to `receiver`. Signs one Canton command. */
  send(pair: Pair, amount: string, receiver: string): Promise<SendResult>;
  /** The transfers waiting for this account to accept, and the ones it sent that are not accepted yet, for the tokens of `pairs` (one read). */
  waiting(pairs: Pair[]): Promise<{ offers: Incoming[]; sent: Sent[] }>;
  /** Accepts one. Signs one Canton command. */
  accept(offer: Incoming): Promise<void>;
  /** Whether this page can send the token (and accept it): the package that implements it is known. */
  can(pair: Pair): boolean;
}

/** The pair a transfer view is about, when the page can show it: the token is one the page lists and can sign for, the contract is implemented by that token's package (the view alone is computed by the contract's own code, so it is not trusted for this),
 * and the amount is a decimal of at most 10 places. */
function listed(v: TransferView, pairs: Pair[]): { pair: Pair; amount: string } | null {
  const t = v.transfer;
  const pair = pairs.find((p) => p.canton.admin === t.instrumentId?.admin && p.canton.id === t.instrumentId?.id);
  if (!pair || !canSend(pair) || v.packageName !== implementationOf(pair.canton.id)) return null;
  try { return { pair, amount: showUnits(parseAmount(String(t.amount), 10).twin, 10) }; } catch { return null; }
}

/** The transfers of `views` that the account is offered: it is the receiver, and the token is one the page lists and can accept (a lapsed offer is left out). */
export function offersOf(views: TransferView[], party: string, pairs: Pair[], now = Date.now()): Incoming[] {
  const out: Incoming[] = [];
  for (const v of views) {
    const t = v.transfer;
    if (!t || t.receiver !== party || t.sender === party) continue;
    const shown = listed(v, pairs);
    if (!shown) continue;
    const until = typeof t.executeBefore === "string" ? Date.parse(t.executeBefore) : NaN;
    if (!Number.isNaN(until) && until <= now) continue;
    out.push({ id: v.contractId, ...shown, from: t.sender, until: Number.isNaN(until) ? null : until });
  }
  return out;
}

/** The transfers of `views` that the account sent and that nobody has accepted: its tokens are in them until the receiver accepts. A lapsed one is kept, since its tokens are still in it. */
export function sentOf(views: TransferView[], party: string, pairs: Pair[]): Sent[] {
  const out: Sent[] = [];
  for (const v of views) {
    const t = v.transfer;
    if (!t || t.sender !== party || t.receiver === party) continue;
    const shown = listed(v, pairs);
    if (shown) out.push({ id: v.contractId, ...shown, to: t.receiver });
  }
  return out;
}

/** The sender and the receiver of the account `a`. `now` is the clock the transfer's times are made from. */
export function createSender(a: Pick<Account, "key" | "party" | "client" | "submit" | "closed">, now: () => number = Date.now): Sender {
  const open = () => { if (a.closed) throw new PageError("account_closed", "The wallet's account changed, so this account does nothing more."); };
  return {
    can: canSend,
    async send(pair, amount, receiver) {
      open();
      const to = checkReceiver(receiver, a.party);
      const units = checkAmount(amount, pair, null);
      const instrument = { admin: pair.canton.admin, id: pair.canton.id };
      const [held, requests] = await Promise.all([a.client.holdings(a.key, a.party), a.client.openRequests(a.key, a.party)]);
      // A redeem request does not lock its holdings, but its release burns them: a send must not spend the holdings an open redeem names.
      const named = new Set(requests.redeemRequests.flatMap((r) => (Array.isArray(r.arguments.holdings) ? r.arguments.holdings.filter((h): h is string => typeof h === "string") : [])));
      let inputs: string[];
      try { inputs = cover(held, instrument, tenDecimals(units), named); } catch (e) {
        if (!(e instanceof Refused) || named.size === 0) throw e;
        try { cover(held, instrument, tenDecimals(units)); } catch { throw e; }
        throw new Refused("Part of your tokens is held by a redeem that is still open. Finish it, or remove it in Activity, then try again.");
      }
      const t = { admin: instrument.admin, instrumentId: instrument.id, receiver: to, amount: tenDecimals(units), inputHoldings: inputs, ...transferTimes(now()) };   // the times the registry is asked for are the times the account signs
      const asked = transfer(a.party, t, { contractId: "", context: { values: {} }, disclosedContracts: [] });
      const factory = await a.client.transferFactory(a.key, instrument.admin, a.party, asked.intent.args);
      open();
      const updateId = await a.submit(transfer(a.party, t, { contractId: factory.factoryId, ...factoryChoice(factory) }));
      return { updateId, waiting: factory.transferKind !== "direct" };   // only the registry saying `direct` makes it done; anything else (or nothing) is waiting
    },
    async waiting(pairs) {
      open();
      const { transfers } = await a.client.transfers(a.key, a.party);
      return { offers: offersOf(transfers, a.party, pairs, now()), sent: sentOf(transfers, a.party, pairs) };
    },
    async accept(offer) {
      open();
      const registry = acceptChoice(await a.client.acceptContext(a.key, offer.pair.canton.admin, offer.id, a.party));
      open();
      await a.submit(acceptTransfer(a.party, offer.id, registry, implementationOf(offer.pair.canton.id)));
    },
  };
}

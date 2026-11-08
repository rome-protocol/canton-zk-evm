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
  /** The receiver has to accept it first (an offer); otherwise it is in their account. */
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

export interface Sender {
  /** Sends `amount` (typed) of the pair's token to `receiver`. Signs one Canton command. */
  send(pair: Pair, amount: string, receiver: string): Promise<SendResult>;
  /** The transfers waiting for this account to accept, for the tokens of `pairs`. */
  incoming(pairs: Pair[]): Promise<Incoming[]>;
  /** Accepts one. Signs one Canton command. */
  accept(offer: Incoming): Promise<void>;
  /** Whether this page can send the token (and accept it): the package that implements it is known. */
  can(pair: Pair): boolean;
}

/** The transfers of `views` that the account is offered: it is the receiver, and the token is one the page lists and can accept (a lapsed offer, and an amount that is not a decimal of at most 10 places, are left out). */
export function offersOf(views: TransferView[], party: string, pairs: Pair[], now = Date.now()): Incoming[] {
  const out: Incoming[] = [];
  for (const v of views) {
    const t = v.transfer;
    if (!t || t.receiver !== party || t.sender === party) continue;
    const pair = pairs.find((p) => p.canton.admin === t.instrumentId?.admin && p.canton.id === t.instrumentId?.id);
    if (!pair || !canSend(pair)) continue;
    const until = typeof t.executeBefore === "string" ? Date.parse(t.executeBefore) : NaN;
    if (!Number.isNaN(until) && until <= now) continue;
    let amount: string;
    try { amount = showUnits(parseAmount(String(t.amount), 10).twin, 10); } catch { continue; }
    out.push({ id: v.contractId, pair, amount, from: t.sender, until: Number.isNaN(until) ? null : until });
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
      return { updateId, waiting: factory.transferKind === "offer" };
    },
    async incoming(pairs) {
      open();
      return offersOf((await a.client.transfers(a.key, a.party)).transfers, a.party, pairs, now());
    },
    async accept(offer) {
      open();
      const registry = acceptChoice(await a.client.acceptContext(a.key, offer.pair.canton.admin, offer.id, a.party));
      open();
      await a.submit(acceptTransfer(a.party, offer.id, registry, implementationOf(offer.pair.canton.id)));
    },
  };
}

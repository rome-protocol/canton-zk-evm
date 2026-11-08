// The Canton side of a move, on the account service: what `createMove` asks of `CantonAdapter`, built from the account library. Every call looks at the ledger first and does
// nothing again for a ref, a label or a deposit id that is already there: a reload may come before or after a command reached the ledger, and the move cannot tell which.
import type { Address, Hex } from "viem";
import { AccountsError, factoryChoice, withdrawChoice, type AccountsClient, type Holding } from "./canton/accounts.ts";
import { allocate, archiveDepositRequest, depositRequest, redeemRequest, withdrawAllocation, type Allocation, type Built, type Chain } from "./canton/commands.ts";
import type { CantonKey } from "./canton/key.ts";
import { Refused, Waited, type CantonAdapter } from "./moves/moves.ts";
import { depositIdOf, sameId } from "./moves/state.ts";

export interface AdapterDeps {
  client: Pick<AccountsClient, "holdings" | "allocations" | "openRequests" | "allocationFactory" | "allocationWithdrawContext">;
  key: CantonKey;
  party: string;
  chain: Chain;
  /** Prepares, checks, signs and executes one command of the account (`submit` in canton/sign.ts). */
  submit(built: Built): Promise<unknown>;
  sleep(ms: number): Promise<void>;
  now?: () => number;
  /** How often a wait looks, and how many times before it gives up with `Waited`. A signed look counts against the service's rate for the account (30 a minute). */
  pollMs?: number;
  maxPolls?: number;
}

const units = (amount: string): bigint => { const [whole = "0", fraction = ""] = amount.split("."); return BigInt(whole) * 10n ** 10n + BigInt(fraction.padEnd(10, "0").slice(0, 10)); };
const bare = (hexText: string) => hexText.replace(/^0x/, "").toLowerCase();

/** The fewest unlocked holdings of the instrument (the largest first) that cover the amount. */
export function cover(held: Holding[], instrument: { admin: string; id: string }, amount: string): string[] {
  const need = units(amount);
  const mine = held.filter((h) => !h.locked && h.instrumentId.admin === instrument.admin && h.instrumentId.id === instrument.id).sort((a, b) => (units(a.amount) < units(b.amount) ? 1 : units(a.amount) > units(b.amount) ? -1 : 0));
  const picked: string[] = [];
  let sum = 0n;
  for (const h of mine) { if (sum >= need) break; picked.push(h.contractId); sum += units(h.amount); }
  if (sum < need) throw new Refused("You do not hold enough of this token on Canton.");
  return picked;
}

export function cantonAdapter(d: AdapterDeps): CantonAdapter {
  const now = d.now ?? Date.now;
  const open = () => d.client.openRequests(d.key, d.party);
  const allocationOf = async (label: string) => (await d.client.allocations(d.key, d.party)).find((a) => a.allocation.settlement.settlementRef.id === label);
  /** Looks until `found`; a look the service refuses for now (a rate, a restart) is tried again. */
  async function until(found: () => Promise<boolean>, polls = d.maxPolls ?? 60) {
    for (let i = 0; i < polls; i++) {
      try { if (await found()) return; } catch (e) { if (!(e instanceof AccountsError && ["rate-limited", "unavailable", "network"].includes(e.kind))) throw e; }
      await d.sleep(d.pollMs ?? 3000);
    }
    throw new Waited("Canton has not shown this step yet. Continue to look again; nothing is signed twice.");
  }
  const hasRedeem = async (ref: string) => (await open()).redeemRequests.some((r) => r.arguments.ref === ref);
  const hasDeposit = async (id: string) => (await open()).depositRequests.some((r) => sameId(r.arguments.depositId, id));

  return {
    party: () => d.party,

    async signRedeem(a) {
      if (await hasRedeem(a.ref)) return;
      const holdings = cover(await d.client.holdings(d.key, d.party), { admin: d.chain.gateway, id: `erc20:${bare(a.asset)}` }, a.amount);
      await d.submit(redeemRequest(d.party, d.chain, a.asset as Address, holdings, a.amount, a.recipient, a.ref));
    },
    waitRedeem: (ref) => until(() => hasRedeem(ref)),

    async allocateDeposit({ instrument, amount, label }) {
      if (await allocationOf(label)) return;
      const at = (ms: number) => new Date(now() + ms).toISOString();   // the times the registry is asked for are the times the account signs
      const a: Allocation = {
        admin: instrument.admin, instrumentId: instrument.id, amount, label, inputHoldings: cover(await d.client.holdings(d.key, d.party), instrument, amount),
        requestedAt: at(-60_000), allocateBefore: at(3_600_000), settleBefore: at(7_200_000),
      };
      const asked = allocate(d.party, d.chain, a, { contractId: "", context: { values: {} }, disclosedContracts: [] });
      const factory = await d.client.allocationFactory(d.key, instrument.admin, d.party, asked.intent.args);
      await d.submit(allocate(d.party, d.chain, a, { contractId: factory.factoryId, ...factoryChoice(factory) }));
    },
    async signDeposit({ label, depositId, recipient }) {
      if (!sameId(depositIdOf(d.party, label), depositId)) throw new Refused("This deposit's id is not the one its label makes. Nothing was signed.");
      if (await hasDeposit(depositId)) return;
      const made: { cid?: string } = {};
      await until(async () => (made.cid = (await allocationOf(label))?.contractId) !== undefined, 10);   // the allocation was made a moment ago: its read may lag
      await d.submit(await depositRequest(d.party, d.chain, made.cid!, recipient, label));
    },
    waitDeposit: (depositId: Hex) => until(() => hasDeposit(depositId)),

    async depositDeadline(label) {
      const found = await allocationOf(label);
      const t = Date.parse(String((found?.allocation.settlement as { settleBefore?: unknown } | undefined)?.settleBefore));
      return Number.isNaN(t) ? null : t;
    },
    async recoverDeposit({ label, depositId }) {
      // Each look is made again after the last command, so a repeat (a reload between the two) does only what is left: nothing is signed for a thing that is gone.
      const found = await allocationOf(label);
      if (found) {
        const leg = found.allocation.transferLeg.instrumentId;
        const context = withdrawChoice(await d.client.allocationWithdrawContext(d.key, leg.admin, found.contractId, d.party));
        await d.submit(withdrawAllocation(d.party, found.contractId, leg.id, context));
      }
      const request = (await open()).depositRequests.find((r) => sameId(r.arguments.depositId, depositId));
      if (request) await d.submit(archiveDepositRequest(d.party, request.contractId));
    },
  };
}

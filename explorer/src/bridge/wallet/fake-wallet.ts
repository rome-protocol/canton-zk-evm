// A fake Canton wallet for the tests: a CIP-0103 provider over a small ledger of its own. It answers the dApp standard's requests as a wallet does (the party it holds, the active contracts for that party,
// prepare-and-execute with an `executed` event), and applies each command it is given to the ledger, so the next read shows it, as on the real ledger. Tests only: nothing in the page imports this file.
import type { Chain } from "../canton/commands.ts";
import type { Cip103 } from "./link.ts";

export interface FakeContract {
  contractId: string;
  templateId: string;      // "<module>:<entity>", as the ledger names it after the package id
  packageName: string;
  createArgument?: Record<string, unknown>;
  /** An interface view of the contract: the interface's own name ("Splice.Api.Token.HoldingV1:Holding") and its view value. */
  view?: { interface: string; value: unknown };
}

export const id = (tag: string, n: number) => `${tag}::1220${n.toString(16).padStart(2, "0").repeat(32)}`;
export const WALLET_PARTY = id("alice", 0xa1);
export const CHAIN: Chain = { operator: id("operator", 1), confirmer: id("confirmer", 2), gateway: id("gateway", 3), builder: id("builder", 4), chainId: 770101 };
export const COIN = { admin: id("DSO", 5), id: "Amulet" };

export interface FakeOptions {
  party?: string;
  /** Page size the ledger answers with, to make a read follow its pages. */
  pageSize?: number;
  /** Decides what a command does besides the default effect; returns an error code to refuse it (4001 declined, -32003 rejected). */
  refuse?: (command: unknown) => number | undefined;
  /** A command the wallet takes but never says it executed (an answer that does not come). */
  silent?: (command: unknown) => boolean;
}

/** The fake wallet: `provider` is what the page talks to; the rest is what a test looks at and sets up. */
export function fakeWallet(o: FakeOptions = {}) {
  const party = o.party ?? WALLET_PARTY;
  const contracts: FakeContract[] = [];
  const requests: { method: string; params: any }[] = [];
  const executed: unknown[] = [];
  const listeners = new Map<string, Set<(payload: any) => void>>();
  let n = 0, connected = true, status: string = "allocated";
  const emit = (event: string, payload: unknown) => listeners.get(event)?.forEach((l) => l(payload));
  const account = () => ({ primary: true, partyId: party, status, hint: "alice", publicKey: "pk", namespace: "ns", networkId: "canton:devnet", signingProviderId: "participant" });

  const add = (c: Omit<FakeContract, "contractId"> & { contractId?: string }) => { const made = { ...c, contractId: c.contractId ?? "00" + (++n).toString(16).padStart(2, "0").repeat(30) }; contracts.push(made); return made; };
  const remove = (contractId: string) => { const i = contracts.findIndex((c) => c.contractId === contractId); if (i >= 0) contracts.splice(i, 1); };
  const entityOf = (templateId: string) => templateId.split(":").slice(-2).join(":");

  /** What a command does to the ledger. */
  function apply(command: any) {
    if (command.CreateCommand) {
      const { templateId, createArguments } = command.CreateCommand as { templateId: string; createArguments: Record<string, unknown> };
      const pkg = templateId.slice(1).split(":")[0]!;
      add({ templateId: "pkgid:" + entityOf(templateId), packageName: pkg, createArgument: createArguments });
    } else if (command.ExerciseCommand) {
      const { choice, contractId, choiceArgument } = command.ExerciseCommand as { choice: string; contractId: string; choiceArgument: any };
      if (choice === "Archive" || choice === "Allocation_Withdraw") remove(contractId);
      if (choice === "AllocationFactory_Allocate") {
        const spec = choiceArgument.allocation;
        add({ templateId: "pkgid:Splice.Amulet:AmuletAllocation", packageName: "splice-amulet", view: { interface: "Splice.Api.Token.AllocationV1:Allocation", value: { allocation: spec, holdingCids: choiceArgument.inputHoldingCids } } });
      }
    }
  }

  function ledgerApi(p: any) {
    if (p.resource !== "/v2/state/active-contracts-page") throw Object.assign(new Error("not allowed"), { code: 4200 });
    const filters = p.body.eventFormat.filtersByParty[party]?.cumulative as { identifierFilter: any }[] | undefined;
    if (!filters) throw Object.assign(new Error("filters must name the connected party"), { code: -32602 });
    const found: any[] = [];
    for (const c of contracts) {
      for (const { identifierFilter: f } of filters) {
        if (f.InterfaceFilter && c.view && f.InterfaceFilter.value.interfaceId.endsWith(c.view.interface)) found.push({ contractEntry: { JsActiveContract: { createdEvent: { contractId: c.contractId, templateId: c.templateId, packageName: c.packageName, interfaceViews: [{ interfaceId: "x", viewValue: c.view.value }] } } } });
        if (f.TemplateFilter && !c.view && f.TemplateFilter.value.templateId.endsWith(entityOf(c.templateId))) found.push({ contractEntry: { JsActiveContract: { createdEvent: { contractId: c.contractId, templateId: c.templateId, packageName: c.packageName, createArgument: c.createArgument } } } });
      }
    }
    const size = Math.min(o.pageSize ?? 1000, p.body.maxPageSize ?? 1000);
    const from = p.body.pageToken ? Number(p.body.pageToken) : 0;
    const page = found.slice(from, from + size);
    return { activeContracts: page, activeAtOffset: 42, ...(from + size < found.length ? { nextPageToken: String(from + size) } : {}) };
  }

  const handlers: Record<string, (params: any) => unknown> = {
    connect: () => ({ isConnected: connected, isNetworkConnected: connected }),
    isConnected: () => ({ isConnected: connected, isNetworkConnected: connected }),
    status: () => ({ provider: { id: "fake-wallet", providerType: "browser" }, connection: { isConnected: connected, isNetworkConnected: connected } }),
    getPrimaryAccount: () => account(),
    listAccounts: () => [account()],
    disconnect: () => { connected = false; return null; },
    ledgerApi,
    prepareExecute: (params) => {
      const [command] = params.commands as unknown[];
      const code = o.refuse?.(command);
      if (code !== undefined) throw Object.assign(new Error("refused"), { code });
      if (params.actAs?.some((a: string) => a !== party)) throw Object.assign(new Error("not your party"), { code: 4100 });
      if (o.silent?.(command)) return null;
      apply(command);
      executed.push(command);
      queueMicrotask(() => emit("txChanged", { status: "executed", commandId: params.commandId, payload: { updateId: "update-" + executed.length, completionOffset: 100 + executed.length } }));
      return null;
    },
  };

  const provider: Cip103 = {
    async request({ method, params }) {
      requests.push({ method, params });
      const h = handlers[method];
      if (!h) throw Object.assign(new Error("no such method"), { code: -32601 });
      return h(params);
    },
    on(event, listener) { (listeners.get(event) ?? listeners.set(event, new Set()).get(event)!).add(listener); return provider; },
    removeListener(event, listener) { listeners.get(event)?.delete(listener); return provider; },
  };
  return {
    provider, party, contracts, requests, executed, emit, add, remove,
    setStatus: (s: string) => { status = s; },
    /** Gives the page a holding of an instrument (the token standard's holding view). */
    holding: (amount: string, instrument: { admin: string; id: string }, o2: { locked?: boolean; owner?: string } = {}) =>
      add({ templateId: "pkgid:Splice.Amulet:Amulet", packageName: "splice-amulet", view: { interface: "Splice.Api.Token.HoldingV1:Holding", value: { owner: o2.owner ?? party, instrumentId: instrument, amount, lock: o2.locked ? { holders: [] } : null, meta: { values: {} } } } }),
    commands: () => executed as any[],
  };
}

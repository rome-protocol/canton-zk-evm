// The Canton commands the Bridge page makes, each with the intent that `signPrepared` holds the service's prepared transaction to: the command itself (its
// arguments are the intent, in the order of the Daml fields) and what its transaction may be. Fields are in the order the Daml declares them.
import type { Command, DisclosedContract } from "./accounts.ts";
import type { Chain } from "./env.ts";
import { hex } from "./key.ts";

export interface Intent {
  party: string;                                                  // the account: the only actor, and the only signatory of a create
  kind: "create" | "exercise";
  template: { packageName: string; module: string; entity: string };   // a create's template; an exercise's, unless it is made through an interface
  interface?: { module: string; entity: string };                  // an exercise through an interface (the template is then the contract's own, which the registry names)
  choice?: string;
  contractId?: string;
  args: Record<string, unknown>;                                   // createArguments or choiceArgument: every field, in declaration order
  ignore?: string[];                                               // dotted paths in args whose value the page does not pin (a registry's choice context)
  implementation?: string;                                         // an exercise through an interface: the package of the contract that implements it (the instrument's)
  ledgerTimes?: boolean;                                           // the transaction may carry a minimum or maximum ledger time (otherwise it is refused if it does)
}
export interface Built { command: Command; intent: Intent; disclosedContracts: DisclosedContract[] }

export { chainFromEnv, participantFromEnv, type Chain } from "./env.ts";

const CHAIN = { packageName: "canton-zk-evm", module: "Zk.Chain" };
const TWIN = { packageName: "ostia-twin", module: "Twin.Twin" };
const ALLOCATION_FACTORY = { module: "Splice.Api.Token.AllocationInstructionV1", entity: "AllocationFactory" };
/** The package that implements the token standard for an instrument, which an allocation's transaction must name. Canton Coin and the twins; the test token's is `Allocation.implementation`. */
export function implementationOf(instrumentId: string): string {
  if (instrumentId === "Amulet") return "splice-amulet";
  if (/^erc20:[0-9a-f]{40}$/.test(instrumentId)) return "ostia-twin";
  throw new Error(`no implementation is known for the instrument ${instrumentId}`);
}
const id = (t: { packageName: string; module: string; entity: string }) => `#${t.packageName}:${t.module}:${t.entity}`;

function create(party: string, template: Intent["template"], args: Record<string, unknown>): Built {
  return { command: { CreateCommand: { templateId: id(template), createArguments: args } }, intent: { party, kind: "create", template, args }, disclosedContracts: [] };
}

/** "I accept withdrawals": the account's standing acceptance of Canton tokens from the gateway (made once). */
export const withdrawalAcceptance = (party: string, c: Chain): Built =>
  create(party, { ...CHAIN, entity: "WithdrawalAcceptance" }, { party, chainId: String(c.chainId), operator: c.operator, confirmer: c.confirmer, gateway: c.gateway, builder: c.builder });

/** "I accept twins": the account's standing acceptance of twins of the gateway's tokens (made once). The twin's admin is the gateway party. */
export const twinAcceptance = (party: string, c: Chain): Built => create(party, { ...TWIN, entity: "TwinAcceptance" }, { party, admin: c.gateway });

/** The deposit request that names the allocation made before it (the allocation's contract id, read from `GET /accounts/v1/allocations/{party}`, not from the holdings). `label` makes the deposit id. */
export async function depositRequest(party: string, c: Chain, allocation: string, recipient: string, label: string): Promise<Built> {
  const depositId = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`deposit,${party},${label}`))));
  return create(party, { ...CHAIN, entity: "DepositRequest" }, {
    operator: c.operator, confirmer: c.confirmer, gateway: c.gateway, builder: c.builder, chainId: String(c.chainId), depositor: party, depositId,
    recipient: bare(recipient), allocation, label,
  });
}
const bare = (address: string) => address.replace(/^0x/, "").toLowerCase();   // an EVM address as the Daml writes it: 40 lowercase hex digits

/** The request to burn a twin for an ERC-20 the vault pays out to `recipient` under `ref`. `holdings` are the twin holdings (contract ids) that cover `amount` (a twin amount, 10 decimals). */
export const redeemRequest = (party: string, c: Chain, erc20: string, holdings: string[], amount: string, recipient: string, ref: string): Built =>
  create(party, { ...CHAIN, entity: "RedeemRequest" }, {
    holder: party, operator: c.operator, confirmer: c.confirmer, gateway: c.gateway, builder: c.builder, chainId: String(c.chainId),
    token: bare(erc20), holdings, amount, recipient: bare(recipient), ref,
  });

export interface Allocation {
  admin: string;            // the token's registry (the instrument's admin)
  instrumentId: string;
  amount: string;
  label: string;            // names the settlement and the leg
  inputHoldings: string[];  // the holdings that cover the amount
  requestedAt: string;      // ISO times, as the registry's choice context was asked for them
  allocateBefore: string;
  settleBefore: string;
  implementation?: string;  // the instrument's implementing package where `implementationOf` does not know it (the test token's)
}
/** The token standard's `AllocationFactory_Allocate`: the account locks `amount` for the gateway, with the operator as the executor. The factory, the choice context and the disclosed
 * contracts are the registry's answer (checked by the caller); the context is the registry's and the page does not pin it, the rest is what the account signs. */
export function allocate(party: string, c: Chain, a: Allocation, factory: { contractId: string; context: object; disclosedContracts: DisclosedContract[] }): Built {
  const none = { values: {} };
  const args = {
    expectedAdmin: a.admin,
    allocation: {
      settlement: { executor: c.operator, settlementRef: { id: a.label, cid: null }, requestedAt: a.requestedAt, allocateBefore: a.allocateBefore, settleBefore: a.settleBefore, meta: none },
      transferLegId: "leg-" + a.label,
      transferLeg: { sender: party, receiver: c.gateway, amount: a.amount, instrumentId: { admin: a.admin, id: a.instrumentId }, meta: none },
    },
    requestedAt: a.requestedAt,
    inputHoldingCids: a.inputHoldings,
    extraArgs: { context: factory.context, meta: none },
  };
  return {
    command: { ExerciseCommand: { templateId: id({ packageName: "splice-api-token-allocation-instruction-v1", ...ALLOCATION_FACTORY }), contractId: factory.contractId, choice: "AllocationFactory_Allocate", choiceArgument: args } },
    intent: { party, kind: "exercise", template: { packageName: "splice-api-token-allocation-instruction-v1", ...ALLOCATION_FACTORY }, interface: ALLOCATION_FACTORY, choice: "AllocationFactory_Allocate", contractId: factory.contractId, args, ignore: ["extraArgs.context"], implementation: a.implementation ?? implementationOf(a.instrumentId), ledgerTimes: true },   // the standard's deadlines are the transaction's ledger time bounds
    disclosedContracts: factory.disclosedContracts,
  };
}

const TRANSFER_INSTRUCTION = { module: "Splice.Api.Token.TransferInstructionV1", entity: "TransferInstruction" };
/** The token standard's `TransferInstruction_Accept`: the account takes a transfer offered to it (test Canton Coin from the faucet). The context and the contracts are the registry's. The
 * transaction may carry the offer's deadline as a ledger time bound. `implementation` is the package of the instrument (Canton Coin's by default). */
export function acceptTransfer(party: string, instruction: string, registry: { context: object; disclosedContracts: DisclosedContract[] }, implementation = "splice-amulet"): Built {
  const args = { extraArgs: { context: registry.context, meta: { values: {} } } };
  const template = { packageName: "splice-api-token-transfer-instruction-v1", ...TRANSFER_INSTRUCTION };
  return {
    command: { ExerciseCommand: { templateId: id(template), contractId: instruction, choice: "TransferInstruction_Accept", choiceArgument: args } },
    intent: { party, kind: "exercise", template, interface: TRANSFER_INSTRUCTION, choice: "TransferInstruction_Accept", contractId: instruction, args, ignore: ["extraArgs.context"], implementation, ledgerTimes: true },
    disclosedContracts: registry.disclosedContracts,
  };
}

const ALLOCATION = { module: "Splice.Api.Token.AllocationV1", entity: "Allocation" };
/**
 * The token standard's `Allocation_Withdraw`: the account takes back an allocation it sent (the tokens of a deposit that cannot settle). The standard lets only the sender do it. The context and the
 * contracts are the registry's. The transaction may carry a ledger time bound, as the registry's context sets it. `instrumentId` names the package that implements the allocation (the instrument's).
 */
export function withdrawAllocation(party: string, allocation: string, instrumentId: string, registry: { context: object; disclosedContracts: DisclosedContract[] }): Built {
  const args = { extraArgs: { context: registry.context, meta: { values: {} } } };
  const template = { packageName: "splice-api-token-allocation-v1", ...ALLOCATION };
  return {
    command: { ExerciseCommand: { templateId: id(template), contractId: allocation, choice: "Allocation_Withdraw", choiceArgument: args } },
    intent: { party, kind: "exercise", template, interface: ALLOCATION, choice: "Allocation_Withdraw", contractId: allocation, args, ignore: ["extraArgs.context"], implementation: implementationOf(instrumentId), ledgerTimes: true },
    disclosedContracts: registry.disclosedContracts,
  };
}

/** The depositor archives their own deposit request (the Daml's implicit `Archive`, which the depositor, its only signatory, controls): nothing else is in the transaction. */
export function archiveDepositRequest(party: string, request: string): Built {
  const template = { ...CHAIN, entity: "DepositRequest" };
  return {
    command: { ExerciseCommand: { templateId: id(template), contractId: request, choice: "Archive", choiceArgument: {} } },
    intent: { party, kind: "exercise", template, choice: "Archive", contractId: request, args: {} },
    disclosedContracts: [],
  };
}

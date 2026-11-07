// Signing only what was meant. The service's `preparedTransactionHash` is never signed as given: the page decodes the prepared transaction, holds it to the intent of
// the command it asked for, hashes it itself, and signs its own hash if the service's is the same. The decode and the hash are Digital Asset's own
// (@canton-network/core-tx-visualizer, hashing scheme V2), checked against transactions of the pinned Canton in fixtures.json.
import { decodePreparedTransaction, hashPreparedTransaction } from "@canton-network/core-tx-visualizer";
import type { PreparedTransaction, Value } from "@canton-network/core-ledger-proto";
import type { AccountsClient, Prepared } from "./accounts.ts";
import type { Built, Intent } from "./commands.ts";
import { fromBase64, type CantonKey } from "./key.ts";

export const HASHING_SCHEME = "HASHING_SCHEME_VERSION_V2";

/** The transaction is not what the page asked for (or could not be checked): nothing is signed. */
export class UnexpectedTransaction extends Error {
  constructor(why: string) { super(`The prepared transaction is not what was asked for: ${why}`); this.name = "UnexpectedTransaction"; }
}
const refuse = (why: string): never => { throw new UnexpectedTransaction(why); };

const trimmed = (s: string) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);   // a numeric as Canton writes it (10 decimals) and as the page does
const MICROS = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?Z$/;
const micros = (iso: string): string => {
  const m = MICROS.exec(iso);
  if (!m || Number.isNaN(Date.parse(m[1] + "Z"))) return refuse(`${iso} is not a time`);
  return String(BigInt(Date.parse(m[1] + "Z")) * 1000n + BigInt((m[2] ?? "").padEnd(6, "0")));
};
const sub = (path: string, key: string) => (path ? `${path}.${key}` : key);
const isMap = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Holds a decoded value to what the page's command carried: the same fields in the same order (and the same labels), every one equal. `ignore` paths are not compared. */
function matches(v: Value, want: unknown, path: string, ignore: string[]): void {
  if (ignore.includes(path)) return;
  const at = path || "the arguments";
  const s = v.sum;
  const equal = (ok: boolean, got: unknown) => { if (!ok) refuse(`${at} is ${JSON.stringify(got)}, not ${JSON.stringify(want)}`); };
  switch (s.oneofKind) {
    case "party": return equal(s.party === want, s.party);
    case "text": return equal(s.text === want, s.text);
    case "contractId": return equal(s.contractId === want, s.contractId);
    case "bool": return equal(s.bool === want, s.bool);
    case "int64": return equal(String(want) === s.int64, s.int64);
    case "numeric": return equal((typeof want === "string" || typeof want === "number") && trimmed(s.numeric) === trimmed(String(want)), s.numeric);
    case "timestamp": return equal(typeof want === "string" && micros(want) === s.timestamp, s.timestamp);
    case "optional":
      if (s.optional.value === undefined) return equal(want === null, "none");
      if (want === null) return refuse(`${at} is set, not none`);
      return matches(s.optional.value, want, path, ignore);
    case "list": {
      const items = s.list.elements;
      if (!Array.isArray(want) || want.length !== items.length) return refuse(`${at} is a list of ${items.length}, not what was asked`);
      return items.forEach((e, i) => matches(e, want[i], `${path}[${i}]`, ignore));
    }
    case "textMap": {
      const entries = s.textMap.entries;
      if (!isMap(want) || entries.length !== Object.keys(want).length) return refuse(`${at} is a map of ${entries.length} entries, not what was asked`);
      return entries.forEach((e) => {
        if (!Object.hasOwn(want, e.key) || !e.value) refuse(`${at} has the key ${e.key}`);
        matches(e.value!, want[e.key], sub(path, e.key), ignore);
      });
    }
    case "record": {
      const fields = s.record.fields;
      if (!isMap(want) || fields.length !== Object.keys(want).length) return refuse(`${at} has ${fields.length} fields, not what was asked`);
      const keys = Object.keys(want);
      return fields.forEach((f, i) => {
        if (f.label !== keys[i]) refuse(`${at} has the field ${f.label} where ${keys[i]} was asked`);
        if (!f.value) refuse(`${sub(path, f.label)} is empty`);
        matches(f.value!, want[f.label], sub(path, f.label), ignore);
      });
    }
    default: return refuse(`${at} is a ${s.oneofKind}, which the page did not ask for`);
  }
}

const names = (id: { moduleName: string; entityName: string } | undefined) => (id ? `${id.moduleName}:${id.entityName}` : "none");
const alone = (what: string, got: string[], party: string) => { if (got.length !== 1 || got[0] !== party) refuse(`${what} is ${JSON.stringify(got)}, not the account alone`); };

/** Refuses a transaction that is not the one command of the intent, made by the account. What is beneath the root (the choice's own consequences) is the Daml code's, and is covered by the hash. */
export function checkIntent(tx: PreparedTransaction, intent: Intent): void {
  alone("the submitter", tx.metadata?.submitterInfo?.actAs ?? [], intent.party);
  const roots = tx.transaction?.roots ?? [];
  if (roots.length !== 1) refuse(`it has ${roots.length} root nodes, not one`);
  const node = tx.transaction?.nodes.find((n) => n.nodeId === roots[0]);
  if (node?.versionedNode.oneofKind !== "v1") return refuse("the root node is missing or not a v1 node");
  const t = node.versionedNode.v1.nodeType;
  const { template } = intent;
  if (t.oneofKind === "create" && intent.kind === "create") {
    const c = t.create;
    if (c.packageName !== template.packageName || names(c.templateId) !== `${template.module}:${template.entity}`) refuse(`it creates ${c.packageName} ${names(c.templateId)}`);
    alone("the signatory", c.signatories, intent.party);
    if (!c.argument) refuse("the create has no arguments");
    return matches(c.argument!, intent.args, "", intent.ignore ?? []);
  }
  if (t.oneofKind === "exercise" && intent.kind === "exercise") {
    const e = t.exercise;
    if (e.choiceId !== intent.choice || e.contractId !== intent.contractId) refuse(`it exercises ${e.choiceId} on ${e.contractId}`);
    alone("the acting party", e.actingParties, intent.party);
    const through = intent.interface
      ? names(e.interfaceId) === `${intent.interface.module}:${intent.interface.entity}`
      : e.interfaceId === undefined && e.packageName === template.packageName && names(e.templateId) === `${template.module}:${template.entity}`;
    if (!through) refuse(`it exercises through ${names(e.interfaceId)} on ${e.packageName} ${names(e.templateId)}`);
    if (!e.chosenValue) refuse("the exercise has no argument");
    return matches(e.chosenValue!, intent.args, "", intent.ignore ?? []);
  }
  return refuse(`the root node is a ${t.oneofKind}, not a ${intent.kind}`);
}

/** The signature of a prepared transaction that is the intent's, whose hash the page computed itself and found to be the service's. */
export async function signPrepared(key: CantonKey, intent: Intent, prepared: Prepared): Promise<Uint8Array> {
  if (prepared.party !== intent.party) refuse("it is for another party");
  if (prepared.hashingSchemeVersion !== HASHING_SCHEME) refuse(`the hashing scheme is ${prepared.hashingSchemeVersion}, not ${HASHING_SCHEME}`);
  let tx: PreparedTransaction;
  try { tx = decodePreparedTransaction(prepared.preparedTransaction, { readUnknownField: "throw" }); }
  catch (e) { return refuse(`it does not decode (${e instanceof Error ? e.message : "?"})`); }
  checkIntent(tx, intent);
  const hash = await hashPreparedTransaction(tx, "base64");
  if (hash !== prepared.preparedTransactionHash) refuse("its hash is not the service's hash");
  return key.sign(fromBase64(hash));
}

/** Prepare, check, sign and execute one command of the account. Gives the update id. */
export async function submit(client: AccountsClient, key: CantonKey, party: string, built: Built): Promise<string> {
  const prepared = await client.prepare(key, party, [built.command], built.disclosedContracts);
  const signature = await signPrepared(key, built.intent, prepared);
  return (await client.execute(key, prepared.preparedTransaction, party, signature)).updateId;
}

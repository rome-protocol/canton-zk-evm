import { readFileSync } from "node:fs";

type Schema = Record<string, any>;
export interface Spec { paths: Record<string, Record<string, any>>; components: { schemas: Record<string, Schema> } }

/** Canton's own OpenAPI document, as JSON (CI saves it from a running Canton, as JSON: explorer/check-ledger-api.sh). */
export const loadSpec = (file: string): Spec => JSON.parse(readFileSync(file, "utf8")) as Spec;

/**
 * The part of OpenAPI the JSON Ledger API's documents use: $ref, oneOf, object, array, string, integer, number, boolean, enum and required.
 * With `strict`, a key the schema does not name is an error, so a misspelt field in a request cannot pass. Returns the errors.
 */
export function validate(spec: Spec, schema: Schema, value: unknown, strict: boolean, at = "$"): string[] {
  if (schema.$ref) return validate(spec, spec.components.schemas[(schema.$ref as string).split("/").pop()!]!, value, strict, at);
  if (schema.oneOf) {
    const tries = (schema.oneOf as Schema[]).map((s) => validate(spec, s, value, strict, at));
    return tries.some((e) => e.length === 0) ? [] : [`${at}: matches none of ${tries.length} alternatives (${tries[0]![0]})`];
  }
  if (value === null && schema.nullable) return [];
  const is = (t: string) => (t === "array" ? Array.isArray(value) : t === "object" ? typeof value === "object" && value !== null && !Array.isArray(value)
    : t === "integer" ? Number.isInteger(value) : typeof value === t);
  if (schema.type && !is(schema.type)) return [`${at}: expected ${schema.type}`];
  if (schema.enum && !schema.enum.includes(value)) return [`${at}: ${JSON.stringify(value)} is not one of ${schema.enum.join(", ")}`];
  if (schema.type === "array") return (value as unknown[]).flatMap((v, i) => (schema.items ? validate(spec, schema.items, v, strict, `${at}[${i}]`) : []));
  if (schema.type !== "object" && !schema.properties) return [];
  const o = value as Record<string, unknown>;
  const errors = ((schema.required ?? []) as string[]).filter((k) => o[k] === undefined).map((k) => `${at}: ${k} is required`);
  for (const [k, v] of Object.entries(o)) {
    const sub = schema.properties?.[k] ?? (typeof schema.additionalProperties === "object" ? schema.additionalProperties : undefined);
    if (sub) errors.push(...validate(spec, sub, v, strict, `${at}.${k}`));
    else if (strict && schema.properties) errors.push(`${at}: ${k} is not a field of this object`);
  }
  return errors;
}

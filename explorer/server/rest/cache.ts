/**
 * What each answer may be cached for (design 6.1). Chain facts that can never change are immutable; an answer built from more than that (it has fields that
 * arrive later: lifecycle, stage 2, verification) is kept for a few seconds and carries an ETag so that a cache in front can ask cheaply; a list is kept for a second.
 */
import { createHash } from "node:crypto";
import type { Answer } from "../api.ts";

export type Rule = "immutable" | "composite" | "list";

export const CACHE_CONTROL: Record<Rule, string> = {
  immutable: "public, max-age=31536000, immutable",
  composite: "public, max-age=3",
  list: "public, max-age=1",
};

const texts = new WeakMap<object, string>();
/** A body as text, serialised once: the tag is made from the same text that is sent. */
export function textOf(body: unknown): string {
  if (typeof body === "string") return body;
  if (typeof body !== "object" || body === null) return JSON.stringify(body);
  let text = texts.get(body);
  if (text === undefined) { text = JSON.stringify(body); texts.set(body, text); }
  return text;
}

/** A strong validator for a body: the same text always has the same tag. */
export const etagOf = (text: string): string => `"${createHash("sha256").update(text).digest("hex").slice(0, 32)}"`;

/** The answer with its cache rule's headers. Only a 200 is cached; everything else stays `no-store` (the server's default). */
export function cached(answer: Answer, rule: Rule): Answer {
  if (answer.status !== 200) return answer;
  return { ...answer, headers: { ...answer.headers, "cache-control": CACHE_CONTROL[rule], etag: etagOf(textOf(answer.body)) } };
}

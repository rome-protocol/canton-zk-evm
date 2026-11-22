// Where an account's Ostia address stands, from what the server read, what the page worked out itself on Ostia and when the person's ask went out. The address is shown only when a final opening names it and the
// page's own work of it agrees; "setting up" ends, as not available, when the set time passes with no Sent mark.
import type { AddressRead } from "./setup.ts";

export type AddressState =
  | { kind: "idle" }
  | { kind: "reading" }
  | { kind: "no-acceptance" }
  | { kind: "setting-up"; openTx: string | null; since: number }
  | { kind: "unavailable" }
  | { kind: "ready"; inbox: string };

/** A Canton party id as the server takes it, with the "::" that divides its name from its fingerprint. */
export const PARTY = /^[A-Za-z0-9_.-]{1,200}::[A-Za-z0-9_.-]{1,98}$/;

export function addressState(i: {
  /** `"unread"` before the first answer; null when the server could not be read. */
  read: AddressRead | null | "unread";
  /** The address the page worked out itself, null until it has. */
  mine: string | null;
  askedAt: number | null;
  /** The ask to the intake was refused or did not go through. */
  askFailed: boolean;
  now: number;
  setupSeconds: number;
}): AddressState {
  const { read } = i;
  if (read === "unread") return { kind: "reading" };
  if (read === null || read.accepts === null) return { kind: "unavailable" };
  if (read.accepts === false) return { kind: "no-acceptance" };
  if (read.opened) return i.mine === null ? { kind: "reading" } : i.mine === read.inbox ? { kind: "ready", inbox: read.inbox } : { kind: "unavailable" };
  if (i.askFailed) return { kind: "unavailable" };
  if (i.askedAt === null) return { kind: "reading" };
  if (read.openTx === null && i.now - i.askedAt >= i.setupSeconds * 1000) return { kind: "unavailable" };
  return { kind: "setting-up", openTx: read.openTx, since: i.askedAt };
}

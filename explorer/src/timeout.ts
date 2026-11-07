/** How long a request of the Bridge page waits for an answer. One that does not answer stops with an error of its own, instead of holding the page. */
export const REQUEST_MS = 20_000;
export const timeoutSignal = (ms: number = REQUEST_MS): AbortSignal | undefined =>
  typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined;

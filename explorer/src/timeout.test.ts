import { describe, expect, it } from "vitest";
import { REQUEST_MS, timeoutSignal } from "./timeout.ts";

describe("the request timeout", () => {
  it("is 20 seconds, as a signal that has not fired yet", () => {
    expect(REQUEST_MS).toBe(20_000);
    const s = timeoutSignal();
    expect(s).toBeInstanceOf(AbortSignal);
    expect(s!.aborted).toBe(false);
  });
  it("fires after the time it is given, with a timeout error", async () => {
    const s = timeoutSignal(5)!;
    await new Promise((r) => setTimeout(r, 30));
    expect(s.aborted).toBe(true);
    expect((s.reason as { name?: string }).name).toBe("TimeoutError");
  });
});

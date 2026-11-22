import { describe, expect, it } from "vitest";
import { LOOKALIKES } from "./lookalikes.ts";

describe("the tokens that carry a warning", () => {
  it("lists every address in lower case with a sentence", () => {
    for (const [address, warning] of Object.entries(LOOKALIKES)) {
      expect(address).toMatch(/^0x[0-9a-f]{40}$/);
      expect(warning.length).toBeGreaterThan(0);
    }
  });
  it("warns of the two tokens left over from DevNet, which Ostia has left", () => {
    expect(LOOKALIKES["0x4db3dea7c13116961fd3e438542ccfcca61a7547"]).toBe("Left over from DevNet, not backed on TestNet");
    expect(LOOKALIKES["0x294d3049874526910a69f6b61da14d10a8b1b3af"]).toBe("Left over from DevNet, not backed on TestNet");
  });
});

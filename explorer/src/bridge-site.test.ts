import { describe, expect, it } from "vitest";
import { bridgeHref, bridgeOrigin } from "./bridge-site.ts";

const APP = "https://bridge.ostia.testnet.romeprotocol.xyz";

describe("where the Bridge site is", () => {
  it("has no origin and links to /bridge while the build has none, and keeps the query", () => {
    expect(bridgeOrigin({})).toBeNull();
    expect(bridgeOrigin({ VITE_BRIDGE_ORIGIN: "  " })).toBeNull();
    expect(bridgeHref("", {})).toBe("/bridge");
    expect(bridgeHref("?tab=other-chains", {})).toBe("/bridge?tab=other-chains");
  });

  it("links to the site's own address when the build has one, and keeps the query", () => {
    const e = { VITE_BRIDGE_ORIGIN: APP };
    expect(bridgeOrigin(e)).toBe(APP);
    expect(bridgeHref("", e)).toBe(`${APP}/`);
    expect(bridgeHref("?tab=other-chains", e)).toBe(`${APP}/?tab=other-chains`);
  });
});

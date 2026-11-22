// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { bridgeHref, bridgeOrigin, explorerHref, explorerOrigin, inApp } from "./where.ts";

const APP = "https://bridge.ostia.testnet.romeprotocol.xyz", SITE = "https://ostia.testnet.romeprotocol.xyz";
const asApp = () => document.documentElement.setAttribute("data-app", "bridge");
afterEach(() => { vi.unstubAllEnvs(); document.documentElement.removeAttribute("data-app"); });

describe("where the Bridge is", () => {
  it("is the explorer's page unless the document is the app's", () => {
    expect(inApp()).toBe(false);
    asApp();
    expect(inApp()).toBe(true);
  });

  it("links to /bridge while the switch is off, and keeps the query", () => {
    expect(bridgeOrigin()).toBeNull();
    expect(bridgeHref()).toBe("/bridge");
    expect(bridgeHref("?tab=other-chains")).toBe("/bridge?tab=other-chains");
  });

  it("links to the app's own address with the switch on, and keeps the query", () => {
    vi.stubEnv("VITE_BRIDGE_ORIGIN", APP);
    expect(bridgeOrigin()).toBe(APP);
    expect(bridgeHref()).toBe(`${APP}/`);
    expect(bridgeHref("?tab=other-chains")).toBe(`${APP}/?tab=other-chains`);
  });

  it("names the explorer by the page's own origin in the explorer, and by the site setting in the app", () => {
    vi.stubEnv("VITE_SITE_ORIGIN", SITE);
    expect(explorerOrigin()).toBe(location.origin);
    expect(explorerHref("/tx/0x1")).toBe("/tx/0x1");
    asApp();
    expect(explorerOrigin()).toBe(SITE);
    expect(explorerHref("/tx/0x1")).toBe(`${SITE}/tx/0x1`);
  });

  it("falls back to the page's own origin in an app that has no site setting (a local run)", () => {
    asApp();
    expect(explorerOrigin()).toBe(location.origin);
  });
});

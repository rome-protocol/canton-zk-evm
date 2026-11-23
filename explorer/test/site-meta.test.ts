import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bridgeOrigin, siteMeta, withSiteMeta } from "../site-meta.ts";

const page = readFileSync(new URL("../index.html", import.meta.url), "utf8");
// index.html as it was when it named DevNet itself: DevNet's build must still produce these bytes.
const devnetPage = readFileSync(new URL("./fixtures/index.devnet.html", import.meta.url), "utf8");
const TESTNET = { VITE_NETWORK_NAME: "TestNet", VITE_SITE_ORIGIN: "https://ostia.testnet.romeprotocol.xyz" };

describe("the network's name and the site's origin in index.html", () => {
  it("leaves DevNet's page as it was, with no setting and with DevNet's settings", () => {
    expect(withSiteMeta(page, {})).toBe(devnetPage);
    expect(withSiteMeta(page, { VITE_NETWORK_NAME: "DevNet", VITE_SITE_ORIGIN: "https://ostia.devnet.romeprotocol.xyz" })).toBe(devnetPage);
  });

  it("says TestNet and names the TestNet origin, and no DevNet host, in a TestNet build", () => {
    const html = withSiteMeta(page, TESTNET);
    expect(html).toContain("<title>Ostia TestNet</title>");
    expect(html).toContain('content="Ostia is an EVM chain on Canton TestNet:');
    expect(html).toContain("TestNet only;");
    expect(html).toContain('<meta property="og:site_name" content="Ostia TestNet" />');
    expect(html).toContain('<meta property="og:title" content="Ostia TestNet: an EVM chain on Canton" />');
    expect(html).toContain('<meta name="twitter:title" content="Ostia TestNet: an EVM chain on Canton" />');
    expect(html).toContain('<meta property="og:image" content="https://ostia.testnet.romeprotocol.xyz/ostia-card.png" />');
    expect(html).toContain('<meta name="twitter:image" content="https://ostia.testnet.romeprotocol.xyz/ostia-card.png" />');
    expect(html).not.toMatch(/devnet/i);
    expect(html).not.toContain("%");
  });

  it("takes the origin a DevNet build gives (a local one, for a test build)", () => {
    expect(withSiteMeta(page, { VITE_SITE_ORIGIN: "http://127.0.0.1:4173" })).toContain('content="http://127.0.0.1:4173/ostia-card.png"');
  });

  it("refuses a build for another network that gives no origin, so DevNet's address is never put on its page", () => {
    expect(() => siteMeta({ VITE_NETWORK_NAME: "TestNet" })).toThrow("VITE_SITE_ORIGIN");
    expect(() => siteMeta({ VITE_NETWORK_NAME: "TestNet", VITE_SITE_ORIGIN: "  " })).toThrow("VITE_SITE_ORIGIN");
  });

  it("refuses a name or an origin that is not one", () => {
    for (const bad of ['Test"Net', "<b>", "A".repeat(40), "-x"]) expect(() => siteMeta({ ...TESTNET, VITE_NETWORK_NAME: bad }), bad).toThrow("VITE_NETWORK_NAME");
    for (const bad of ["ostia.example", "https://ostia.example/", "https://ostia.example/path", "ftp://ostia.example"]) expect(() => siteMeta({ ...TESTNET, VITE_SITE_ORIGIN: bad }), bad).toThrow("VITE_SITE_ORIGIN");
  });
});

describe("the Bridge site's origin", () => {
  const BRIDGE = "https://bridge.ostia.testnet.romeprotocol.xyz";

  it("leaves index.html as it was whatever the Bridge origin is", () => {
    expect(withSiteMeta(page, { VITE_BRIDGE_ORIGIN: BRIDGE })).toBe(devnetPage);
  });

  it("takes no setting, an empty one or an origin, and refuses anything else", () => {
    expect(bridgeOrigin({})).toBeNull();
    expect(bridgeOrigin({ VITE_BRIDGE_ORIGIN: "  " })).toBeNull();
    expect(bridgeOrigin({ VITE_BRIDGE_ORIGIN: BRIDGE })).toBe(BRIDGE);
    for (const bad of ["bridge.example", `${BRIDGE}/`, `${BRIDGE}/path`, "ftp://bridge.example"]) expect(() => siteMeta({ ...TESTNET, VITE_BRIDGE_ORIGIN: bad }), bad).toThrow("VITE_BRIDGE_ORIGIN");
  });
});

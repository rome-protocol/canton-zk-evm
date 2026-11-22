import { describe, expect, it } from "vitest";
import { agglayerSettings } from "../agglayer/settings.ts";
import { routeSettings } from "./settings.ts";

const fail = (m: string) => new Error(m);
const ag = agglayerSettings({ AGGLAYER_BRIDGE: "1", AGGLAYER_SEPOLIA_RPC_URL: "https://sepolia.example.invalid/key", AGGLAYER_OSTIA_BRIDGE: "0x" + "53".repeat(20), AGGLAYER_SEPOLIA_BRIDGE: "0x" + "52".repeat(20) }, fail);
const good = { OSTIA_ROUTE_OUT: "1", OSTIA_ROUTER: "0x" + "A1".repeat(20), OSTIA_BOOK: "0x" + "b2".repeat(20), OSTIA_ROUTE_NOT_TAKEN_SECONDS: "600", OSTIA_ROUTE_OWN_CLAIM_SECONDS: "300" };

describe("the Canton route's settings", () => {
  it("are off unless OSTIA_ROUTE_OUT is 1, and then nothing else is read", () => {
    for (const v of [undefined, "", "0"]) expect(routeSettings({ OSTIA_ROUTE_OUT: v, OSTIA_ROUTER: "junk" }, ag, fail)).toBeNull();
    expect(() => routeSettings({ OSTIA_ROUTE_OUT: "yes" }, ag, fail)).toThrow("OSTIA_ROUTE_OUT must be 1 or 0");
  });
  it("need the AggLayer bridge on", () => expect(() => routeSettings(good, null, fail)).toThrow("needs AGGLAYER_BRIDGE=1"));
  it("read the two addresses (lower case) and the two waits, which have no default", () => {
    expect(routeSettings(good, ag, fail)).toEqual({ router: "0x" + "a1".repeat(20), book: "0x" + "b2".repeat(20), notTakenSeconds: 600, ownClaimSeconds: 300, time: null, gateway: null });
    for (const name of ["OSTIA_ROUTER", "OSTIA_BOOK"]) expect(() => routeSettings({ ...good, [name]: undefined }, ag, fail)).toThrow(name);
    expect(() => routeSettings({ ...good, OSTIA_ROUTER: "0x12" }, ag, fail)).toThrow("OSTIA_ROUTER");
    for (const name of ["OSTIA_ROUTE_NOT_TAKEN_SECONDS", "OSTIA_ROUTE_OWN_CLAIM_SECONDS"]) {
      for (const v of [undefined, "", "0", "-1", "1.5", "604801", "ten"]) expect(() => routeSettings({ ...good, [name]: v }, ag, fail), `${name}=${v}`).toThrow(name);
    }
  });
  it("take a measured time of a whole move, or none", () => {
    expect(routeSettings({ ...good, OSTIA_ROUTE_TIME: '{"minSeconds":480,"maxSeconds":960}' }, ag, fail)!.time).toEqual({ minSeconds: 480, maxSeconds: 960 });
    for (const v of ["x", '{"minSeconds":9,"maxSeconds":3}', '{"minSeconds":0,"maxSeconds":3}', '{"minSeconds":1,"maxSeconds":86401}', '{"minSeconds":1,"maxSeconds":2,"x":1}', "[]"]) expect(() => routeSettings({ ...good, OSTIA_ROUTE_TIME: v }, ag, fail), v).toThrow("OSTIA_ROUTE_TIME");
  });
  it("take the gateway party and its token file together, or neither", () => {
    expect(Object.values(routeSettings({ ...good, GATEWAY_PARTY: "gw::1220ab", GATEWAY_LEDGER_TOKEN_FILE: "/run/t" }, ag, fail)!.gateway!)).toEqual(["gw::1220ab", "/run/t"]);
    expect(() => routeSettings({ ...good, GATEWAY_PARTY: "gw::1220ab" }, ag, fail)).toThrow("together");
    expect(() => routeSettings({ ...good, GATEWAY_LEDGER_TOKEN_FILE: "/run/t" }, ag, fail)).toThrow("together");
  });
});

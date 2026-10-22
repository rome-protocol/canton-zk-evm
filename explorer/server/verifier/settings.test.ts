import { describe, expect, it } from "vitest";
import { loadVerifierSettings, VerifierSettingsError } from "./settings.ts";

const GOOD = {
  SOLC_LIST_URL: "https://mirror.example.invalid/linux-amd64/list.json", OUTSIDE_USER_AGENT: "Project contact@example.invalid", SOLC_CACHE_DIR: "/var/lib/solc",
  SANDBOX_IMAGE: `registry.example.invalid/busybox@sha256:${"a".repeat(64)}`,
};

describe("the verifier's settings", () => {
  it("take the design's limits when only the four required ones are given", () => {
    const s = loadVerifierSettings(GOOD);
    expect(s).toMatchObject({ compileTimeoutMs: 60_000, compileMemoryBytes: 2 * 1024 ** 3, dockerBin: "docker", cacheMaxBytes: 1024 ** 3 });
  });
  for (const name of ["SOLC_LIST_URL", "OUTSIDE_USER_AGENT", "SOLC_CACHE_DIR", "SANDBOX_IMAGE"]) {
    it(`have no default for ${name}`, () => {
      expect(() => loadVerifierSettings({ ...GOOD, [name]: undefined })).toThrow(VerifierSettingsError);
      expect(() => loadVerifierSettings({ ...GOOD, [name]: "  " })).toThrow(new RegExp(name));
    });
  }
  it("refuse an image that is not named by digest, a relative cache folder, and numbers out of range", () => {
    expect(() => loadVerifierSettings({ ...GOOD, SANDBOX_IMAGE: "busybox:latest" })).toThrow(/digest/);
    expect(() => loadVerifierSettings({ ...GOOD, SOLC_CACHE_DIR: "cache" })).toThrow(/absolute/);
    expect(() => loadVerifierSettings({ ...GOOD, SOLC_TIMEOUT_MS: "5" })).toThrow(/SOLC_TIMEOUT_MS/);
    expect(() => loadVerifierSettings({ ...GOOD, SOLC_MEMORY_MB: "lots" })).toThrow(/SOLC_MEMORY_MB/);
  });
  it("read the limits that are given", () => {
    expect(loadVerifierSettings({ ...GOOD, SOLC_TIMEOUT_MS: "30000", SOLC_MAX_OUTPUT_MB: "4" })).toMatchObject({ compileTimeoutMs: 30_000, compileMaxOutputBytes: 4 * 1024 ** 2 });
  });
  it("take the gateway's address, source and compiler together, or none of them", () => {
    expect(loadVerifierSettings(GOOD).gateway).toBeNull();
    const all = { GATEWAY_ADDRESS: "0x" + "AB".repeat(20), GATEWAY_SOURCE_FILE: "/repo/gateway/Gateway.sol", GATEWAY_COMPILER: "0.8.28" };
    expect(loadVerifierSettings({ ...GOOD, ...all }).gateway).toEqual({ address: "0x" + "ab".repeat(20), sourceFile: "/repo/gateway/Gateway.sol", compiler: "0.8.28" });
    expect(() => loadVerifierSettings({ ...GOOD, GATEWAY_ADDRESS: all.GATEWAY_ADDRESS })).toThrow(/together/);
    expect(() => loadVerifierSettings({ ...GOOD, ...all, GATEWAY_ADDRESS: "0x12" })).toThrow(/GATEWAY_ADDRESS/);
  });
});

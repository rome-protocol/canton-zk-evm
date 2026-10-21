import { describe, expect, it } from "vitest";
import { connectionConfig } from "./connect.ts";

describe("connectionConfig", () => {
  it("takes a URL as it is", () => {
    expect(connectionConfig({ EXPLORER_DATABASE_URL: "postgres://u@h/d" })).toEqual({ connectionString: "postgres://u@h/d" });
  });

  it("builds the parts, with the password from the file and the defaults of network/explorer-db.sh", () => {
    const cfg = connectionConfig({ EXPLORER_DB_PASSWORD_FILE: "/f" }, (p) => (p === "/f" ? "POSTGRES_PASSWORD=s3cret\n" : ""));
    expect(cfg).toEqual({ host: "127.0.0.1", port: 5433, user: "explorer", database: "explorer", password: "s3cret" });
    expect(connectionConfig({ EXPLORER_DB_PASSWORD_FILE: "/f", EXPLORER_DB_PORT: "6000", EXPLORER_DB_HOST: "db" }, () => "POSTGRES_PASSWORD=x")).toMatchObject({ host: "db", port: 6000 });
  });

  it("refuses nothing to connect with, a file with no password, and a bad port, without printing a password", () => {
    expect(() => connectionConfig({})).toThrow(/EXPLORER_DATABASE_URL/);
    expect(() => connectionConfig({ EXPLORER_DB_PASSWORD_FILE: "/f" }, () => "OTHER=1\n")).toThrow(/no POSTGRES_PASSWORD/);
    expect(() => connectionConfig({ EXPLORER_DB_PASSWORD_FILE: "/f", EXPLORER_DB_PORT: "x" }, () => "POSTGRES_PASSWORD=s3cret")).toThrow(/not a port/);
    try { connectionConfig({ EXPLORER_DB_PASSWORD_FILE: "/f", EXPLORER_DB_PORT: "x" }, () => "POSTGRES_PASSWORD=s3cret"); } catch (e) { expect((e as Error).message).not.toContain("s3cret"); }
  });
});

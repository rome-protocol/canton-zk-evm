import { describe, expect, it } from "vitest";
import { parseCommand, UsageError } from "./commands.ts";

describe("the indexer's command line", () => {
  it("runs the indexer when it is given nothing, or run", () => {
    expect(parseCommand([])).toEqual({ kind: "run" });
    expect(parseCommand(["run"])).toEqual({ kind: "run" });
  });
  it("reads a reindex range, positional or named, with the head as the default end", () => {
    expect(parseCommand(["reindex", "5", "9"])).toEqual({ kind: "reindex", from: 5, to: 9 });
    expect(parseCommand(["reindex", "5"])).toEqual({ kind: "reindex", from: 5, to: null });
    expect(parseCommand(["reindex", "--from", "5", "--to", "9"])).toEqual({ kind: "reindex", from: 5, to: 9 });
    expect(parseCommand(["reindex", "--from", "5"])).toEqual({ kind: "reindex", from: 5, to: null });
  });
  it("reads a rebuild from a file and an export to a file", () => {
    expect(parseCommand(["reindex", "--records", "records.jsonl"])).toEqual({ kind: "rebuild", records: "records.jsonl" });
    expect(parseCommand(["export-records", "records.jsonl"])).toEqual({ kind: "export-records", file: "records.jsonl" });
  });
  it("refuses what it cannot read, and says how to use it", () => {
    for (const argv of [["reindex"], ["reindex", "0"], ["reindex", "x"], ["reindex", "9", "5"], ["reindex", "1", "2", "3"], ["reindex", "--records"], ["reindex", "--records", "a", "b"],
      ["export-records"], ["export-records", "--x"], ["run", "now"], ["nope"], ["reindex", "--from", "1", "--until", "3"]]) {
      expect(() => parseCommand(argv), argv.join(" ")).toThrow(UsageError);
    }
    expect(() => parseCommand(["nope"])).toThrow(/usage:/);
  });
});

/** What the indexer's command line asks for. */
export type Command =
  | { kind: "run" }
  | { kind: "reindex"; from: number; to: number | null }
  | { kind: "rebuild"; records: string }
  | { kind: "export-records"; file: string };

export class UsageError extends Error {}

export const USAGE = `usage: node server/indexer/cli.ts [run]
       node server/indexer/cli.ts reindex <from> [<to>]        (or --from N [--to M]; the stage 1 tables for that range, from stored records and reth)
       node server/indexer/cli.ts reindex --records <file>     (a fresh database from an export, and reth)
       node server/indexer/cli.ts export-records <file>`;

const block = (v: string | undefined, what: string): number => {
  if (v === undefined || !/^[1-9]\d*$/.test(v)) throw new UsageError(`${what} must be a block number of 1 or more${v === undefined ? "" : `, not "${v}"`}\n${USAGE}`);
  return Number(v);
};

export function parseCommand(argv: string[]): Command {
  const [name, ...rest] = argv;
  if (name === undefined || name === "run") {
    if (rest.length > 0) throw new UsageError(USAGE);
    return { kind: "run" };
  }
  if (name === "export-records") {
    if (rest.length !== 1 || rest[0]!.startsWith("-")) throw new UsageError(`export-records takes the file to write\n${USAGE}`);
    return { kind: "export-records", file: rest[0]! };
  }
  if (name === "reindex") {
    if (rest[0] === "--records") {
      if (rest.length !== 2) throw new UsageError(`--records takes the file to read, and nothing else\n${USAGE}`);
      return { kind: "rebuild", records: rest[1]! };
    }
    const from = rest[0] === "--from" ? rest[1] : rest[0];
    let to: string | undefined;
    if (rest[0] === "--from") {
      if (rest.length === 4 && rest[2] === "--to") to = rest[3];
      else if (rest.length !== 2) throw new UsageError(USAGE);
    } else if (rest.length === 2) to = rest[1];
    else if (rest.length !== 1) throw new UsageError(USAGE);
    const a = block(from, "from");
    const b = to === undefined ? null : block(to, "to");
    if (b !== null && b < a) throw new UsageError(`to (${b}) is before from (${a})`);
    return { kind: "reindex", from: a, to: b };
  }
  throw new UsageError(`unknown command "${name}"\n${USAGE}`);
}

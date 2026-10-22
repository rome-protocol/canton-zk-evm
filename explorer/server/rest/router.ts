/**
 * The routes as a table: a path with at most one `{name}` segment, and what answers it. The table is what the router matches and what `openapi.ts`
 * describes, so a route that is registered and not described (or described and not registered) is found by a test, not by a reader.
 */
import type { Answer } from "../api.ts";

export type Handler = (param: string, q: URLSearchParams) => Promise<Answer>;
export type Table = readonly (readonly [path: string, handler: Handler])[];
export type Routed = ((parts: string[], q: URLSearchParams) => (() => Promise<Answer>) | undefined) & { paths: readonly string[] };

/** `parts` is the path split into lowercase segments, `/api` first, as the API makes it. */
export function router(table: Table): Routed {
  const compiled = table.map(([path, handler]) => ({ segs: path.split("/").slice(1), handler }));
  const match = (parts: string[], q: URLSearchParams): (() => Promise<Answer>) | undefined => {
    for (const { segs, handler } of compiled) {
      if (segs.length !== parts.length) continue;
      let param = "";
      if (segs.every((s, i) => (s.startsWith("{") ? ((param = parts[i]!), true) : s === parts[i]))) return () => handler(param, q);
    }
    return undefined;
  };
  return Object.assign(match, { paths: table.map(([path]) => path) });
}

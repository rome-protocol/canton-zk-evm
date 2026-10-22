import { useQuery } from "@tanstack/react-query";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { search, type SearchMatch } from "../api.ts";
import { ErrorCard, LoadingCard, NotFound } from "../components/Cards.tsx";
import { short } from "../format.ts";

const NOTHING_TYPED = "Not found. Search takes a block number, a block or transaction hash, an address, or a Canton update id. A block that Canton refused is gone, and cannot be found.";

/** A name that more than one token or contract starts with: the visitor picks. Tokens come first, as the server lists them. */
function Matches({ matches, q }: { matches: SearchMatch[]; q: string }) {
  return (
    <section className="card" aria-labelledby="matches-h">
      <div className="sec-h"><h3 id="matches-h">Several match</h3><span className="muted small">Names that start with <span className="mono">{short(q, 20, 0)}</span></span></div>
      <ul className="matches">
        {matches.map((m) => (
          <li key={m.path}>
            <Link to={m.path}>{m.name}{m.symbol ? ` (${m.symbol})` : ""}</Link>
            <span className="chip chip-kind">{m.kind === "token" ? "Token" : "Contract"}</span>
            <span className="mono muted small">{short(m.address, 10, 6)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Asks the server what was typed is, and opens that page. Nothing found says so, in the server's own words. */
export function Search() {
  const [params] = useSearchParams();
  const q = (params.get("q") ?? "").trim();
  const result = useQuery({ queryKey: ["search", q], queryFn: () => search(q), enabled: q !== "", retry: false, gcTime: 0 });
  if (!q) return <NotFound message={NOTHING_TYPED} query="" />;
  if (result.isError) return <ErrorCard message={result.error.message} />;
  if (!result.data) return <LoadingCard>Searching…</LoadingCard>;
  if (!result.data.found) return <NotFound message={result.data.message} query={q} />;
  return result.data.matches.length > 1 ? <Matches matches={result.data.matches} q={q} /> : <Navigate to={result.data.path} replace />;
}

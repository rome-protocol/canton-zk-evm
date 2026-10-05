import { useQuery } from "@tanstack/react-query";
import { Navigate, useSearchParams } from "react-router-dom";
import { search } from "../api.ts";
import { ErrorCard, LoadingCard, NotFound } from "../components/Cards.tsx";

const NOTHING_TYPED = "Not found. Search takes a block number, a block or transaction hash, an address, or a Canton update id. A block that Canton refused is gone, and cannot be found.";

/** Asks the server what was typed is, and opens that page. Nothing found says so, in the server's own words. */
export function Search() {
  const [params] = useSearchParams();
  const q = (params.get("q") ?? "").trim();
  const result = useQuery({ queryKey: ["search", q], queryFn: () => search(q), enabled: q !== "", retry: false, gcTime: 0 });
  if (!q) return <NotFound message={NOTHING_TYPED} query="" />;
  if (result.isError) return <ErrorCard message={result.error.message} />;
  if (!result.data) return <LoadingCard>Searching…</LoadingCard>;
  return result.data.found ? <Navigate to={result.data.path} replace /> : <NotFound message={result.data.message} query={q} />;
}

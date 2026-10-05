import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../api.ts";
import { short } from "../format.ts";

/** The answer when the server cannot read the chain. A page that polls tries again by itself. */
export function ErrorCard({ message, retrying = false }: { message: string; retrying?: boolean }) {
  return (
    <section className="card nf">
      <h1>Cannot read the chain</h1>
      <p>{message}</p>
      {retrying && <p className="small muted">The page tries again in a few seconds.</p>}
    </section>
  );
}

export function LoadingCard({ children }: { children: string }) {
  return <section className="card nf" aria-busy="true"><p className="muted">{children}</p></section>;
}

export function NoPage() {
  return (
    <section className="card nf">
      <h1>Not found</h1>
      <p>There is no page at this address.</p>
      <p><Link to="/">Go to the home page</Link></p>
    </section>
  );
}

/** Nothing was found at this address. The server's message leads with "Not found." already, which the heading says. */
export function NotFound({ message, query }: { message: string; query?: string }) {
  return (
    <section className="card nf">
      <h1>Not found</h1>
      <p>{message.replace(/^Not found\.\s*/, "")}</p>
      {query && <p className="small muted">You searched for <span className="mono">{short(query, 10, 8)}</span>.</p>}
    </section>
  );
}

/** What a page shows until it has its answer: nothing was found, the chain cannot be read (and the page tries again), or it is still loading. Null once there is an answer. */
export function unready(q: { data?: unknown; error: Error | null }, loading: string): ReactNode {
  const e = q.error;
  if (e instanceof ApiError && (e.status === 404 || e.status === 400)) return <NotFound message={e.message} />;
  if (q.data) return null;
  return e ? <ErrorCard message={e.message} retrying /> : <LoadingCard>{loading}</LoadingCard>;
}

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError, getStatus } from "./api.ts";

/** How often the pages ask the server for the status: the same as the server's own look at the chain. */
export const POLL_MS = 2000;

/** The one shared read of /api/status. The header, the home page and the faucet page all read through it, so they cannot disagree. */
export function useStatus() {
  return useQuery({ queryKey: ["status"], queryFn: getStatus, refetchInterval: POLL_MS });
}

/** The time now, drawn again every second. The "ago" texts read it, so they keep counting while the status answer stays the same. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/**
 * One read of a page's own subject (a block, a transaction), which is asked again every two seconds until it is final. A subject the
 * server answered "not found" for is not asked again, and one it could not read is.
 */
export function useFollowing<T>(key: readonly unknown[], read: () => Promise<T>, settled: (answer: T) => boolean) {
  return useQuery({
    queryKey: key,
    queryFn: read,
    refetchInterval: (q) => {
      const e = q.state.error;
      if (e instanceof ApiError && (e.status === 404 || e.status === 400)) return false;
      return q.state.data !== undefined && settled(q.state.data) ? false : POLL_MS;
    },
  });
}

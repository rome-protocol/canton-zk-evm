import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { openStream, type Topic } from "./stream.ts";

/** What each live event makes a page read again. The lists and the status are read through these keys. */
const REFRESH: Record<string, readonly string[]> = {
  block: ["blocks", "txs", "canton", "status", "in-flight"],
  txs: ["txs"],
  inflight: ["in-flight", "status"],
  stats: ["status", "stats"],
  derived: ["stats"],
};

/**
 * Keeps one live stream open for as long as the page is shown, and reads again what an event says has changed. Returns whether the stream is up:
 * a page that polls does so only while it is not.
 */
export function useLive(topics: readonly Topic[]): boolean {
  const client = useQueryClient();
  const [live, setLive] = useState(false);
  const key = topics.join(",");
  useEffect(() => {
    const close = openStream({
      topics: key.split(",") as Topic[],
      onState: setLive,
      onEvent: (e) => { for (const k of REFRESH[e.event] ?? []) void client.invalidateQueries({ queryKey: [k] }); },
    });
    return () => { close(); setLive(false); };
  }, [client, key]);
  return live;
}

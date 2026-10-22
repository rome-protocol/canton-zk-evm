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

/** Connecting: not tried yet or being tried. Live: open. Down: it dropped and is being tried again. Off: the server has no stream, so the pages poll. */
export type StreamState = "connecting" | "live" | "down" | "off";

/**
 * Keeps one live stream open for as long as the page is shown, and reads again what an event says has changed. Returns how the stream is: a page
 * that polls does so whenever it is not live. The server does not replay the in-flight and stats events to a stream that comes back, so when
 * one does, the status and the in-flight attempts are read again here.
 */
export function useLiveState(topics: readonly Topic[]): StreamState {
  const client = useQueryClient();
  const [state, setState] = useState<StreamState>("connecting");
  const key = topics.join(",");
  useEffect(() => {
    let wasLive = false;
    const close = openStream({
      topics: key.split(",") as Topic[],
      onState: (up) => {
        setState(up ? "live" : "down");
        if (up && wasLive) for (const k of ["in-flight", "status"]) void client.invalidateQueries({ queryKey: [k] });
        if (up) wasLive = true;
      },
      onOff: () => setState("off"),
      onEvent: (e) => { for (const k of REFRESH[e.event] ?? []) void client.invalidateQueries({ queryKey: [k] }); },
    });
    return () => { close(); setState("connecting"); };
  }, [client, key]);
  return state;
}

/** Whether the stream is up. */
export const useLive = (topics: readonly Topic[]): boolean => useLiveState(topics) === "live";

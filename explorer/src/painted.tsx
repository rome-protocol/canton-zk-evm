import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

/** Whether the browser has drawn the page's first contentful frame. A page outside the shell (a test of one component) is never held back. */
const Painted = createContext(true);

/** The longest the lists wait for a frame that does not come, as in a tab that is in the background. */
const GIVE_UP_MS = 2000;

/**
 * Says, once the browser reports the first contentful paint, that the reads which the first view does not need may start: the page paints on the
 * status and the hour of stats, not on every list. A browser that does not report paints has nothing to wait for.
 */
export function PaintedProvider({ children }: { children: ReactNode }) {
  const [painted, setPainted] = useState(false);
  useEffect(() => {
    const go = () => setPainted(true);
    if (typeof PerformanceObserver === "undefined" || !PerformanceObserver.supportedEntryTypes?.includes("paint")) {
      const t = setTimeout(go, 0);
      return () => clearTimeout(t);
    }
    const watch = new PerformanceObserver((list) => { if (list.getEntries().some((e) => e.name === "first-contentful-paint")) go(); });
    watch.observe({ type: "paint", buffered: true });
    const t = setTimeout(go, GIVE_UP_MS);
    return () => { watch.disconnect(); clearTimeout(t); };
  }, []);
  return <Painted.Provider value={painted}>{children}</Painted.Provider>;
}

export const usePainted = (): boolean => useContext(Painted);

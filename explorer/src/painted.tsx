import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

/** Whether the browser has drawn the page's first frame. A page outside the shell (a test of one component) is never held back. */
const Painted = createContext(true);

/** Says, once the first frame is drawn, that the reads which the first view does not need may start: the page paints on the status alone, not on every list. */
export function PaintedProvider({ children }: { children: ReactNode }) {
  const [painted, setPainted] = useState(false);
  useEffect(() => {
    // The frame callback runs just before the paint, so the timer after it runs once the frame is out.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => { timer = setTimeout(() => setPainted(true), 0); });
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
  }, []);
  return <Painted.Provider value={painted}>{children}</Painted.Provider>;
}

export const usePainted = (): boolean => useContext(Painted);

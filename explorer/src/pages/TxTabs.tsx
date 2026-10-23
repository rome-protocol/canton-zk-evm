import type { ReactNode } from "react";
import { count } from "../format.ts";

export type TabId = "overview" | "logs" | "internal" | "tree" | "raw";
export interface TabSpec { id: TabId; label: string; count?: number | null }

/** The tab strip. The tab is kept in the address, so a link opens the same tab. */
export function Tabs({ tabs, current, onPick }: { tabs: TabSpec[]; current: TabId; onPick: (id: TabId) => void }) {
  return (
    <div className="tabs" role="tablist" aria-label="Transaction sections">
      {tabs.map((s) => (
        <button key={s.id} type="button" role="tab" id={`tab-${s.id}`} aria-selected={s.id === current} aria-controls={`panel-${s.id}`} onClick={() => onPick(s.id)}>
          {s.label}{s.count !== undefined && s.count !== null && <span className="count">{count(s.count)}</span>}
        </button>
      ))}
    </div>
  );
}

export const Panel = ({ id, children }: { id: TabId; children: ReactNode }) => (
  <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`}>{children}</div>
);

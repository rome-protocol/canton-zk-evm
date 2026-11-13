import type { ApiStatus } from "../api.ts";
import { useNow } from "../useStatus.ts";
import { Icon } from "./Icon.tsx";

const DAY = { month: "short", day: "numeric" } as const;
const CLOCK = { hour: "2-digit", minute: "2-digit" } as const;

const part = (d: Date, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(undefined, opts).format(d);
const zone = (d: Date) => new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(d).find((p) => p.type === "timeZoneName")?.value ?? "";
const sameDay = (a: Date, b: Date) => part(a, DAY) === part(b, DAY) && a.getFullYear() === b.getFullYear();

/** The planned time in the reader's own zone: "Nov 14, 09:00 – 09:45 GMT+1", or with a day on each side when the work crosses midnight. */
export function noticeRange(startsAt: string, endsAt: string): string {
  const a = new Date(startsAt), b = new Date(endsAt);
  return sameDay(a, b)
    ? `${part(a, DAY)}, ${part(a, CLOCK)} – ${part(b, CLOCK)} ${zone(b)}`
    : `${part(a, DAY)}, ${part(a, CLOCK)} – ${part(b, DAY)}, ${part(b, CLOCK)} ${zone(b)}`;
}

/** The end of work that has started, in the reader's zone: "until 09:45 GMT+1", with the day when it is not today. */
export function noticeUntil(endsAt: string, now: number): string {
  const b = new Date(endsAt);
  return `until ${sameDay(b, new Date(now)) ? "" : `${part(b, DAY)}, `}${part(b, CLOCK)} ${zone(b)}`;
}

/**
 * The strip at the top of every page while the server has a notice (`/api/status`'s `notice`) that has not ended: before its start it reads as planned work, after it as work in progress,
 * and it is gone at its end, by the reader's own clock, so a page that stays open needs no new status. The text is the server's plain text and is drawn as text.
 */
export function NoticeBanner({ notice }: { notice: ApiStatus["notice"] }) {
  const now = useNow();
  if (!notice) return null;
  const start = Date.parse(notice.startsAt), end = Date.parse(notice.endsAt);
  // A time that is not one, or work that is over, shows nothing.
  if (Number.isNaN(start) || Number.isNaN(end) || now >= end) return null;
  const started = now >= start;
  return (
    <div className={`notice ${started ? "now" : "planned"}`} role="status">
      <Icon name="warn" size={15} />
      <p>
        <b>{started ? "Maintenance in progress:" : "Planned maintenance:"}</b> {notice.text}{" "}
        <span className="notice-when">{started ? noticeUntil(notice.endsAt, now) : noticeRange(notice.startsAt, notice.endsAt)}</span>
      </p>
    </div>
  );
}

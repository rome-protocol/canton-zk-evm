import type { StatusNotice } from "../api.ts";
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

/** The link's address when it is an http(s) one, and nothing otherwise: the server checks it, and the page checks it again before it is an href. */
export function safeHref(url: string | undefined): string | null {
  if (typeof url !== "string") return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch { return null; }
}

/**
 * One notice of the operators (`/api/status`'s `notices`) that has not ended: before its start it reads as planned work, after it as work in progress, and it is gone at its end, by the reader's own clock,
 * so a page that stays open needs no new status. A major one is the large banner ("Important notice:", with its times); it is drawn larger and says nothing of maintenance. The text and the link's label
 * are the server's plain text and are drawn as text; the link is an anchor only for an http(s) address.
 */
export function NoticeBanner({ notice }: { notice: StatusNotice | null | undefined }) {
  const now = useNow();
  if (!notice) return null;
  const start = Date.parse(notice.startsAt), end = Date.parse(notice.endsAt);
  // A time that is not one, or work that is over, shows nothing.
  if (Number.isNaN(start) || Number.isNaN(end) || now >= end) return null;
  const started = now >= start, major = notice.level === "major";
  const href = notice.link ? safeHref(notice.link.url) : null;
  const label = major ? "Important notice:" : started ? "Maintenance in progress:" : "Planned maintenance:";
  return (
    <div className={`notice ${major ? "major " : ""}${started ? "now" : "planned"}`} role="status">
      <Icon name="warn" size={major ? 22 : 15} />
      <p>
        <b>{label}</b> {notice.text}{" "}
        <span className="notice-when">{started ? noticeUntil(notice.endsAt, now) : noticeRange(notice.startsAt, notice.endsAt)}</span>
        {href && notice.link && <a className="notice-link" href={href} target="_blank" rel="noopener noreferrer">{notice.link.label}</a>}
      </p>
    </div>
  );
}

/** Every notice, the major ones above the others. A server that sends only `notice` (from before the list), or an empty list beside one, gives the one. */
export function NoticeBanners({ notices, notice }: { notices?: StatusNotice[] | null; notice?: StatusNotice | null }) {
  const list = notices?.length ? notices : notice ? [notice] : [];
  const sorted = [...list.filter((n) => n.level === "major"), ...list.filter((n) => n.level !== "major")];
  return <>{sorted.map((n, i) => <NoticeBanner key={`${i}:${n.startsAt}:${n.text}`} notice={n} />)}</>;
}

const PATHS = {
  copy: <><rect x="5" y="5" width="8.5" height="8.5" rx="1.6" /><path d="M10.5 5V3.6c0-.9-.7-1.6-1.6-1.6H3.6C2.7 2 2 2.7 2 3.6v5.3c0 .9.7 1.6 1.6 1.6H5" /></>,
  check: <path d="M3 8.4l3.1 3.1L13 4.6" />,
  cross: <path d="M4 4l8 8M12 4l-8 8" />,
  search: <><circle cx="7" cy="7" r="4.6" /><path d="M10.4 10.4L14 14" /></>,
  info: <><circle cx="8" cy="8" r="6.2" /><path d="M8 7.2v4M8 4.9v.1" /></>,
  lock: <><rect x="3.2" y="7" width="9.6" height="6.8" rx="1.4" /><path d="M5.3 7V5.2a2.7 2.7 0 015.4 0V7" /></>,
  warn: <><path d="M8 2.2l6.2 11H1.8z" /><path d="M8 6.6v3.2M8 11.6v.1" /></>,
  prev: <path d="M10 3L5 8l5 5" />,
  next: <path d="M6 3l5 5-5 5" />,
  up: <path d="M3.5 10l4.5-4.5L12.5 10" />,
  down: <path d="M3.5 6l4.5 4.5L12.5 6" />,
  expand: <path d="M2.5 6V2.5H6M13.5 10v3.5H10M2.5 2.5l4 4M13.5 13.5l-4-4" />,
  link: <><path d="M6.8 9.2a2.6 2.6 0 003.7 0l2-2a2.6 2.6 0 00-3.7-3.7l-.6.6" /><path d="M9.2 6.8a2.6 2.6 0 00-3.7 0l-2 2a2.6 2.6 0 003.7 3.7l.6-.6" /></>,
  cube: <><path d="M8 1.8l5.6 3.1v6.2L8 14.2l-5.6-3.1V4.9z" /><path d="M2.6 5L8 8l5.4-3M8 8v6" /></>,
  clock: <><circle cx="8" cy="8" r="6.2" /><path d="M8 4.6V8l2.3 1.5" /></>,
  shield: <><path d="M8 1.8l5 1.8v4c0 3-2.1 5-5 6.6-2.9-1.6-5-3.6-5-6.6v-4z" /><path d="M5.8 8.1l1.6 1.6 2.9-3" /></>,
  bolt: <path d="M9 1.8L3.6 9H8l-1 5.2L12.4 7H8z" />,
  doc: <><path d="M4 1.8h5.2L12.6 5.2v8.2c0 .5-.4.8-.8.8H4c-.5 0-.8-.3-.8-.8V2.6c0-.5.3-.8.8-.8z" /><path d="M9 1.9v3.5h3.5M5.4 8.4h5.2M5.4 11h5.2" /></>,
  download: <path d="M8 2.4v7.6M4.8 7.2L8 10.4l3.2-3.2M2.8 13.2h10.4" />,
  activity: <path d="M1.8 8h2.6l1.8-4 3.2 8 1.8-4h3" />,
  funnel: <path d="M2.2 3h11.6L9.6 8.4v4.1L6.4 14.2V8.4z" />,
  menu: <path d="M2.6 4.4h10.8M2.6 8h10.8M2.6 11.6h10.8" />,
} as const;

/** The names of the icons, for the pages and the tests. */
export const ICON_NAMES = Object.keys(PATHS) as ReadonlyArray<keyof typeof PATHS>;

/** A small line icon in the current text colour. It is decoration: whatever it sits in carries the meaning. */
export function Icon({ name, size = 14 }: { name: keyof typeof PATHS; size?: number }) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

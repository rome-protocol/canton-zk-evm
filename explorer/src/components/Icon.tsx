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
} as const;

/** A small line icon in the current text colour. It is decoration: whatever it sits in carries the meaning. */
export function Icon({ name, size = 14 }: { name: keyof typeof PATHS; size?: number }) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

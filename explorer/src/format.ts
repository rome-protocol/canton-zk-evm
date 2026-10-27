/** A hash or id with its middle left out: six characters and four, by default. A value that short already is left whole. */
export const short = (value: string, lead = 6, tail = 4) => (value.length <= lead + tail + 1 ? value : `${value.slice(0, lead)}…${value.slice(-tail)}`);

/**
 * A Canton update id as on the screens: by default its first eight characters (the "1220" prefix and four more) and its last four, as the
 * home page shows it. The Blocks list shows 10 and 6, the update lists and the Canton record 12 and 6 or 12 and 8: a page passes its own.
 */
export const shortUpdate = (id: string, lead = 8, tail = 4) => short(id, lead, tail);

/** Clock time in UTC, to the second. Times on every page are UTC, so that two visitors comparing notes read the same thing. */
export const utc = (ms: number) => `${new Date(ms).toISOString().slice(11, 19)} UTC`;

/** A length of time: seconds up to two minutes, then minutes and seconds, then hours and minutes. Never negative: clocks on two machines can differ by a moment. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 120) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 60)} h`;
}

/** How long a block took to commit: from its own timestamp, in whole seconds, to Canton's record time. */
export const commitTime = (timestampSeconds: number, recordTime: string) => duration(Date.parse(recordTime) - timestampSeconds * 1000);

/** A measured time in seconds: two places under a minute ("7.24 s"), then minutes and whole seconds ("1 min 28 s"). */
export function span(totalSeconds: number): string {
  const t = Math.max(0, totalSeconds);
  if (t < 59.995) return `${t.toFixed(2)} s`;
  const s = Math.round(t), m = Math.floor(s / 60);
  return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
}

/** A whole number with its thousands grouped. */
export const count = (n: number | string | bigint) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/**
 * An amount in whole coins, from its smallest unit. A fraction keeps five places when the amount is one or more, and three significant
 * digits when it is less than one. It is cut, not rounded, so that it never shows more than the amount holds. A page puts the exact
 * value in the `title` of what it shows (see `exact`).
 */
export function units(raw: string, decimals: number): string {
  const v = BigInt(raw), base = 10n ** BigInt(decimals), whole = v / base;
  let fraction = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  if (fraction) {
    const leading = fraction.length - fraction.replace(/^0+/, "").length;
    fraction = fraction.slice(0, whole > 0n ? 5 : leading + 3).replace(/0+$/, "");
  }
  return count(whole) + (fraction ? `.${fraction}` : "");
}

/** The same amount with every digit, for a tooltip. */
export function exact(raw: string, decimals: number): string {
  const v = BigInt(raw), base = 10n ** BigInt(decimals);
  const fraction = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return count(v / base) + (fraction ? `.${fraction}` : "");
}

/**
 * An amount for a narrow cell: at most six decimals, rounded, with a thousands-separated whole part, and "<0.000001" for a non-zero amount below that. A page puts the
 * exact value in the `title` of what it shows (see `exact`).
 */
export function compactUnits(raw: string, decimals: number): string {
  const v = BigInt(raw);
  if (decimals <= 6) return exact(raw, decimals);
  const step = 10n ** BigInt(decimals - 6);
  if (v > 0n && v < step) return "<0.000001";
  const q = (v + step / 2n) / step, million = 1_000_000n;
  const fraction = (q % million).toString().padStart(6, "0").replace(/0+$/, "");
  return count(q / million) + (fraction ? `.${fraction}` : "");
}

/** A fee rate: in gwei with up to two places, or in wei when it is below 0.01 gwei. */
export function gwei(wei: string): string {
  const v = BigInt(wei);
  if (v < 10_000_000n) return `${v} wei`;
  const hundredths = v / 10_000_000n;
  const fraction = (hundredths % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  return `${hundredths / 100n}${fraction ? `.${fraction}` : ""} gwei`;
}

/** A base fee in gwei to three significant digits ("0.0673 gwei"), or in wei when it is below a millionth of a gwei. Gwei() rounds to hundredths, which would show 0.07 for a fee of 0.0673. */
export function baseFee(wei: string): string {
  const v = BigInt(wei);
  if (v === 0n) return "0 gwei";
  if (v < 1_000_000n) return `${v} wei`;
  const g = Number(v) / 1e9;
  return `${g >= 1000 ? count(Math.round(g)) : String(Number(g.toPrecision(3)))} gwei`;
}

/** The size of hex data, in bytes. */
export const bytesOf = (hex: string) => `${count(hex.length / 2)} B`;

/** Canton's record time as clock time in UTC, to the millisecond. */
export const utcMs = (iso: string) => `${new Date(Date.parse(iso)).toISOString().slice(11, 23)} UTC`;

/** The date of a time, in UTC. */
export const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** The date and the minute, as '2026-10-23 12:01 UTC'. */
export const utcMinute = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** How long after the block was made Canton recorded it, to a tenth of a second. A long time is told the way `duration` tells it. */
export function seconds(timestampSeconds: number, recordTime: string): string {
  const ms = Math.max(0, Date.parse(recordTime) - timestampSeconds * 1000);
  return ms < 120_000 ? `${(ms / 1000).toFixed(1)} s` : duration(ms);
}

/** A Canton party id: its name, then the first four and last four characters of the identifier after it. */
export function party(id: string): string {
  const [name, rest] = id.split("::");
  return rest && rest.length > 8 ? `${name}::${rest.slice(0, 4)}…${rest.slice(-4)}` : id;
}

/** A time for a figure: two places under a second, one under 100 s, whole seconds under ten minutes, then minutes. */
export const sec = (s: number) => (s < 1 ? `${s.toFixed(2)} s` : s < 100 ? `${s.toFixed(1)} s` : s < 600 ? `${Math.round(s)} s` : span(s));
/** A share as a percentage, cut and never rounded up, so 99.96 % is not shown as 100 %. */
export const pct = (r: number) => (r >= 1 ? "100%" : `${Math.floor(r * 1000) / 10}%`);
export const trim = (n: number, places: number) => String(+n.toFixed(places));
/** A rate of transactions per second: one place from 1 up, and two significant figures under 1, so one transaction in a minute (0.017) is not shown as 0. */
export const rate = (n: number) => (n >= 1 ? trim(n, 1) : n === 0 ? "0" : String(+n.toPrecision(2)));
/** The busiest minute as a count, for a peak under 1 tx/s: "2 tx in the busiest minute" (a minute has 60 s, so the rate is the count over 60). */
export const peakCount = (perSecond: number) => plural(Math.round(perSecond * 60), "tx", "tx");
/** A peak without the decimals once it is 10 or more ("181"), as the home card says it. */
export const rateShort = (n: number) => (n >= 10 ? String(Math.round(n)) : rate(n));
/** A big count in short: "6.96 M" from a million, "12.4 k" from ten thousand, the whole count under that. */
export const compactCount = (n: number) => (n >= 1_000_000 ? `${trim(n / 1_000_000, 2)} M` : n >= 10_000 ? `${trim(n / 1000, 1)} k` : count(n));
export const plural = (n: number, one: string, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`;

/** A fee in whole coins to ten decimals, cut and never rounded, with the zeros at the end left off ("0.0000035364"). A fee below the tenth place is "<0.0000000001", never "0". */
export function feeOf(raw: string, decimals: number): string {
  const v = BigInt(raw);
  if (v === 0n) return "0";
  const places = Math.min(10, decimals), cut = 10n ** BigInt(decimals - places);
  const scaled = v / cut; // in units of 10^-places
  if (scaled === 0n) return `<0.${"0".repeat(places - 1)}1`;
  const unit = 10n ** BigInt(places);
  const fraction = (scaled % unit).toString().padStart(places, "0").replace(/0+$/, "");
  return count(scaled / unit) + (fraction ? `.${fraction}` : "");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A date and time as 'DD Mon YYYY, HH:MM:SS UTC' ("20 Oct 2026, 17:44:57 UTC"): the one way every page writes one. Takes milliseconds or an ISO time. */
export function dateTime(at: number | string): string {
  const d = new Date(typeof at === "number" ? at : Date.parse(at));
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${d.toISOString().slice(11, 19)} UTC`;
}

/** A hash or id with its middle left out: six characters and four, by default. A value that short already is left whole. */
export const short = (value: string, lead = 6, tail = 4) => (value.length <= lead + tail + 1 ? value : `${value.slice(0, lead)}…${value.slice(-tail)}`);

/** A Canton update id: its "1220" prefix, then eight characters of the rest and the last four. */
export const shortUpdate = (id: string) => `${id.slice(0, 4)} ${id.slice(4, 8)}…${id.slice(-4)}`;

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

/** A fee rate: in gwei with up to two places, or in wei when it is below 0.01 gwei. */
export function gwei(wei: string): string {
  const v = BigInt(wei);
  if (v < 10_000_000n) return `${v} wei`;
  const hundredths = v / 10_000_000n;
  const fraction = (hundredths % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  return `${hundredths / 100n}${fraction ? `.${fraction}` : ""} gwei`;
}

/** The size of hex data, in bytes. */
export const bytesOf = (hex: string) => `${count(hex.length / 2)} B`;

/** Canton's record time as clock time in UTC, to the millisecond. */
export const utcMs = (iso: string) => `${new Date(Date.parse(iso)).toISOString().slice(11, 23)} UTC`;

/** The date of a time, in UTC. */
export const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

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

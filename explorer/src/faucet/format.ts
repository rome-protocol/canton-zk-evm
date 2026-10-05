/** Whole coins with thousands separators, and up to four decimals (cut down, never rounded up, without trailing zeros). */
export function formatCoin(smallest: string, decimals: number): string {
  const unit = 10n ** BigInt(decimals);
  const value = BigInt(smallest);
  const whole = value / unit;
  const places = Math.min(4, decimals);
  const fraction = ((value % unit) * 10n ** BigInt(places)) / unit;
  if (whole === 0n && fraction === 0n && value !== 0n) return `less than 0.${"0".repeat(places - 1)}1`;
  const digits = whole.toString().replace(/\B(?=(\d{3})+$)/g, ",");
  const tail = fraction === 0n ? "" : "." + fraction.toString().padStart(places, "0").replace(/0+$/, "");
  return digits + tail;
}

/** How long to wait, rounded up so that nobody is told to try before the faucet will answer: 2 s, 5 min, 23 h 41 min. */
export function formatWait(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.ceil(seconds))} s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** The faucet's window in words: 24 hours, 1 hour, 90 seconds. */
export function formatPeriod(seconds: number): string {
  if (seconds % 3600 === 0) return seconds === 3600 ? "1 hour" : `${seconds / 3600} hours`;
  return `${seconds} seconds`;
}

/** The first four digits and the last four: 0x35f4…bbb7. */
export function shortHash(hash: string): string {
  return hash.length <= 12 ? hash : `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

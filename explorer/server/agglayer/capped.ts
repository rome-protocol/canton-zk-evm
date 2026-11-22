/** The text of a response, read as it arrives and stopped at `max` bytes, so a long answer never sits in memory. `tooLong` makes the error to throw past the limit. */
export async function cappedText(res: Response, max: number, tooLong: () => Error): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { await reader.cancel().catch(() => undefined); throw tooLong(); }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

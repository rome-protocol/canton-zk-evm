/** A JSON-RPC answer that was an error: its message as reth worded it, and its code. */
export class RpcError extends Error {
  readonly code: number;
  constructor(message: string, code: number) { super(message); this.code = code; }
}

/** One call to this explorer's public RPC (/rpc), which answers about final blocks only. */
export async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  let res: Response;
  try {
    res = await fetch("/rpc", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  } catch {
    throw new RpcError("The explorer's RPC cannot be reached right now.", 0);
  }
  const body = (await res.json().catch(() => null)) as { result?: T; error?: { code?: number; message?: string } } | null;
  if (!body) throw new RpcError("The explorer's RPC cannot be reached right now.", 0);
  if (body.error) throw new RpcError(String(body.error.message ?? "The call failed."), Number(body.error.code ?? 0));
  return body.result as T;
}

/** How many reads one page has in flight at once: the RPC holds 64 across all clients and 300 a minute for each. */
const MOST_AT_ONCE = 6;
let running = 0;
const waiting: (() => void)[] = [];
async function turn<T>(job: () => Promise<T>): Promise<T> {
  if (running >= MOST_AT_ONCE) await new Promise<void>((go) => waiting.push(go));
  running++;
  try { return await job(); } finally { running--; waiting.shift()?.(); }
}

/** The final block the RPC reports. A page that makes many reads asks once and hands the block to each. */
export async function finalBlock(): Promise<number> { return Number(BigInt(await rpc<string>("eth_blockNumber"))); }

/** A `eth_call` of `data` at `to`, at the final `block` the page read once: the answer and that block. Nothing is signed and nothing is sent. */
export async function ethCall(to: string, data: string, block: number): Promise<{ result: string; block: number }> {
  const result = await turn(() => rpc<string>("eth_call", [{ to, data }, "0x" + block.toString(16)]));
  return { result, block };
}

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

/** A `eth_call` of `data` at `to`, at the final block the RPC reports: the answer and that block. Nothing is signed and nothing is sent. */
export async function ethCall(to: string, data: string): Promise<{ result: string; block: number }> {
  const block = Number(BigInt(await rpc<string>("eth_blockNumber")));
  const result = await rpc<string>("eth_call", [{ to, data }, "0x" + block.toString(16)]);
  return { result, block };
}

import { EtherscanProvider } from "ethers";
import { expect, it } from "vitest";

/** What the checks need to know of the chain behind an explorer. */
export interface ClientTarget {
  /** Where the explorer listens, with no path. */
  url: string;
  chainId: number;
  /** An address without code, and the coins it holds at the final block. */
  address: string;
  balance: bigint;
  /** A transaction that is final. */
  txHash: string;
}

/**
 * An ethers `EtherscanProvider` with its base URL set to the explorer, as the design (section 6.2) says a user points it. ethers v6 writes
 * `api.etherscan.io/v2/api?chainid=` into its URLs and takes only the chains it knows, so it is made as the mainnet's and its three URL
 * makers give the explorer's `/v2/api` and this chain's id instead; everything else, from the module and action names to how it reads the answers, is ethers' own.
 */
class OstiaProvider extends EtherscanProvider {
  base = "";
  chain = 0;
  override getUrl(module: string, params: Record<string, string>): string {
    const query = Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => `&${k}=${v}`).join("");
    return `${this.base}/v2/api?chainid=${this.chain}&module=${module}${query}&apikey=any`;
  }
  override getPostUrl(): string { return `${this.base}/v2/api?chainid=${this.chain}`; }
  override getPostData(module: string, params: Record<string, string>): Record<string, string> { return { ...params, module, chainid: String(this.chain), apikey: "any" }; }
}

export function ostiaProvider(t: Pick<ClientTarget, "url" | "chainId">): EtherscanProvider {
  const p = new OstiaProvider("mainnet", "any");
  p.base = t.url;
  p.chain = t.chainId;
  return p;
}

/** The checks, as `it`s: ethers' `EtherscanProvider` against the explorer's Etherscan door, and the proxy actions ethers does not use, as Etherscan's documentation gives them. */
export function ethersChecks(t: ClientTarget): void {
  /** Made when a check runs: the explorer may be started after the checks are declared. */
  const made: { p?: EtherscanProvider } = {};
  const provider = new Proxy({} as EtherscanProvider, { get: (_, k) => { const p = (made.p ??= ostiaProvider(t)); const v = Reflect.get(p, k, p); return typeof v === "function" ? v.bind(p) : v; } });
  /** One GET of the door; a client over its limit is told to wait, and waits. */
  const door = async (query: string): Promise<any> => { // eslint-disable-line @typescript-eslint/no-explicit-any
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${t.url}/api?${query}`);
      if (!res.headers.has("retry-after") || attempt >= 10) return res.json(); // a refusal is HTTP 200 with Retry-After, as Etherscan's is
      await new Promise((ok) => setTimeout(ok, Math.max(1, Number(res.headers.get("retry-after") ?? "1")) * 1000));
    }
  };
  const head = async (): Promise<number> => provider.getBlockNumber();

  it("ethers: the block number and the blocks, in the shapes ethers reads", async () => {
    const n = await head();
    expect(n).toBeGreaterThan(0);
    const b = await provider.getBlock(n);
    expect(b?.number).toBe(n);
    expect(b?.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect((await provider.getBlock("latest"))?.number).toBeGreaterThanOrEqual(n);
    expect(await provider.getBlock(n + 1_000_000)).toBeNull();
  });

  it("ethers: the account's coins (the account module), count, code, storage and a call", async () => {
    expect(await provider.getBalance(t.address)).toBe(t.balance);
    expect(await provider.getTransactionCount(t.address)).toBeGreaterThanOrEqual(0);
    expect(await provider.getCode(t.address)).toBe("0x");
    expect(await provider.getStorage(t.address, 0)).toMatch(/^0x0*$/);
    expect(await provider.call({ to: t.address, data: "0x" })).toBe("0x");
  });

  it("ethers: the price of gas and the estimate of a plain send", async () => {
    expect((await provider.getFeeData()).gasPrice).not.toBeNull();
    expect(await provider.estimateGas({ to: t.address, value: 1 })).toBe(21000n);
  });

  it("ethers: a final transaction and its receipt", async () => {
    const tx = await provider.getTransaction(t.txHash);
    expect(tx?.hash.toLowerCase()).toBe(t.txHash.toLowerCase());
    expect(tx?.blockNumber).not.toBeNull();
    const r = await provider.getTransactionReceipt(t.txHash);
    expect(r?.status).toBe(1);
    expect(r?.blockNumber).toBe(tx?.blockNumber);
  });

  it("the proxy actions ethers does not use: the count and the pick by index, in hex", async () => {
    const tx = await provider.getTransaction(t.txHash);
    const tag = "0x" + (tx!.blockNumber as number).toString(16), index = "0x" + (tx!.index as number).toString(16);
    const count = await door(`module=proxy&action=eth_getBlockTransactionCountByNumber&tag=${tag}`);
    expect(count.jsonrpc).toBe("2.0");
    expect(count.result).toMatch(/^0x[1-9a-f][0-9a-f]*$/);
    const picked = await door(`module=proxy&action=eth_getTransactionByBlockNumberAndIndex&tag=${tag}&index=${index}`);
    expect(picked.result.hash.toLowerCase()).toBe(t.txHash.toLowerCase());
    expect((await door(`module=proxy&action=eth_getUncleByBlockNumberAndIndex&tag=${tag}&index=0x0`)).result).toBeNull();
    expect((await door("module=proxy&action=eth_blockNumber")).result).toMatch(/^0x[1-9a-f][0-9a-f]*$/);
  });
}

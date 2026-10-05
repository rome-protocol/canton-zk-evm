import type { Config } from "./config.ts";
import { createFaucet, type Faucet } from "./faucet.ts";
import { LedgerError, type Ledger } from "./ledger.ts";
import type { ChainIndex } from "./chain-index.ts";
import type { FactCheck, ProofCheck } from "./proof.ts";
import { RethError, type Reth, type Tx, type TokenInfo } from "./reth.ts";

/** The fields of each answer, and of each object inside one. Nothing else is ever sent: the answers are built field by field, and the API field test holds every object to these lists. */
export const FIELDS = {
  status: ["chainId", "chainName", "coin", "pins", "ok", "starting", "problems", "evm", "canton", "final", "proving", "latest", "signers", "faucet"],
  coin: ["symbol", "decimals"],
  pins: ["programVK", "rootC", "file"],
  final: ["number", "hash", "timestamp", "recordTime"],
  proving: ["number", "hash", "timestamp"],
  /** One of the newest final blocks, for the home page's list. */
  latest: ["number", "hash", "timestamp", "txCount", "updateId", "recordTime"],
  signers: ["operator", "confirmer"],
  faucet: ["on"],
  /** What the faucet shows about itself, and what it answers a request with. */
  faucetInfo: ["on", "address", "balance", "amount", "perAddressSeconds"],
  faucetSent: ["hash", "to", "amount"],
  block: ["status", "number", "hash", "parentHash", "timestamp", "txCount", "gasUsed", "gasLimit", "baseFee", "miner", "stateRoot", "genesisReferenced", "canton", "transactions"],
  canton: ["updateId", "recordTime", "template", "proofBytes", "proof", "hashesMatch", "headerHex", "txsHex", "proofHex"],
  /** The proof's three facts, each of which is a {value, ok} pair. */
  proof: ["programVK", "rootC", "blockHash"],
  fact: ["value", "ok"],
  blockTx: ["hash", "from", "to", "success", "transfer"],
  transfer: ["symbol", "decimals", "to", "value"],
  txBlock: ["number", "hash", "updateId"],
  log: ["address", "topics", "data"],
  tx: ["hash", "status", "block", "from", "to", "value", "nonce", "type", "gas", "gasUsed", "gasPrice", "fee", "success", "input", "logs", "transfer", "toToken", "created"],
  address: ["address", "kind", "balance", "nonce", "token", "createdBy"],
  token: ["name", "symbol", "decimals"],
  createdBy: ["txHash", "block"],
} as const;

/** A copy of an object with the listed fields and no others. */
const pick = <T extends object, K extends keyof T>(o: T, fields: readonly K[]): Pick<T, K> => Object.fromEntries(fields.map((k) => [k, o[k]])) as Pick<T, K>;
const fact = (f: FactCheck) => pick(f, FIELDS.fact);
const proofOf = (p: ProofCheck | null) => p && { programVK: fact(p.programVK), rootC: fact(p.rootC), blockHash: fact(p.blockHash) };

export const NOT_FOUND = "Not found. Search takes a block number, a block or transaction hash, an address, or a Canton update id. A block that Canton refused is gone, and cannot be found.";

export interface Answer { status: number; body: unknown; headers?: Record<string, string> }
/** `body` is the text of a POST's body. */
export type Api = (method: string, target: string, body?: string) => Promise<Answer>;
/** With no `faucet`, the faucet is off. */
export interface ApiDeps { config: Config; reth: Reth; ledger: Ledger; index: ChainIndex; faucet?: Faucet }

const HASH = /^0x[0-9a-f]{64}$/, ADDRESS = /^0x[0-9a-f]{40}$/, UPDATE = /^1220[0-9a-f]{64}$/;
// transfer(address,uint256) with its two arguments, and nothing else
const TRANSFER = /^0xa9059cbb0{24}([0-9a-f]{40})([0-9a-f]{64})$/;
const ok = (body: unknown): Answer => ({ status: 200, body });
const fail = (status: number, error: string): Answer => ({ status, body: { error } });
const dec = (n: bigint | number) => n.toString();

export function createApi({ config, reth, ledger, index, faucet = createFaucet({ ...config.faucet, key: null, chainId: config.chainId, reth }) }: ApiDeps): Api {
  // What reth said about a token, as the promise, so that the transfers of one block share one set of calls. It is dropped when the index starts a new run.
  let seen = new Map<string, Promise<TokenInfo | null>>(), seenRun = index.status().run;
  /** A token's name, symbol and decimals: from the index when a block created it, else asked of reth once per run. */
  function tokenOf(address: string): Promise<TokenInfo | null> {
    const known = index.token(address);
    if (known) return Promise.resolve(known);
    const run = index.status().run;
    if (run !== seenRun) { seen = new Map(); seenRun = run; }
    const mine = seen;
    let asked = mine.get(address);
    if (!asked) {
      asked = reth.token(address);
      mine.set(address, asked);
      asked.catch(() => mine.delete(address)); // a failed read is asked again next time
    }
    return asked;
  }
  async function transferOf(t: Tx) {
    const m = TRANSFER.exec(t.input);
    const token = m && t.to ? await tokenOf(t.to) : null;
    return m && token ? { symbol: token.symbol, decimals: token.decimals, to: "0x" + m[1], value: dec(BigInt("0x" + m[2])) } : null;
  }

  async function status(): Promise<Answer> {
    const latest = await reth.block("latest").then((b) => b, () => undefined);
    const canton = await ledger.ledgerEnd().then(() => true, () => false);
    const s = index.status(), head = index.head();
    const proving = latest && latest.number > (head?.number ?? 0) ? latest : null;
    const all = s.ok && latest !== undefined && canton;
    return {
      status: all ? 200 : 503,
      body: {
        chainId: config.chainId, chainName: config.chainName, coin: pick(config.coin, FIELDS.coin), pins: pick(config.pins, FIELDS.pins), ok: all, starting: s.starting, problems: s.problems, evm: latest !== undefined, canton,
        final: head ? pick(head, FIELDS.final) : null,
        proving: proving ? pick(proving, FIELDS.proving) : null,
        latest: index.latest(10).map((b) => pick(b, FIELDS.latest)),
        signers: s.signers && pick(s.signers, FIELDS.signers), faucet: { on: faucet.on },
      },
    };
  }

  async function block(id: string): Promise<Answer> {
    const key = HASH.test(id) ? id : /^\d+$/.test(id) && Number.isSafeInteger(Number(id)) ? Number(id) : null;
    if (key === null) return fail(400, "A block is named by its number or its 0x hash.");
    const b = await reth.block(key, true);
    if (!b) return fail(404, NOT_FOUND);
    const final = index.byNumber(b.number), onCanton = final && final.hash === b.hash ? final : null;
    const receipts = b.transactions.length ? await reth.blockReceipts(b.number) : [];
    const transactions = await Promise.all(b.transactions.map(async (t, i) => ({
      hash: t.hash, from: t.from, to: t.to, success: receipts?.[i]?.success ?? null, transfer: await transferOf(t),
    })));
    const genesis = b.number === 0;
    return ok({
      status: genesis ? "genesis" : onCanton ? "final" : "proving", number: b.number, hash: b.hash, parentHash: b.parentHash, timestamp: b.timestamp,
      txCount: b.transactions.length, gasUsed: b.gasUsed, gasLimit: b.gasLimit, baseFee: b.baseFeePerGas === null ? null : dec(b.baseFeePerGas), miner: b.miner, stateRoot: b.stateRoot,
      genesisReferenced: genesis ? index.status().genesisReferenced : null,
      canton: onCanton && {
        updateId: onCanton.updateId, recordTime: onCanton.recordTime, template: "Zk.Chain:BlockRecord", proofBytes: onCanton.proofHex.length / 2, proof: proofOf(onCanton.proof),
        hashesMatch: onCanton.hashesMatch, headerHex: onCanton.headerHex, txsHex: onCanton.txsHex, proofHex: onCanton.proofHex,
      },
      transactions,
    });
  }

  async function transaction(hash: string): Promise<Answer> {
    if (!HASH.test(hash)) return fail(400, "A transaction is named by its 0x hash.");
    const t = await reth.transaction(hash);
    if (!t) return fail(404, NOT_FOUND);
    const r = t.blockNumber === null ? null : await reth.receipt(hash);
    const final = index.byNumber(index.tx(hash)?.block ?? -1);
    const onCanton = final && final.hash === t.blockHash ? final : null;
    const transfer = await transferOf(t);
    return ok({
      hash: t.hash, status: t.blockNumber === null ? "waiting" : onCanton ? "final" : "proving",
      block: t.blockNumber === null ? null : { number: t.blockNumber, hash: t.blockHash, updateId: onCanton?.updateId ?? null },
      from: t.from, to: t.to, value: dec(t.value), nonce: t.nonce, type: t.type, gas: t.gas,
      gasUsed: r?.gasUsed ?? null, gasPrice: r ? dec(r.effectiveGasPrice) : null, fee: r ? dec(BigInt(r.gasUsed) * r.effectiveGasPrice) : null, success: r?.success ?? null,
      input: t.input, logs: (r?.logs ?? []).map((l) => ({ address: l.address, topics: [...l.topics], data: l.data })), transfer, toToken: transfer?.symbol ?? (t.to ? index.token(t.to)?.symbol ?? null : null), created: r?.contractAddress ?? null,
    });
  }

  async function address(a: string): Promise<Answer> {
    if (!ADDRESS.test(a)) return fail(400, "An address is 0x and 40 hex digits.");
    const [balance, nonce, code] = await Promise.all([reth.balance(a), reth.nonce(a), reth.code(a)]);
    const token = code === "0x" ? null : await reth.token(a), created = index.contract(a) ?? null;
    return ok({ address: a, kind: token ? "token" : code === "0x" ? "account" : "contract", balance: dec(balance), nonce, token: token && pick(token, FIELDS.token), createdBy: created && pick(created, FIELDS.createdBy) });
  }

  /** Works out what was typed from its shape. A block, transaction or update that nothing holds is not found. */
  async function search(q: string): Promise<Answer> {
    const go = (path: string) => ok({ path });
    if (/^\d+$/.test(q) && Number.isSafeInteger(Number(q))) return (await reth.block(Number(q))) ? go(`/block/${q}`) : fail(404, NOT_FOUND);
    if (HASH.test(q)) return (await reth.transaction(q)) ? go(`/tx/${q}`) : (await reth.block(q)) ? go(`/block/${q}`) : fail(404, NOT_FOUND);
    if (ADDRESS.test(q)) return go(`/address/${q}`);
    const byUpdate = UPDATE.test(q) ? index.byUpdate(q) : undefined;
    return byUpdate ? go(`/block/${byUpdate.number}`) : fail(404, NOT_FOUND);
  }

  /** Gives the coin to the address in the body, `{"address": "0x…"}`. The faucet answers every case itself. */
  async function giveCoin(body: string | undefined): Promise<Answer> {
    if (!faucet.on) return faucet.request(undefined);
    let asked: unknown;
    try {
      asked = JSON.parse(body ?? "");
    } catch {
      return fail(400, 'Send a JSON body such as {"address": "0x…"}.');
    }
    const result = await faucet.request(typeof asked === "object" && asked !== null ? (asked as { address?: unknown }).address : undefined);
    return result.status === 200 ? { ...result, body: pick(result.body as { hash: string; to: string; amount: string }, FIELDS.faucetSent) } : result;
  }

  return async (method, target, body) => {
    let url: URL, parts: string[];
    try {
      if (!/^\/(?!\/)/.test(target)) throw new Error("not a path");
      url = new URL(target, "http://explorer");
      parts = url.pathname.split("/").slice(1).map((x) => decodeURIComponent(x).toLowerCase());
    } catch {
      return fail(400, "That is not a valid address.");
    }
    const [root, name, arg] = parts;
    try {
      if (url.pathname === "/healthz") return method === "GET" ? await status() : fail(405, "Use GET.");
      if (root !== "api" || parts.length > 3) return fail(404, "No such route.");
      if (name === "faucet" && parts.length === 2) {
        if (method === "POST") return await giveCoin(body);
        return method === "GET" ? ok(pick(await faucet.info(), FIELDS.faucetInfo)) : fail(405, "Use GET or POST.");
      }
      const read = new Map<string, (() => Promise<Answer>) | undefined>([
        ["status", parts.length === 2 ? status : undefined],
        ["block", arg ? () => block(arg) : undefined],
        ["tx", arg ? () => transaction(arg) : undefined],
        ["address", arg ? () => address(arg) : undefined],
        ["search", parts.length === 2 ? () => search((url.searchParams.get("q") ?? "").trim().toLowerCase()) : undefined],
      ]);
      const route = read.get(name ?? "");
      if (!route) return fail(404, "No such route.");
      return method === "GET" ? await route() : fail(405, "Use GET.");
    } catch (e) {
      if (!(e instanceof RethError || e instanceof LedgerError)) throw e;
      console.error(`${method} ${url.pathname}: ${e.message}`);
      return fail(502, "The explorer cannot read the chain right now.");
    }
  };
}

import { keyFor, type Config } from "./config.ts";
import { createFaucet, type Faucet } from "./faucet.ts";
import { LedgerError, type Ledger } from "./ledger.ts";
import { keccak256 } from "viem";
import { ChainDbError, type ChainDb } from "./chain-db.ts";
import { checkProofFacts, readProofFacts, type FactCheck, type ProofCheck } from "./proof.ts";
import { RethError, type Reth, type TokenInfo } from "./reth.ts";
import type { Tracker, TxState } from "./tracker.ts";
import { cached, type Rule } from "./rest/cache.ts";
import { chainRoutes } from "./rest/chain-routes.ts";
import type { ChainRest } from "./rest/chain-rest.ts";
import { accountRoutes } from "./rest/account-routes.ts";
import { statsRoutes } from "./rest/stats-routes.ts";
import type { StatsRest } from "./rest/stats-rest.ts";
import type { AccountRest } from "./rest/account-rest.ts";
import type { PublicRpc } from "./public-rpc.ts";
import { etherscan } from "./rest/etherscan.ts";
import type { EtherscanRest } from "./rest/etherscan-rest.ts";
import { BadRequest } from "./rest/paging.ts";
import { buildOpenApi } from "./rest/openapi.ts";
import { router } from "./rest/router.ts";
import type { VerifyApi } from "./verifier/api.ts";
import { FIELDS, pick } from "./rest/fields.ts";
import type { BlockLeg } from "./indexer/leg-canton.ts";
import type { ApiHealth } from "./api-health.ts";
import { httpStatusOf } from "./health.ts";

export { FIELDS };


const fact = (f: FactCheck) => pick(f, FIELDS.fact);
const proofOf = (p: ProofCheck | null) => p && { programVK: fact(p.programVK), rootC: fact(p.rootC), blockHash: fact(p.blockHash) };

export const NOT_FOUND = "Not found. Search takes a block number, a block or transaction hash, an address, or a Canton update id. A block that Canton refused is gone, and cannot be found.";

export interface Answer { status: number; body: unknown; headers?: Record<string, string> }
/** `body` is the text of a POST's body. `ip` is the client's address, which the faucet limits. */
export type Api = (method: string, target: string, body?: string, ip?: string) => Promise<Answer>;
/** What `createApi` makes: the API, and the paths of its routes (`GET /api/openapi.json` describes them, and a test holds that it describes all of them). */
export type RoutedApi = Api & { routes: readonly string[] };
/** With no `faucet`, the faucet is off. */
export interface ApiDeps { config: Config; reth: Reth; ledger: Ledger; chain: ChainDb; faucet?: Faucet; tracker?: Tracker; now?: () => number;
  /** The reads behind the REST routes of blocks, transactions and Canton updates; without them those routes are off. */
  rest?: ChainRest;
  /** The reads behind the REST routes of addresses, contracts, tokens and legs, and the search by name; without them those routes are off. */
  accounts?: AccountRest;
  /** The reads behind the Etherscan-compatible `/api` and `/v2/api`; without them that door is off. */
  etherscanRest?: EtherscanRest;
  /** The public RPC, which the `proxy` module of the Etherscan door asks, so that it keeps the rules of `/rpc`; without it that module answers "not supported on Ostia". */
  rpc?: PublicRpc;
  /** The reads behind `/api/stats/summary` and `/api/stats/series`; without them those routes are off. */
  stats?: StatsRest;
  /** True when the server in front of this API also serves `GET /api/stream` (live updates), which the description then lists. */
  live?: boolean;
  /** The checks this API instance writes about what it sees: its own timer writes the rows in the background, and `/api/health` only reads the table and says which instance answered. Without it the answer shows the rows the other roles wrote. */
  health?: ApiHealth;
  /** The verification routes: a submission and where one is. Without it they are off. */
  verify?: VerifyApi }

/** Where a transaction is, as the page says: the tracker's states, and "unindexed" for one in a block that is final on Canton and not in the database yet. */
type ApiTxState = TxState | "unindexed";

const HASH = /^0x[0-9a-f]{64}$/, ADDRESS = /^0x[0-9a-f]{40}$/, UPDATE = /^1220[0-9a-f]{64}$/;
// transfer(address,uint256) with its two arguments, and nothing else
const TRANSFER = /^0xa9059cbb0{24}([0-9a-f]{40})([0-9a-f]{64})$/;
const ok = (body: unknown): Answer => ({ status: 200, body });
const fail = (status: number, error: string): Answer => ({ status, body: { error } });
const dec = (n: bigint | number) => n.toString();
/** How many addresses' token details are kept, and for how long: a token's name, symbol and decimals do not change, but a new chain on this process's database reuses addresses. */
const TOKENS_KEPT = 1000;
const TOKENS_KEPT_MS = 60_000;

export function createApi({ config, reth, ledger, chain, tracker, rest, accounts, etherscanRest, rpc, stats, live, verify, health: apiHealth, faucet = createFaucet({ ...config.faucet, captcha: null, key: null, chainId: config.chainId, reth }), now = Date.now }: ApiDeps): RoutedApi {
  // What reth said about an address as a token, as the promise, so that the transfers of one block share one set of calls. An address without code is no token and is
  // not asked about it. An entry is dropped after TOKENS_KEPT_MS (a new chain on the same database can put something else at an address) and the oldest goes first when
  // the cache is full. A failed read is asked again next time.
  const seen = new Map<string, { at: number; info: Promise<TokenInfo | null> }>();
  /** A token's name, symbol and decimals, asked of reth once for a while. */
  function tokenOf(address: string): Promise<TokenInfo | null> {
    const t = now();
    let entry = seen.get(address);
    if (entry && t - entry.at >= TOKENS_KEPT_MS) { seen.delete(address); entry = undefined; }
    if (!entry) {
      if (seen.size >= TOKENS_KEPT) seen.delete(seen.keys().next().value as string);
      const made = { at: t, info: reth.code(address).then((code) => (code === "0x" ? null : reth.token(address))) };
      seen.set(address, made);
      made.info.catch(() => { if (seen.get(address) === made) seen.delete(address); });
      entry = made;
    }
    return entry.info;
  }
  /** The number of reth's finalized block, which follows what Canton has committed; undefined when reth cannot say, and then nothing is called final. */
  const finalizedNumber = (): Promise<number | undefined> => reth.block("finalized").then((b) => b?.number, () => undefined);
  async function transferOf(input: string | null, to: string | null) {
    const m = input === null ? null : TRANSFER.exec(input);
    const token = m && to ? await tokenOf(to) : null;
    return m && token ? { symbol: token.symbol, decimals: token.decimals, to: "0x" + m[1], value: dec(BigInt("0x" + m[2])) } : null;
  }

  /** The most legs a block's answer carries: a block can record thousands, and `legsCount` and the paged legs route have the rest. A transaction's answer is bounded the same way (the first 50 of the legs it caused). */
  const BLOCK_LEGS = 50;

  /** A gateway leg in the fields of FIELDS.blockLeg, and the Canton side of its swap in the fields of FIELDS.legCanton. */
  const legOf = (l: BlockLeg) => ({ ...pick(l, FIELDS.blockLeg), canton: l.canton && { ...pick(l.canton, FIELDS.legCanton), instrument: l.canton.instrument && pick(l.canton.instrument, FIELDS.legInstrument) } });

  async function status(): Promise<Answer> {
    const latest = await reth.block("latest").then((b) => b, () => undefined);
    const canton = await ledger.ledgerEnd().then(() => true, () => false);
    const read = await Promise.all([chain.head(), chain.latest(10), chain.indexer(), chain.indexFacts()]).then((r) => r, (e: unknown) => e as Error);
    if (read instanceof Error) console.error(`status: ${read.message}`);
    const [head, newest, s, facts] = read instanceof Error ? [undefined, [], { started: false, problems: ["the database cannot be read"], down: true, signers: null }, { deriveCursor: null, chainInstance: null }] as const : read;
    // How far the index is behind Canton's finalized blocks (reth's finalized block is Canton's head); null while either is unknown.
    const finalizedNow = await finalizedNumber();
    const indexLag = head && finalizedNow !== undefined ? Math.max(0, finalizedNow - head.number) : null;
    // Above the indexed head, reth's newest block is being proven only if Canton does not hold it yet: at or below reth's finalized block it is final and the
    // indexer is behind (the problems line says so, and the block's page calls it unindexed), so it is not named as proving.
    const finalizedAt = latest && latest.number > (head?.number ?? 0) ? await finalizedNumber() : undefined;
    const proving = latest && latest.number > (head?.number ?? 0) && !(finalizedAt !== undefined && latest.number <= finalizedAt) ? latest : null;
    const starting = !s.started && s.problems.length === 0;
    // 503 only for what a load balancer must act on: the indexer not started, a check that is down or has stopped being refreshed, reth or Canton unreachable.
    // A degraded check is named in `problems` and the answer stays 200 (design 6.5); `ok` is the overall word and is true only when every check is.
    const serving = s.started && !s.down && latest !== undefined && canton;
    const all = serving && s.problems.length === 0;
    return {
      status: serving ? 200 : 503,
      body: {
        chainId: config.chainId, chainName: config.chainName, networkName: config.networkName, coin: pick(config.coin, FIELDS.coin), pins: { ...pick(config.pins, FIELDS.pins), keys: config.pins.keys.map((k) => pick(k, FIELDS.pinsKey)) }, ok: all, starting, problems: s.problems, evm: latest !== undefined, canton,
        final: head ? pick(head, FIELDS.final) : null,
        proving: proving ? pick(proving, FIELDS.proving) : null,
        latest: newest.map((b) => pick(b, FIELDS.latest)),
        signers: s.signers && pick(s.signers, FIELDS.signers), faucet: { on: faucet.on }, publicRpc: config.publicRpc.on,
        indexHead: head?.number ?? null, indexLag, deriveCursor: facts.deriveCursor, chainInstance: facts.chainInstance,
      },
    };
  }

  /**
   * Every row of health_checks through the health model (design 6.5): each check with its word, the time since it changed and since its writer last looked, the overall
   * word, and 503 only for `down`. A database that cannot be read is `down`, said by this instance itself.
   */
  async function healthAnswer(): Promise<Answer> {
    try {
      const h = await chain.health(apiHealth?.instance);
      return {
        status: httpStatusOf(h.status),
        body: { status: h.status, instance: apiHealth?.instance ?? null, starting: !h.started, problems: h.problems, checks: h.checks.map((c) => pick(c, FIELDS.healthCheck)) },
        headers: { "Cache-Control": "no-store" },
      };
    } catch (e) {
      console.error(`health: ${(e as Error).message}`);
      const detail = "the database cannot be read";
      return { status: 503, body: { status: "down", instance: apiHealth?.instance ?? null, starting: false, problems: [`database: ${detail}`], checks: [{ id: "database", role: "api", status: "down", detail }] }, headers: { "Cache-Control": "no-store" } };
    }
  }

  /** `light` is for the REST routes, whose pages leave out the transactions and the record's transactions bytes. */
  async function block(id: string, retried = false, light = false): Promise<Answer> {
    const key = HASH.test(id) ? id : /^\d+$/.test(id) && Number.isSafeInteger(Number(id)) ? Number(id) : null;
    if (key === null) return fail(400, "A block is named by its number or its 0x hash.");
    const final = await chain.block(key, !light);
    if (final) {
      const hashesMatch = keccak256(`0x${final.headerHex}`) === final.hash;
      const facts = final.proofHex && readProofFacts(final.proofHex);
      const transactions = light ? [] : await Promise.all((await chain.blockTxs(final.number)).map(async (t) => ({
        hash: t.hash, from: t.from, to: t.to, success: t.success, transfer: await transferOf(t.transferInput, t.to),
      })));
      return ok({
        status: "final", number: final.number, hash: final.hash, parentHash: final.parentHash, timestamp: final.timestamp,
        txCount: final.txCount, gasUsed: final.gasUsed, gasLimit: final.gasLimit, baseFee: final.baseFee, miner: final.miner, stateRoot: final.stateRoot,
        genesisReferenced: null,
        canton: {
          updateId: final.updateId, recordTime: final.recordTime, template: "Zk.Chain:BlockRecord", proofBytes: (final.proofHex?.length ?? 0) / 2, proof: proofOf(facts ? checkProofFacts(facts, keyFor(config.pins, final.number), final.hash) : null),
          hashesMatch, headerHex: final.headerHex, txsHex: final.txsHex, proofHex: final.proofHex ?? "",
        },
        transactions,
        legs: (await chain.blockLegs(final.number, BLOCK_LEGS)).map(legOf),
      });
    }
    // Not in the database: the genesis, a block that is still being proven, or one that Canton holds and the indexer has not written yet. Only reth knows it.
    const b = await reth.block(key, true);
    if (!b) return fail(404, NOT_FOUND);
    const genesis = b.number === 0;
    // At or below the newest indexed block, reth's block with this hash is not the final one of its number.
    // The indexer may have written it while reth was being asked: look in the database once more before saying no, so a page that was watching the block go final gets it.
    if (!genesis && b.number <= ((await chain.head())?.number ?? 0)) return retried ? fail(404, NOT_FOUND) : block(id, true, light);
    // At or below reth's finalized block, Canton holds the block: it is final, and the indexer is behind (or has stopped), which the status says. It is not being proven.
    const finalizedAt = genesis ? undefined : await finalizedNumber();
    const unindexed = finalizedAt !== undefined && b.number <= finalizedAt;
    if (unindexed && typeof key === "string" && (await reth.block(b.number))?.hash !== b.hash) return fail(404, NOT_FOUND);
    const receipts = b.transactions.length ? await reth.blockReceipts(b.number) : [];
    const transactions = await Promise.all(b.transactions.map(async (t, i) => ({
      hash: t.hash, from: t.from, to: t.to, success: receipts?.[i]?.success ?? null, transfer: await transferOf(t.input, t.to),
    })));
    return ok({
      status: genesis ? "genesis" : unindexed ? "unindexed" : "proving", number: b.number, hash: b.hash, parentHash: b.parentHash, timestamp: b.timestamp,
      txCount: b.transactions.length, gasUsed: b.gasUsed, gasLimit: b.gasLimit, baseFee: b.baseFeePerGas === null ? null : dec(b.baseFeePerGas), miner: b.miner, stateRoot: b.stateRoot,
      genesisReferenced: genesis ? await chain.genesisReferenced() : null,
      canton: null,
      transactions,
      legs: [],
    });
  }

  /** What the explorer says about a transaction that reth no longer holds, but the tracker accepted: it is being sent again, or it was replaced or dropped. */
  async function gone(hash: string, tr: ReturnType<Tracker["state"]> & object): Promise<Answer> {
    return ok({
      hash, status: tr.state === "pending" ? "waiting" : tr.state, state: tr.state, reason: tr.reason, lifecycle: await lifecycleOf(hash), block: null, from: tr.from, to: null, value: null, nonce: tr.nonce, type: null, gas: null,
      gasUsed: null, gasPrice: null, fee: null, success: null, input: null, logs: [], transfer: null, toToken: null, created: null, legs: [],
    });
  }

  /** The lifecycle rows of a transaction, in the fields of FIELDS.lifecycle; null for a transaction with none. */
  async function lifecycleOf(hash: string) {
    const l = await chain.lifecycleOf(hash);
    return l ? pick(l, FIELDS.lifecycle) : null;
  }

  /** The attempts that are not final yet. Every answer says so: nothing here is a fact of the chain until its block is final. */
  async function inFlight(): Promise<Answer> {
    const f = await chain.inFlight();
    return ok({ final: false, attempts: f.attempts.map((a) => pick(a, FIELDS.inFlightAttempt)), poolWaiting: f.poolWaiting && pick(f.poolWaiting, FIELDS.poolSample), transactions: f.transactions.map((t) => pick(t, FIELDS.inFlightTx)) });
  }

  async function transaction(hash: string): Promise<Answer> {
    if (!HASH.test(hash)) return fail(400, "A transaction is named by its 0x hash.");
    const final = await chain.tx(hash);
    const tr = tracker?.state(hash);
    if (final) {
      const transfer = await transferOf(final.input, final.to);
      const toToken = transfer?.symbol ?? (final.to ? (await tokenOf(final.to))?.symbol ?? null : null);
      return ok({
        hash: final.hash, status: "final", state: "final", reason: tr?.state === "final" ? tr.reason : null, lifecycle: await lifecycleOf(hash),
        block: pick(final.block, FIELDS.txBlock),
        from: final.from, to: final.to, value: final.value, nonce: final.nonce, type: final.type, gas: final.gas,
        gasUsed: final.gasUsed, gasPrice: final.gasPrice, fee: dec(BigInt(final.gasUsed) * BigInt(final.gasPrice)), success: final.success,
        input: final.input, logs: final.logs.map((l) => pick(l, FIELDS.log)), transfer, toToken, created: final.created,
        legs: (await chain.txLegs(hash, BLOCK_LEGS)).map(legOf),
      });
    }
    // Not in the database: waiting in reth's pool, or in a block that is still being proven (or not indexed yet), or only the tracker knows it.
    const t = await reth.transaction(hash);
    if (!t) return tr ? await gone(hash, tr) : fail(404, NOT_FOUND);
    const r = t.blockNumber === null ? null : await reth.receipt(hash);
    const transfer = await transferOf(t.input, t.to);
    const finalizedAt = t.blockNumber === null ? undefined : await finalizedNumber();
    const unindexed = t.blockNumber !== null && finalizedAt !== undefined && t.blockNumber <= finalizedAt;
    const status = t.blockNumber === null ? "waiting" : unindexed ? "unindexed" : "proving";
    const state: ApiTxState = status === "waiting" ? "pending" : status;
    return ok({
      hash: t.hash, status, state, reason: tr?.state === (unindexed ? "final" : state) ? tr.reason : null, lifecycle: await lifecycleOf(hash),
      block: t.blockNumber === null ? null : { number: t.blockNumber, hash: t.blockHash, updateId: null },
      from: t.from, to: t.to, value: dec(t.value), nonce: t.nonce, type: t.type, gas: t.gas,
      gasUsed: r?.gasUsed ?? null, gasPrice: r ? dec(r.effectiveGasPrice) : null, fee: r ? dec(BigInt(r.gasUsed) * r.effectiveGasPrice) : null, success: r?.success ?? null,
      input: t.input, logs: (r?.logs ?? []).map((l) => ({ address: l.address, topics: [...l.topics], data: l.data })), transfer,
      toToken: transfer?.symbol ?? (t.to ? (await tokenOf(t.to))?.symbol ?? null : null), created: r?.contractAddress ?? null, legs: [],
    });
  }

  async function address(a: string): Promise<Answer> {
    if (!ADDRESS.test(a)) return fail(400, "An address is 0x and 40 hex digits.");
    const [balance, nonce, code] = await Promise.all([reth.balance(a), reth.nonce(a), reth.code(a)]);
    const token = code === "0x" ? null : await reth.token(a), created = (await chain.createdBy(a)) ?? null;
    return ok({ address: a, kind: token ? "token" : code === "0x" ? "account" : "contract", balance: dec(balance), nonce, token: token && pick(token, FIELDS.token), createdBy: created && pick(created, FIELDS.createdBy) });
  }

  /** Works out what was typed from its shape. A block, transaction or update that nothing holds is not found. A Canton update id opens the update's own page, which links its block. */
  async function search(q: string): Promise<Answer> {
    const go = (path: string) => ok({ path });
    if (/^\d+$/.test(q) && Number.isSafeInteger(Number(q))) return (await reth.block(Number(q))) ? go(`/block/${q}`) : fail(404, NOT_FOUND);
    if (HASH.test(q)) return (await reth.transaction(q)) ? go(`/tx/${q}`) : (await reth.block(q)) ? go(`/block/${q}`) : fail(404, NOT_FOUND);
    if (ADDRESS.test(q)) return go(`/address/${q}`);
    const byUpdate = UPDATE.test(q) ? await chain.blockOfUpdate(q) : undefined;
    return byUpdate !== undefined ? go(`/canton/${q}`) : fail(404, NOT_FOUND);
  }

  /** Takes a request for coin: the address in the body, `{"address": "0x…"}`, and the human check's token as `captcha` when the faucet asks for one. The faucet answers every case itself. */
  async function giveCoin(body: string | undefined, ip: string | undefined): Promise<Answer> {
    if (!faucet.on) return faucet.request(undefined);
    let asked: unknown;
    try {
      asked = JSON.parse(body ?? "");
    } catch {
      return fail(400, 'Send a JSON body such as {"address": "0x…"}.');
    }
    const given = typeof asked === "object" && asked !== null ? (asked as { address?: unknown; captcha?: unknown }) : {};
    const result = await faucet.request(given.address, { ip, captcha: given.captcha });
    return result.status === 202 ? { ...result, body: pick(result.body as { ticket: string; position: number; to: string; amount: string }, FIELDS.faucetQueued) } : result;
  }

  async function ticket(id: string): Promise<Answer> {
    const t = faucet.ticket(id) ?? (await faucet.find(id));
    return t ? ok(pick(t, FIELDS.faucetTicket)) : fail(404, "No such ticket. A ticket is kept for a while after its coin is final, and is lost if the explorer is rebuilt.");
  }

  /** Takes a contract's source for verification; the answer is the GUID to ask about. */
  async function submitSource(body: string | undefined, ip: string | undefined): Promise<Answer> {
    const a = await verify!.submit(body, ip);
    return a.status === 202 ? { ...a, body: pick(a.body as { guid: string }, FIELDS.verifyQueued) } : a;
  }

  async function verification(guid: string): Promise<Answer> {
    const a = await verify!.status(guid);
    return a.status === 200 ? { ...a, body: pick(a.body as { guid: string; status: string; result: string }, FIELDS.verifyJob) } : a;
  }

  const etherscanDoor = etherscanRest && etherscan({ rest: etherscanRest, reth, chainId: config.chainId, ...(rpc ? { rpc } : {}), ...(verify ? { verify } : {}) });
  const restRoutes = rest && chainRoutes({ rest, reth, block: (id) => block(id, false, true), transaction });
  const accountRestRoutes = accounts && accountRoutes({ accounts, reth, search });
  const statsRestRoutes = stats && statsRoutes({ stats, now });
  /** What the routes that came first may be cached for: what they hold can still change, so a few seconds (the list of attempts, one second). */
  const RULES: Record<string, Rule | undefined> = { block: "composite", tx: "composite", address: "composite", "in-flight": "list", "openapi.json": "composite" };
  const legacy = router([
    ["/api/status", () => status()],
    ["/api/health", () => healthAnswer()],
    ["/api/block/{id}", (id) => block(id)],
    ["/api/tx/{hash}", (hash) => transaction(hash)],
    ["/api/address/{address}", (a) => address(a)],
    ["/api/in-flight", () => inFlight()],
    ["/api/search", (_, q) => search((q.get("q") ?? "").trim().toLowerCase())],
    ["/api/faucet/ticket/{ticket}", (t) => ticket(t)],
    ...(verify ? ([["/api/verify/{guid}", (guid: string) => verification(guid)]] as const) : []),
    ["/api/openapi.json", async () => ok(openapi)],
  ]);
  // Every route this API answers. `/api/faucet` has two methods and its own code; `/api/stream` is answered by the server in front, when there is one.
  const routes = [...new Set([...(restRoutes?.paths ?? []), ...(accountRestRoutes?.paths ?? []), ...(statsRestRoutes?.paths ?? []), ...legacy.paths, "/api/faucet", ...(verify ? ["/api/verify"] : []), "/healthz", ...(etherscanDoor ? ["/api", "/v2/api"] : []), ...(live ? ["/api/stream"] : []), ...(config.publicRpc.on ? ["/rpc"] : [])])];
  const openapi = buildOpenApi(routes, { title: `${config.chainName} explorer API`, limits: config.publicRpc.on ? { rpcPerMinute: config.publicRpc.ratePerMinute } : undefined });

  const api: Api = async (method, target, body, ip) => {
    let url: URL, parts: string[];
    try {
      if (!/^\/(?!\/)/.test(target)) throw new Error("not a path");
      url = new URL(target, "http://explorer");
      parts = url.pathname.split("/").slice(1).map((x) => decodeURIComponent(x).toLowerCase());
    } catch {
      return fail(400, "That is not a valid address.");
    }
    const [root, name] = parts;
    try {
      if (url.pathname === "/healthz") return method === "GET" ? await status() : fail(405, "Use GET.");
      // Etherscan's door, at `/api` and at `/v2/api`: GET and POST, and always HTTP 200, as its answers are.
      if (url.pathname === "/api" || url.pathname === "/v2/api") {
        if (!etherscanDoor) return fail(404, "The Etherscan-compatible API is off on this explorer.");
        if (method !== "GET" && method !== "POST") return fail(405, "Use GET or POST.");
        return await etherscanDoor(url.searchParams, method === "POST" ? body : undefined, ip);
      }
      if (root !== "api") return fail(404, "No such route.");
      const served = restRoutes?.(parts, url.searchParams) ?? accountRestRoutes?.(parts, url.searchParams) ?? statsRestRoutes?.(parts, url.searchParams);
      if (served) return method === "GET" ? await served() : fail(405, "Use GET.");
      if (name === "faucet" && parts.length === 2) {
        if (method === "POST") return await giveCoin(body, ip);
        if (method !== "GET") return fail(405, "Use GET or POST.");
        const info = await faucet.info();
        return ok({ ...pick(info, FIELDS.faucetInfo), captcha: info.captcha && pick(info.captcha, FIELDS.faucetCaptcha) });
      }
      if (verify && name === "verify" && parts.length === 2) return method === "POST" ? await submitSource(body, ip) : fail(405, "Use POST.");
      const route = legacy(parts, url.searchParams);
      if (!route) return fail(404, "No such route.");
      if (method !== "GET") return fail(405, "Use GET.");
      const answer = await route();
      const rule = RULES[name ?? ""];
      return rule ? cached(answer, rule) : answer;
    } catch (e) {
      if (e instanceof BadRequest) return fail(400, e.message);
      if (!(e instanceof RethError || e instanceof LedgerError || e instanceof ChainDbError)) throw e;
      console.error(`${method} ${url.pathname}: ${e.message}`);
      return fail(502, "The explorer cannot read the chain right now.");
    }
  };
  return Object.assign(api, { routes });
}

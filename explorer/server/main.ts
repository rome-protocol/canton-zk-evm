import { hostname } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApi } from "./api.ts";
import { createApiHealth } from "./api-health.ts";
import { createFinalBlocks } from "./chain-db.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { randomBytes } from "node:crypto";
import { createFaucet, loadFaucetKey } from "./faucet.ts";
import { clientHasher, loadClientKey } from "./faucet-store.ts";
import { createVerifyApi } from "./verifier/api.ts";
import { JobQueue } from "./verifier/jobs.ts";
import { createHttpServer } from "./http.ts";
import { ledgerFromConfig } from "./ledger-config.ts";
import { createPublicRpc } from "./public-rpc.ts";
import { createReth } from "./reth.ts";
import { createStreamHub, startStreamTimers } from "./rest/stream.ts";
import { createStreamSource } from "./rest/stream-source.ts";
import { onShutdown } from "./shutdown.ts";
import { openStorage } from "./storage.ts";
import { createTracker } from "./tracker.ts";

try {
  const config = loadConfig();
  // The database holds the chain the indexer wrote, which the block and transaction pages read, and the tracker's and the faucet's state; the old files are imported once.
  const storage = await openStorage(config);
  const chain = storage.chain;
  if (!chain) throw new ConfigError("the explorer reads blocks and transactions from its database, which the indexer fills: set EXPLORER_DATABASE_URL, or EXPLORER_DB_PASSWORD_FILE with its parts");
  const reth = createReth(config.rethUrl, config.rpcTimeoutMs);
  const ledger = ledgerFromConfig(config);
  const index = createFinalBlocks(chain);
  const tracker = createTracker({ reth, index, file: config.tracker.file, ...storage.tracker, max: config.tracker.max, maxBytes: config.tracker.maxBytes, maxPerSender: config.tracker.perSender, maxPendingMs: config.tracker.maxPendingMinutes * 60000, pollMs: config.pollMs });
  const faucet = createFaucet({ ...config.faucet, captcha: config.captcha, key: loadFaucetKey(config.faucet.keyFile), ...storage.faucet, chainId: config.chainId, reth, tracker });
  const rpc = config.publicRpc.on
    ? { handler: createPublicRpc({ rethUrl: config.rethUrl, timeoutMs: config.rpcTimeoutMs, chainId: config.chainId, ratePerMinute: config.publicRpc.ratePerMinute, tracker }), ipHeader: config.publicRpc.trustedIpHeader }
    : undefined;
  const dist = process.env.EXPLORER_DIST || resolve(fileURLToPath(new URL(".", import.meta.url)), "../dist");
  // Verification (design 6.3): the routes are always registered with a database, and answer 503 until a verifier role is running. A client's address is kept only as a keyed hash,
  // with the faucet's key when there is one and otherwise a key made for this run.
  const verify = storage.pool ? createVerifyApi({ pool: storage.pool, queue: new JobQueue(storage.pool), clientHash: clientHasher(config.faucet.clientKeyFile ? loadClientKey(config.faucet.clientKeyFile) : randomBytes(32)) }) : undefined;
  // Each API instance writes its own health rows (design 6.5). The name is EXPLORER_INSTANCE, or the host's name.
  const health = storage.healthPool ? createApiHealth({ pool: storage.healthPool, instance: (process.env.EXPLORER_INSTANCE || hostname()).replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 60), reth, ledger, faucet, tracker }) : undefined;
  const api = createApi({ config, ...(rpc ? { rpc: rpc.handler } : {}), ...(verify ? { verify } : {}), reth, ledger, chain, faucet, tracker, ...(health ? { health } : {}), ...(storage.chainRest ? { rest: storage.chainRest } : {}), ...(storage.accountRest ? { accounts: storage.accountRest } : {}), ...(storage.etherscanRest ? { etherscanRest: storage.etherscanRest } : {}), ...(storage.statsRest ? { stats: storage.statsRest } : {}), live: Boolean(storage.pool && config.database) });
  // Live updates (design 6.4): the indexer's NOTIFY, heard on a connection of its own, told to the clients of GET /api/stream.
  const hub = createStreamHub();
  const source = storage.pool && config.database
    ? createStreamSource({ pool: storage.pool, connection: config.database, hub, inflight: async () => (await api("GET", "/api/in-flight")).body })
    : null;
  const server = createHttpServer(api, dist, rpc, config.publicRpc.trustedIpHeader, source ? hub : undefined);
  await Promise.all([tracker.ready(), faucet.ready()]);
  server.listen(config.port, config.host, () => {
    console.log(`explorer for ${config.chainName} listening on http://${config.host}:${config.port}`);
    tracker.start();
    faucet.start();
    void source?.start();
    health?.start();
  });
  const stopTimers = startStreamTimers(hub);
  onShutdown({ stop: [() => health?.stop(), () => faucet.stop(), () => tracker.stop(), () => hub.close(), stopTimers], server, tracker, also: [faucet], release: [() => faucet.close(), () => tracker.close(), async () => void (await source?.stop()), () => storage.close()] });
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  console.error(`explorer: ${e.message}`);
  process.exit(1);
}

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApi } from "./api.ts";
import { createChainIndex } from "./chain-index.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { createFaucet, loadFaucetKey } from "./faucet.ts";
import { createHttpServer } from "./http.ts";
import { createLedger } from "./ledger.ts";
import { createPublicRpc } from "./public-rpc.ts";
import { createReth } from "./reth.ts";
import { onShutdown } from "./shutdown.ts";
import { openStorage } from "./storage.ts";
import { createTracker } from "./tracker.ts";

try {
  const config = loadConfig();
  // With a database set, the tracker and the faucet keep their state in it, and the old files are imported once. Without one, nothing changes.
  const storage = await openStorage(config);
  const reth = createReth(config.rethUrl, config.rpcTimeoutMs);
  const ledger = createLedger(config.ledgerUrl, config.rpcTimeoutMs, config.readerParty);
  const index = createChainIndex(reth, ledger, config.pins, config.pollMs);
  const tracker = createTracker({ reth, index, file: config.tracker.file, ...storage.tracker, max: config.tracker.max, maxBytes: config.tracker.maxBytes, maxPerSender: config.tracker.perSender, maxPendingMs: config.tracker.maxPendingMinutes * 60000, pollMs: config.pollMs });
  const faucet = createFaucet({ ...config.faucet, captcha: config.captcha, key: loadFaucetKey(config.faucet.keyFile), ...storage.faucet, chainId: config.chainId, reth, tracker });
  const rpc = config.publicRpc.on
    ? { handler: createPublicRpc({ rethUrl: config.rethUrl, timeoutMs: config.rpcTimeoutMs, chainId: config.chainId, ratePerMinute: config.publicRpc.ratePerMinute, tracker }), ipHeader: config.publicRpc.trustedIpHeader }
    : undefined;
  const dist = process.env.EXPLORER_DIST || resolve(fileURLToPath(new URL(".", import.meta.url)), "../dist");
  let stopIndex: () => void = () => {};
  const server = createHttpServer(createApi({ config, reth, ledger, index, faucet, tracker }), dist, rpc, config.publicRpc.trustedIpHeader);
  await Promise.all([tracker.ready(), faucet.ready()]);
  server.listen(config.port, config.host, () => {
    console.log(`explorer for ${config.chainName} listening on http://${config.host}:${config.port}`);
    stopIndex = index.start();
    tracker.start();
    faucet.start();
  });
  onShutdown({ stop: [() => faucet.stop(), () => tracker.stop(), () => stopIndex()], server, tracker, also: [faucet], release: [() => faucet.close(), () => tracker.close(), () => storage.close()] });
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  console.error(`explorer: ${e.message}`);
  process.exit(1);
}

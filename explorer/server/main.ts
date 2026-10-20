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
import { createTracker } from "./tracker.ts";

try {
  const config = loadConfig();
  const reth = createReth(config.rethUrl, config.rpcTimeoutMs);
  const ledger = createLedger(config.ledgerUrl, config.rpcTimeoutMs, config.readerParty);
  const faucet = createFaucet({ ...config.faucet, key: loadFaucetKey(config.faucet.keyFile), chainId: config.chainId, reth });
  const index = createChainIndex(reth, ledger, config.pins, config.pollMs);
  const tracker = createTracker({ reth, index, file: config.tracker.file, max: config.tracker.max, maxBytes: config.tracker.maxBytes, maxPerSender: config.tracker.perSender, pollMs: config.pollMs });
  const rpc = config.publicRpc.on
    ? { handler: createPublicRpc({ rethUrl: config.rethUrl, timeoutMs: config.rpcTimeoutMs, chainId: config.chainId, ratePerMinute: config.publicRpc.ratePerMinute, tracker }), ipHeader: config.publicRpc.trustedIpHeader }
    : undefined;
  const dist = process.env.EXPLORER_DIST || resolve(fileURLToPath(new URL(".", import.meta.url)), "../dist");
  let stopIndex: () => void = () => {};
  const server = createHttpServer(createApi({ config, reth, ledger, index, faucet, tracker }), dist, rpc);
  server.listen(config.port, config.host, () => {
    console.log(`explorer for ${config.chainName} listening on http://${config.host}:${config.port}`);
    stopIndex = index.start();
    tracker.start();
  });
  onShutdown({ stop: [() => tracker.stop(), () => stopIndex()], server, tracker });
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  console.error(`explorer: ${e.message}`);
  process.exit(1);
}

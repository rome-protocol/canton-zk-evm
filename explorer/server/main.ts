import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApi } from "./api.ts";
import { createChainIndex } from "./chain-index.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { createFaucet, loadFaucetKey } from "./faucet.ts";
import { createHttpServer } from "./http.ts";
import { createLedger } from "./ledger.ts";
import { createReth } from "./reth.ts";

try {
  const config = loadConfig();
  const reth = createReth(config.rethUrl, config.rpcTimeoutMs);
  const ledger = createLedger(config.ledgerUrl, config.rpcTimeoutMs, config.readerParty);
  const faucet = createFaucet({ ...config.faucet, key: loadFaucetKey(config.faucet.keyFile), chainId: config.chainId, reth });
  const index = createChainIndex(reth, ledger, config.pins, config.pollMs);
  const dist = process.env.EXPLORER_DIST || resolve(fileURLToPath(new URL(".", import.meta.url)), "../dist");
  createHttpServer(createApi({ config, reth, ledger, index, faucet }), dist).listen(config.port, config.host, () => {
    console.log(`explorer for ${config.chainName} listening on http://${config.host}:${config.port}`);
    index.start();
  });
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  console.error(`explorer: ${e.message}`);
  process.exit(1);
}

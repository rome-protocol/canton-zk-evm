// RedStone's pull model from Node, for ethers 6: fetch signed prices from RedStone's gateways, turn them into the payload that goes at the end of the call data.
// The RedStone packages are CommonJS and bring their own ethers 5; they are used here only to fetch and to build the payload.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const axios = require("axios");
const { requestDataPackages, getSignersForDataServiceId } = require("@redstone-finance/sdk");
const { DataPackagesWrapper } = require("@redstone-finance/evm-connector");

// RedStone's gateways see this on every request.
axios.defaults.headers.common["User-Agent"] = "Rome Protocol rome@romeprotocol.com";

export const DATA_SERVICE = "redstone-primary-prod"; // what PrimaryProdDataServiceConsumerBase checks
export const UNIQUE_SIGNERS = 3; // what it asks for: 3 of its 5 public signers

/**
 * Signed prices for the given symbols, as the hex string to append to the call data (no 0x).
 * RedStone is switching its public gateways off (they refuse requests in windows that grow every day, and stop on 2026-10-29), so a refused request is
 * tried again every 45 s for REDSTONE_WAIT_MIN minutes (default 30) before it gives up.
 */
export async function pricePayload(symbols = ["ETH", "BTC"]) {
  const until = Date.now() + Number(process.env.REDSTONE_WAIT_MIN ?? 30) * 60_000;
  for (let attempt = 1; ; attempt++) {
    try {
      const packages = await requestDataPackages({
        dataServiceId: DATA_SERVICE,
        dataPackagesIds: symbols,
        uniqueSignersCount: UNIQUE_SIGNERS,
        authorizedSigners: getSignersForDataServiceId(DATA_SERVICE),
      });
      const payload = await new DataPackagesWrapper(packages).getBytesDataForAppending();
      const signers = new Set(Object.values(packages).flat().map((p) => p.recoverSignerAddress()));
      return { payload, signers: signers.size, bytes: payload.length / 2, attempts: attempt };
    } catch (e) {
      const why = (e.errors ?? [e]).map((x) => x.response?.data?.error ?? x.code ?? x.message).join(", ").slice(0, 160);
      if (Date.now() > until) throw new Error(`no signed prices after ${attempt} tries: ${why}`);
      console.log(new Date().toISOString().slice(11, 19), `RedStone gateways refused (${why}); try ${attempt}, again in 45 s`);
      await new Promise((r) => setTimeout(r, 45_000));
    }
  }
}

/** A contract method's call data with the signed prices appended. Send it as a transaction or as an eth_call. */
export async function dataWithPrices(contract, method, args = [], symbols = ["ETH", "BTC"]) {
  const { payload, signers, bytes } = await pricePayload(symbols);
  return { data: contract.interface.encodeFunctionData(method, args) + payload, signers, bytes };
}

// The local test page (a minimal page that asks the wallet for the Bridge's signature) and a stand-in JSON-RPC endpoint for the chain, so a wallet can add the chain without a live site.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KEY_TYPED_DATA, RUN } from "./lib.ts";

const CHAIN_ID = KEY_TYPED_DATA.domain.chainId;
const PAGE = `<!doctype html><meta charset=utf-8><title>wallet signature test</title><body><pre id=o>ready</pre><button id=go style="padding:20px">go</button><script>
let armed = null; document.getElementById("go").onclick = () => { const f = armed; armed = null; if (f) f(); };
window.arm = (name, args) => { window.result = new Promise((res, rej) => { armed = () => window.api[name](...args).then(res, rej); }); window.result.catch(() => {}); };

const found = [];
addEventListener('eip6963:announceProvider', (e) => found.push(e.detail));
dispatchEvent(new Event('eip6963:requestProvider'));
const prov = (rdns) => { if (rdns === 'window') return window.ethereum; if (rdns === 'phantom') return window.phantom && window.phantom.ethereum; const m = rdns ? found.find((f) => f.info.rdns.includes(rdns)) : found[0]; return m ? m.provider : window.ethereum; };
const wrap = (f) => async (...a) => { try { return await f(...a); } catch (e) { throw new Error('wallet said: ' + (e && e.code !== undefined ? e.code + ' ' : '') + (e && e.message ? e.message : JSON.stringify(e))); } };
const raw = {
  providers: () => found.map((f) => f.info.name + ' (' + f.info.rdns + ')').concat(window.ethereum ? ['window.ethereum'] : []),
  connect: async (rdns) => prov(rdns).request({ method: 'eth_requestAccounts' }),
  addChain: async (rdns, params) => { const p = prov(rdns); try { await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: params.chainId }] }); } catch (e) { await p.request({ method: 'wallet_addEthereumChain', params: [params] }); try { await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: params.chainId }] }); } catch (e2) {} } return p.request({ method: 'eth_chainId' }); },
  sign: async (rdns, address, typed) => prov(rdns).request({ method: 'eth_signTypedData_v4', params: [address, typed] }),
  chainId: async (rdns) => prov(rdns).request({ method: 'eth_chainId' }),
};
window.api = Object.fromEntries(Object.entries(raw).map(([k, f]) => [k, k === 'providers' ? f : wrap(f)]));
</script>`;

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, GET, OPTIONS" };

/** The stand-in chain's JSON-RPC. */
function rpc(req: IncomingMessage, res: ServerResponse): void {
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return void res.end(); }
  let t = ""; req.on("data", (c) => (t += c)); req.on("end", () => {
    const one = (q: { id: unknown; method: string }) => ({ jsonrpc: "2.0", id: q.id, result: answer(q.method) });
    const q = JSON.parse(t || "{}");
    res.writeHead(200, { "content-type": "application/json", ...CORS });
    res.end(JSON.stringify(Array.isArray(q) ? q.map(one) : one(q)));
  });
}

/** Starts the test page (http) and the stand-in chain's RPC (https with a certificate made for the run, because some wallets add a chain only by an https address; the browser is started to accept it). */
export function startServer(): Promise<{ servers: Server[]; origin: string; spki: string; chain: { chainId: string; chainName: string; nativeCurrency: { name: string; symbol: string; decimals: number }; rpcUrls: string[] } }> {
  mkdirSync(join(RUN, "tls"), { recursive: true });
  const key = join(RUN, "tls", "key.pem"), cert = join(RUN, "tls", "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  // the browser is told to ignore certificate errors for this certificate only (its public key's hash), not for any site
  const spki = createHash("sha256").update(new X509Certificate(readFileSync(cert)).publicKey.export({ type: "spki", format: "der" })).digest("base64");
  return new Promise((done) => {
    const page = createServer((req, res) => {
      if (req.url === "/rpc") return rpc(req, res);
      res.writeHead(200, { "content-type": "text/html", ...CORS });
      res.end(PAGE);
    });
    const secure = createSecureServer({ key: readFileSync(key), cert: readFileSync(cert) }, rpc);
    secure.listen(0, "127.0.0.1", () => page.listen(0, "127.0.0.1", () => {
      const p = (page.address() as { port: number }).port, q = (secure.address() as { port: number }).port;
      done({ servers: [page, secure], spki, origin: `http://localhost:${p}`, chain: { chainId: "0x" + CHAIN_ID.toString(16), chainName: "Ostia (test)", nativeCurrency: { name: "tROME", symbol: "tROME", decimals: 18 }, rpcUrls: [`https://127.0.0.1:${q}/rpc`] } });
    }));
  });
}

const block = { number: "0x1", hash: "0x" + "11".repeat(32), parentHash: "0x" + "00".repeat(32), timestamp: "0x6a000000", gasLimit: "0x1c9c380", gasUsed: "0x0", baseFeePerGas: "0x1", miner: "0x" + "00".repeat(20), transactions: [], difficulty: "0x0", nonce: "0x0000000000000000", sha3Uncles: "0x" + "00".repeat(32), logsBloom: "0x" + "00".repeat(256), transactionsRoot: "0x" + "00".repeat(32), stateRoot: "0x" + "00".repeat(32), receiptsRoot: "0x" + "00".repeat(32), extraData: "0x", size: "0x1", uncles: [] };
function answer(method: string): unknown {
  switch (method) {
    case "eth_chainId": return "0x" + CHAIN_ID.toString(16);
    case "net_version": return String(CHAIN_ID);
    case "eth_blockNumber": return "0x1";
    case "eth_getBalance": return "0x0";
    case "eth_gasPrice": return "0x1";
    case "eth_getTransactionCount": return "0x0";
    case "eth_getCode": return "0x";
    case "eth_getBlockByNumber": case "eth_getBlockByHash": return block;
    case "eth_feeHistory": return { oldestBlock: "0x1", baseFeePerGas: ["0x1", "0x1"], gasUsedRatio: [0], reward: [["0x1"]] };
    case "eth_maxPriorityFeePerGas": return "0x1";
    case "web3_clientVersion": return "stand-in";
    default: return "0x";
  }
}

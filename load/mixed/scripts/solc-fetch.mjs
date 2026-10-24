// Fetches the solc compilers that forge would otherwise download itself (from the Solidity binaries server, under Foundry's own User-Agent), sending the project contact instead.
//   node scripts/solc-fetch.mjs 0.5.16 0.6.6 0.8.17
// Each binary is checked against the sha256 of the server's own list and placed where forge looks for it ($HOME/.svm/<version>/solc-<version>); `forge build --offline` then needs no download.
// The server's linux-amd64 builds only: elsewhere the step stops and says so.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";

const UA = "Rome Protocol rome@romeprotocol.com";
const BASE = "https://binaries.soliditylang.org/linux-amd64";
if (process.platform !== "linux" || process.arch !== "x64") { console.error(`solc-fetch: only linux x64 is supported here (this is ${process.platform} ${process.arch}); the binaries server has no build for it that this kit checks.`); process.exit(1); }
const versions = process.argv.slice(2);
if (!versions.length) { console.error("usage: solc-fetch.mjs <version>..."); process.exit(2); }

const get = async (url) => { const r = await fetch(url, { headers: { "user-agent": UA } }); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return Buffer.from(await r.arrayBuffer()); };
const todo = versions.filter((v) => !existsSync(`${homedir()}/.svm/${v}/solc-${v}`));
if (todo.length) {
  const list = JSON.parse((await get(`${BASE}/list.json`)).toString());
  for (const v of todo) {
    const b = list.builds.find((x) => x.version === v && !x.prerelease);
    if (!b) throw new Error(`solc ${v} is not in the server's list`);
    const bin = await get(`${BASE}/${b.path}`);
    const sha = "0x" + createHash("sha256").update(bin).digest("hex");
    if (sha !== b.sha256) throw new Error(`solc ${v}: sha256 ${sha} differs from the list's ${b.sha256}`);
    const dir = `${homedir()}/.svm/${v}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/solc-${v}.part`, bin, { mode: 0o755 });
    renameSync(`${dir}/solc-${v}.part`, `${dir}/solc-${v}`);
    console.log(`solc ${v}: ${bin.length} bytes, sha256 ${sha.slice(0, 14)}… matches the list`);
  }
}
console.log(`solc ready: ${versions.join(", ")}`);

// Verifies a contract whose standard JSON input is too big for the explorer's front proxy when forge sends it (the proxy takes 300 KB a request, and forge's
// url-encoded body for Merces is 450 KB). The explorer's own JSON route, POST /api/verify, carries the same input as a JSON string, about 265 KB.
// Takes the JSON that `forge verify-contract --show-standard-json-input` prints.
//   node scripts/verify-large.mjs <address> <path:Name> <std.json> <compiler> <runs> <evm> <ctor-args-hex|->
import { readFileSync } from "node:fs";
import { cfg } from "./lib.mjs";

const [address, target, file, compiler, runs, evm, ctor] = process.argv.slice(2);
if (!address || !target || !file || !compiler || !runs || !evm) { console.error("usage: verify-large.mjs <address> <path:Name> <std.json> <compiler> <runs> <evm> <ctor-args|->"); process.exit(2); }
const UA = "Rome Protocol rome@romeprotocol.com";
const body = JSON.stringify({
  address, codeFormat: "solidity-standard-json-input", sourceCode: JSON.stringify(JSON.parse(readFileSync(file, "utf8"))), contractName: target, compilerVersion: compiler,
  optimizationUsed: "1", runs, evmVersion: evm, constructorArguments: !ctor || ctor === "-" ? undefined : ctor.replace(/^0x/, ""),
});
console.log(`body ${body.length} bytes`);
const post = await fetch(`${cfg.explorerApi}/verify`, { method: "POST", headers: { "content-type": "application/json", "user-agent": UA }, body });
const text = await post.text();
let j; try { j = JSON.parse(text); } catch { console.error(`HTTP ${post.status} ${text.slice(0, 200)}`); process.exit(1); }
if (!j.guid) { console.error("refused:", post.status, JSON.stringify(j).slice(0, 300)); process.exit(1); }
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const r = await (await fetch(`${cfg.explorerApi}/verify/${j.guid}`, { headers: { "user-agent": UA } })).json();
  console.log("status:", r.status, r.result ?? "");
  if (/pass|already/i.test(`${r.status} ${r.result}`)) process.exit(0);
  if (/fail/i.test(`${r.status} ${r.result}`)) process.exit(1);
}
process.exit(1);

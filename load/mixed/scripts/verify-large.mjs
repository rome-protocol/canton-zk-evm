// Verifies a contract whose standard JSON input is too big for the explorer's front proxy when forge sends it (forge url-encodes spaces as %20 and the body passes
// about 320 KB; with + for spaces it is a third smaller). Takes the JSON that `forge verify-contract --show-standard-json-input` prints.
//   node scripts/verify-large.mjs <address> <path:Name> <std.json> <compiler> <runs> <ctor-args-hex|->
import { readFileSync } from "node:fs";
import { cfg } from "./lib.mjs";

const [address, target, file, compiler, runs, ctor] = process.argv.slice(2);
if (!address || !target || !file || !compiler || !runs) { console.error("usage: verify-large.mjs <address> <path:Name> <std.json> <compiler> <runs> <ctor-args|->"); process.exit(2); }
const UA = "Rome Protocol rome@romeprotocol.com";
const json = JSON.stringify(JSON.parse(readFileSync(file, "utf8")));
const body = new URLSearchParams({
  apikey: "any", module: "contract", action: "verifysourcecode", chainid: String(cfg.chainId), codeformat: "solidity-standard-json-input",
  contractaddress: address, sourceCode: json, contractname: target, compilerversion: compiler, optimizationUsed: "1", runs,
  constructorArguements: !ctor || ctor === "-" ? "" : ctor.replace(/^0x/, ""),
}).toString();
console.log(`body ${body.length} bytes`);
const post = await fetch(cfg.explorerApi, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA }, body });
const text = await post.text();
let j; try { j = JSON.parse(text); } catch { console.error(`HTTP ${post.status} ${text.slice(0, 200)}`); process.exit(1); }
if (j.status !== "1") { console.error("refused:", JSON.stringify(j).slice(0, 300)); process.exit(1); }
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const r = await (await fetch(`${cfg.explorerApi}?module=contract&action=checkverifystatus&guid=${j.result}&apikey=any`, { headers: { "user-agent": UA } })).json();
  console.log("status:", r.result);
  if (r.status === "1") process.exit(0);
  if (!/pending|queue/i.test(r.result ?? "")) process.exit(1);
}
process.exit(1);

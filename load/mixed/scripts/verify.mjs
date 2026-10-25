// Two helpers for `run.sh verify`.
//   verify.mjs list    writes verify-list.tsv into the run folder: one line per contract that needs a forge call (one per distinct contract, since a copy with the same
//                      code is matched by the explorer; contracts the explorer already verified are left out): name, address, source:Name, compiler version, evm version, optimizer runs,
//                      project folder (- for this kit), constructor arguments.
//   verify.mjs check   asks the explorer's /api/contracts/<address> about every deployed contract, prints verified or not, exits 1 if one is not verified.
import { readFileSync, writeFileSync } from "node:fs";
import { cfg, RUN, state, artifact } from "./lib.mjs";

const UA = "Rome Protocol rome@romeprotocol.com";
const meta = (c) => {
  const [file, name] = c.contract.split(":");
  const m = artifact(file, name).metadata;
  const target = Object.entries(m.settings.compilationTarget)[0];
  return { path: target[0], name: target[1], compiler: m.compiler.version, evm: m.settings.evmVersion, runs: m.settings.optimizer.runs };
};
const mode = process.argv[2];
if (mode === "list") {
  const seen = new Set();
  const rows = [];
  const isVerified = async (a) => (await (await fetch(`${cfg.explorer}/api/contracts/${a}`, { headers: { "user-agent": UA } })).json()).verified === true;
  for (const [n, c] of Object.entries(state.contracts)) {
    const m = meta(c);
    const key = `${m.path}:${m.name}`;
    if (seen.has(key) && c.ctorArgs === "") continue; // a copy made by a factory: the first of its kind is enough
    seen.add(key);
    if (await isVerified(c.address)) continue; // submitted before: the explorer takes 30 an hour
    // root: a contract built from the fetched Merces project is verified from inside it. Linked libraries are not sent: the explorer reads their addresses from the chain, and naming them
    // would change the metadata hash (the contract was built without them), which makes the match partial.
    rows.push([n, c.address, key, m.compiler, m.evm, m.runs, c.root ?? "-", c.ctorArgs].join("\t"));
  }
  writeFileSync(`${RUN}/verify-list.tsv`, rows.length ? rows.join("\n") + "\n" : "");
  console.log(`${rows.length} contracts to submit (of ${Object.keys(state.contracts).length})`);
} else if (mode === "check") {
  let bad = 0;
  for (const [n, c] of Object.entries(state.contracts)) {
    const r = await fetch(`${cfg.explorer}/api/contracts/${c.address}`, { headers: { "user-agent": UA } });
    const j = await r.json();
    const ok = j.verified === true;
    if (!ok) bad++;
    console.log(`${ok ? "verified    " : "NOT VERIFIED"}  ${j.matchType ?? "-"}  ${c.address}  ${j.name ?? "-"}  (${n})`);
  }
  process.exit(bad ? 1 : 0);
} else { console.error("usage: verify.mjs list|check"); process.exit(2); }

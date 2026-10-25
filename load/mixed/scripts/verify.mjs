// Two helpers for `run.sh verify`.
//   verify.mjs list    writes verify-list.tsv into the run folder: one line per contract that needs a forge call (one per distinct contract, since a copy with the same
//                      code is matched by the explorer; contracts the explorer already verified are left out): name, address, source:Name, compiler version, evm version, optimizer runs,
//                      project folder (- for this kit), constructor arguments.
//                      With RESUBMIT_PARTIAL=1 a contract the explorer holds as partial is sent again too (resubmitting helps only a contract whose code carries the metadata hash, for example a partial caused by library addresses; code deployed without the hash stays partial; the explorer takes 30 an hour).
//   verify.mjs check   asks the explorer's /api/contracts/<address> about every deployed contract and prints its match type, then one summary line with the counts of full, similar,
//                      partial and unverified. Exits 1 if one is unverified or only partial (every contract the kit builds is expected to be full, or similar for a copy made by a factory);
//                      ALLOW_PARTIAL=1 turns a partial one into a warning, for a run folder from the build without the metadata hash.
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
  const resubmit = process.env.RESUBMIT_PARTIAL === "1";
  const isDone = async (a) => {
    const j = await (await fetch(`${cfg.explorer}/api/contracts/${a}`, { headers: { "user-agent": UA } })).json();
    return j.verified === true && !(resubmit && j.matchType === "partial");
  };
  for (const [n, c] of Object.entries(state.contracts)) {
    const m = meta(c);
    const key = `${m.path}:${m.name}`;
    if (seen.has(key) && c.ctorArgs === "") continue; // a copy made by a factory: the first of its kind is enough
    seen.add(key);
    if (await isDone(c.address)) continue; // submitted before: the explorer takes 30 an hour
    // root: a contract built from the fetched Merces project is verified from inside it. Linked libraries are not sent: the explorer reads their addresses from the chain, and naming them
    // would change the metadata hash (the contract was built without them), which makes the match partial.
    rows.push([n, c.address, key, m.compiler, m.evm, m.runs, c.root ?? "-", c.ctorArgs].join("\t"));
  }
  writeFileSync(`${RUN}/verify-list.tsv`, rows.length ? rows.join("\n") + "\n" : "");
  console.log(`${rows.length} contracts to submit (of ${Object.keys(state.contracts).length})`);
} else if (mode === "check") {
  const count = { full: 0, similar: 0, partial: 0, unverified: 0 };
  for (const [n, c] of Object.entries(state.contracts)) {
    const r = await fetch(`${cfg.explorer}/api/contracts/${c.address}`, { headers: { "user-agent": UA } });
    const j = await r.json();
    const kind = j.verified !== true ? "unverified" : j.matchType === "full" || j.matchType === "similar" ? j.matchType : "partial";
    count[kind]++;
    const mark = { full: "verified    ", similar: "verified    ", partial: "PARTIAL     ", unverified: "NOT VERIFIED" }[kind];
    console.log(`${mark}  ${j.matchType ?? "-"}  ${c.address}  ${j.name ?? "-"}  (${n})`);
  }
  console.log(`SUMMARY full ${count.full}, similar ${count.similar}, partial ${count.partial}, unverified ${count.unverified} (of ${Object.keys(state.contracts).length})`);
  const bad = count.unverified + (process.env.ALLOW_PARTIAL === "1" ? 0 : count.partial);
  process.exit(bad ? 1 : 0);
} else { console.error("usage: verify.mjs list|check"); process.exit(2); }

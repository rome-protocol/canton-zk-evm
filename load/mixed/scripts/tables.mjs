// Prints the run record as markdown tables, from the run folder's addresses.json and smoke.json: the contracts, the contracts that were deployed and are not used, the deploy steps, the smoke actions.
//   node scripts/tables.mjs
import { readFileSync, existsSync } from "node:fs";
import { cfg, state, RUN } from "./lib.mjs";

const A = (a) => `[\`${a}\`](${cfg.explorer}/address/${a})`;
const T = (h) => `[\`${h.slice(0, 10)}…\`](${cfg.explorer}/tx/${h})`;
const FT = (h) => `[\`${h}\`](${cfg.explorer}/tx/${h})`;
const contracts = (o) => ["| Contract | Address | Created in block | Creation transaction |", "|---|---|---:|---|", ...Object.entries(o).map(([n, c]) => `| ${n} | ${A(c.address)} | ${c.block ?? ""} | ${c.tx ? T(c.tx) : "created by a contract"} |`)];
const out = [];
out.push("### Contracts in use", "", ...contracts(state.contracts));
if (state.unused) out.push("", "### Deployed and not used", "", "Left on the chain by earlier runs of the deploy (see the notes above); nothing in the mix calls them.", "", ...contracts(state.unused.contracts));
out.push("", "### Deploy steps", "", "| Step | Transaction |", "|---|---|", ...Object.entries(state.steps).filter(([, s]) => s.tx).map(([n, s]) => `| ${n} | ${FT(s.tx)} |`));
const sp = `${RUN}/smoke.json`;
if (existsSync(sp)) out.push("", "### Smoke actions", "", "| Action | Transaction |", "|---|---|", ...Object.entries(JSON.parse(readFileSync(sp, "utf8"))).map(([n, h]) => `| ${n} | ${/^0x[0-9a-f]{64}$/.test(h) ? FT(h) : h} |`));
console.log(out.join("\n"));

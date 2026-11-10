// Prints the reference (never the key, the seed or the signature): the account's address, the hash of the signature, and the Canton account the Bridge page derives from it; and keeps the account's name for the report.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { reference, RUN, sha256hex } from "./lib.ts";
const r = await reference();
const shown = { address: r.address, signatureSha256: sha256hex(Buffer.from(r.signature.slice(2), "hex")), party: r.party, fingerprint: r.fingerprint };
writeFileSync(join(RUN, "reference.json"), JSON.stringify(shown, null, 2) + "\n");
console.log(JSON.stringify(shown));

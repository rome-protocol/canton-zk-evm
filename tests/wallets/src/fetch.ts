// Downloads each wallet's package from its official source, records its SHA-256, and unpacks it into run/ext/<id>/ (an unpacked Chrome extension).
// Usage: node src/fetch.ts [--update] [id ...]
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HERE } from "./paths.ts";

const RUN = join(HERE, "run");
const CONTACT = "canton-zk-evm wallet tests (rome@romeprotocol.com)";

interface Source { kind: "github" | "chrome-web-store"; repo?: string; tag?: string; asset?: string; checksums?: string; extensionId?: string }
interface Entry { id: string; name: string; source: Source; sha256: string | null }

const get = async (url: string): Promise<Buffer> => {
  const r = await fetch(url, { headers: { "user-agent": CONTACT }, redirect: "follow" });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
};
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const update = process.argv.includes("--update");
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const manifestPath = join(HERE, "wallets.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { note: string; wallets: Entry[] };
mkdirSync(join(RUN, "dl"), { recursive: true });
const packagesFile = join(RUN, "packages.json");
const packages: Record<string, unknown> = existsSync(packagesFile) ? JSON.parse(readFileSync(packagesFile, "utf8")) : {};

for (const w of manifest.wallets) {
  if (only.length && !only.includes(w.id)) continue;
  let url: string, file: string;
  if (w.source.kind === "github") {
    url = `https://github.com/${w.source.repo}/releases/download/${w.source.tag}/${w.source.asset}`;
    file = join(RUN, "dl", w.source.asset!);
  } else {
    url = `https://clients2.google.com/service/update2/crx?response=redirect&os=linux&arch=x64&os_arch=x86_64&nacl_arch=x86-64&prod=chromecrx&prodchannel=&prodversion=131.0.0.0&lang=en-US&acceptformat=crx2,crx3&x=id%3D${w.source.extensionId}%26installsource%3Dondemand%26uc`;
    file = join(RUN, "dl", `${w.id}.crx`);
  }
  const bytes = await get(url);
  const sum = sha256(bytes);
  if (w.source.checksums) {
    const sums = (await get(`https://github.com/${w.source.repo}/releases/download/${w.source.tag}/${w.source.checksums}`)).toString();
    const line = sums.split("\n").find((l) => l.trim().endsWith(w.source.asset!));
    if (!line || line.trim().split(/\s+/)[0] !== sum) throw new Error(`${w.id}: the package's SHA-256 is not the one in the release's ${w.source.checksums}`);
  }
  if (w.sha256 && w.sha256 !== sum && !update) throw new Error(`${w.id}: the package is ${sum}, not the pinned ${w.sha256}. Run with --update to test this one and record it.`);
  writeFileSync(file, bytes);
  const dir = join(RUN, "ext", w.id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // python's zipfile reads a CRX too (a zip with a header in front of it)
  execFileSync("python3", ["-I", "-m", "zipfile", "-e", file, dir], { stdio: "inherit" });
  const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { version: string; version_name?: string; name: string };
  packages[w.id] = { id: w.id, name: w.name, version: m.version, versionName: m.version_name ?? null, source: w.source.kind === "github" ? url : `https://chromewebstore.google.com/detail/${w.source.extensionId}`, packageUrl: url, sha256: sum, bytes: bytes.length };
  if (update || !w.sha256) w.sha256 = sum;
  console.log(`${w.id} ${m.version} sha256 ${sum}`);
}
writeFileSync(packagesFile, JSON.stringify(packages, null, 2) + "\n");
if (update || manifest.wallets.some((w) => w.sha256)) writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

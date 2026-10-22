/** For the verifier's tests: a compiler release list and its binaries, served on this machine's loopback. */
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { keccak256 } from "viem";

export const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

export interface Entry { longVersion: string; body: Buffer; sha256?: string; keccak256?: string; path?: string }

/** A release list and its binaries, served on this machine's loopback, counting the requests and the user agents it sees. */
export class FakeMirror {
  server!: Server;
  hits: { url: string; ua: string | undefined }[] = [];
  entries: Entry[] = [];
  listStatus = 200;
  url = "";
  async start(): Promise<void> {
    this.server = createServer((req: IncomingMessage, res) => {
      this.hits.push({ url: req.url ?? "", ua: req.headers["user-agent"] });
      if (req.url === "/bin/list.json") {
        if (this.listStatus !== 200) { res.statusCode = this.listStatus; res.end("no"); return; }
        const builds = this.entries.map((e) => ({
          path: e.path ?? `solc-${e.longVersion}`, version: e.longVersion.split("+")[0] as string, longVersion: e.longVersion, build: e.longVersion.split("+")[1],
          sha256: `0x${e.sha256 ?? sha(e.body)}`, keccak256: e.keccak256 ?? keccak256(e.body),
        }));
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ builds, releases: Object.fromEntries(builds.filter((b) => !b.version.includes("-")).map((b) => [b.version, b.path])), latestRelease: "0.8.28" }));
        return;
      }
      const e = this.entries.find((x) => `/bin/${x.path ?? `solc-${x.longVersion}`}` === req.url);
      if (!e) { res.statusCode = 404; res.end(); return; }
      res.end(e.body);
    });
    await new Promise<void>((ok) => this.server.listen(0, "127.0.0.1", ok));
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}/bin/list.json`;
  }
  stop(): Promise<void> { return new Promise((ok) => this.server.close(() => ok())); }
  downloads(): number { return this.hits.filter((h) => h.url !== "/bin/list.json").length; }
}

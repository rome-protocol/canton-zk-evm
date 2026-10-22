export class VerifierSettingsError extends Error {}

type Env = Record<string, string | undefined>;

export interface VerifierSettings {
  listUrl: string; userAgent: string; cacheDir: string; cacheMaxBytes: number; sandboxImage: string; dockerBin: string;
  compileTimeoutMs: number; compileMemoryBytes: number; compileMaxOutputBytes: number; compileMaxInputBytes: number;
}

function whole(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new VerifierSettingsError(`${name} must be a whole number from ${min} to ${max}, not "${raw}"`);
  return Number(raw);
}

function required(env: Env, name: string, what: string): string {
  const v = (env[name] ?? "").trim();
  if (!v) throw new VerifierSettingsError(`${name} must be set: ${what}`);
  return v;
}

/**
 * The verifier's settings. Four have no default, so that nothing points anywhere unless the deployment says so: `SOLC_LIST_URL` (the compiler
 * release list), `OUTSIDE_USER_AGENT` (what the compiler download says it is: the project's contact), `SOLC_CACHE_DIR` (where compilers are kept; a folder
 * the Docker daemon sees at the same path) and `SANDBOX_IMAGE` (the image a compile runs in, by digest; it must be on the machine already).
 * The limits default to the design's: 60 s, 2 GB, one CPU (fixed), and a cap on the output and on the input.
 */
export function loadVerifierSettings(env: Env = process.env): VerifierSettings {
  const listUrl = required(env, "SOLC_LIST_URL", "the address of the compiler release list");
  try { new URL(listUrl); } catch { throw new VerifierSettingsError("SOLC_LIST_URL is not a URL"); }
  const sandboxImage = required(env, "SANDBOX_IMAGE", "the image a compile runs in, named by digest");
  if (!/@sha256:[0-9a-f]{64}$/.test(sandboxImage)) throw new VerifierSettingsError("SANDBOX_IMAGE must be named by digest (name@sha256:...)");
  const cacheDir = required(env, "SOLC_CACHE_DIR", "the folder the compilers are kept in");
  if (!cacheDir.startsWith("/")) throw new VerifierSettingsError("SOLC_CACHE_DIR must be an absolute path");
  return {
    listUrl, userAgent: required(env, "OUTSIDE_USER_AGENT", "the identity the compiler download gives, the project's contact"), cacheDir, sandboxImage,
    cacheMaxBytes: whole(env, "SOLC_CACHE_MAX_MB", 1024, 64, 100_000) * 1024 ** 2, dockerBin: env.SANDBOX_DOCKER_BIN || "docker",
    compileTimeoutMs: whole(env, "SOLC_TIMEOUT_MS", 60_000, 1000, 600_000), compileMemoryBytes: whole(env, "SOLC_MEMORY_MB", 2048, 256, 65_536) * 1024 ** 2,
    compileMaxOutputBytes: whole(env, "SOLC_MAX_OUTPUT_MB", 16, 1, 256) * 1024 ** 2, compileMaxInputBytes: whole(env, "SOLC_MAX_INPUT_KB", 2048, 16, 65_536) * 1024,
  };
}

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
export const HERE = join(dirname(fileURLToPath(import.meta.url)), "..");

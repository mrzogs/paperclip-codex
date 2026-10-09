import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
fs.chmodSync(path.join(cliRoot, "dist", "index.js"), 0o755);

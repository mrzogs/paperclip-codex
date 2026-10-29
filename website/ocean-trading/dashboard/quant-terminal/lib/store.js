// Everything you save (layouts, watchlists, drawings, alerts, paper account) lives in ./data as
// plain JSON files you own. Writes go to a temp file first so a crash can't corrupt them.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {observeSync,QUANT_SYNC} from './sync-observer.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = process.env.QT_DATA_DIR || path.join(root, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

export function read(name, fallback) {
  try {
    return JSON.parse(
      observeSync(QUANT_SYNC.READ,()=>fs.readFileSync(path.join(DATA_DIR, `${name}.json`), "utf8")),
    );
  } catch {
    return fallback;
  }
}

export function write(name, value) {
  const file = path.join(DATA_DIR, `${name}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  const text = observeSync(QUANT_SYNC.SERIALIZE,()=>JSON.stringify(value, null, 2));
  observeSync(QUANT_SYNC.WRITE,()=>fs.writeFileSync(tmp, text));
  try {
    observeSync(QUANT_SYNC.RENAME,()=>fs.renameSync(tmp, file));
  } catch (e) {
    // Windows refuses to rename over a file that antivirus or the indexer has open.
    // Fall back to writing in place rather than losing the save.
    if (!["EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e;
    observeSync(QUANT_SYNC.FALLBACK_WRITE,()=>fs.writeFileSync(file, text));
    observeSync(QUANT_SYNC.CLEANUP,()=>fs.rmSync(tmp, { force: true }));
  }
}

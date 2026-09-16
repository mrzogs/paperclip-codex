import fs from "node:fs";
import path from "node:path";

export async function withManifestBuildLock(lockFile, build, timeoutMs = 60000) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      fs.writeFileSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const owner = Number(fs.readFileSync(lockFile, "utf8"));
        if (owner > 0) {
          try { process.kill(owner, 0); }
          catch (probe) { if (probe.code === "ESRCH") fs.unlinkSync(lockFile); }
        }
      } catch (probe) { if (probe.code !== "ENOENT") throw probe; }
      if (Date.now() >= deadline) throw new Error("Manifest refresh is busy. Try again shortly.");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try { return await build(); }
  finally { fs.unlinkSync(lockFile); }
}

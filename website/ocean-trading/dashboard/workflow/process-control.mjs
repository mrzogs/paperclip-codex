import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export function installWebsiteControl(server, dashboard, workflowReady) {
  const root = process.env.OCEAN_WEBSITE_CONTROL_ROOT;
  if (!root) return;
  if (!path.isAbsolute(root) || !fs.existsSync(root)) throw new Error('Protected website control directory unavailable');
  const nonce = randomUUID();
  const receipt = path.join(root, 'website-process.json');
  const stop = path.join(root, 'website-stop.json');
  const source = fs.readFileSync(path.join(dashboard, 'server.mjs'));
  const readWorkflowReady = () => Boolean(typeof workflowReady === 'function' ? workflowReady() : workflowReady);
  const state = { pid: process.pid, nonce, dashboard, started_at_utc: new Date().toISOString(), server_sha256: createHash('sha256').update(source).digest('hex'), workflow_ready: readWorkflowReady() };
  const writeState = () => fs.writeFileSync(receipt, JSON.stringify(state));
  server.once('listening', writeState);
  let stopping = false;
  function shutdown() {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => server.closeAllConnections(), 10_000).unref();
  }
  const timer = setInterval(() => {
    try {
      const request = JSON.parse(fs.readFileSync(stop, 'utf8'));
      if (request.pid === process.pid && request.nonce === nonce) { fs.unlinkSync(stop); shutdown(); }
    } catch { /* No matching protected stop request. */ }
    const ready = readWorkflowReady();
    if (state.workflow_ready !== ready) {
      state.workflow_ready = ready;
      writeState();
    }
  }, 500);
  timer.unref();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

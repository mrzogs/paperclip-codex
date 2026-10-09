import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;

function restoreClaimedRequest(stop, claim) {
  if (!fs.existsSync(claim) || fs.existsSync(stop)) return;
  try { fs.renameSync(claim, stop); } catch { /* Preserve the claim if another request won the shared path. */ }
}

export function consumeWebsiteStopRequest(root, processId, nonce, afterClaim = () => {}) {
  const stop = path.join(root, 'website-stop.json');
  const claim = path.join(root, `website-stop-claimed.${processId}.${randomUUID()}.json`);
  try {
    fs.renameSync(stop, claim);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'EACCES' || error?.code === 'EPERM') return null;
    throw error;
  }

  try {
    afterClaim({ stop, claim });
    const request = JSON.parse(fs.readFileSync(claim, 'utf8'));
    if (request.pid !== processId || request.nonce !== nonce) {
      restoreClaimedRequest(stop, claim);
      return null;
    }

    const requestId = typeof request.request_id === 'string' && SAFE_REQUEST_ID.test(request.request_id)
      ? request.request_id
      : randomUUID();
    const acknowledgement = {
      schema_version: 'ocean-website-stop-ack/v1',
      pid: processId,
      nonce,
      request_id: requestId,
      requested_by: typeof request.requested_by === 'string' ? request.requested_by : null,
      acknowledged_at_utc: new Date().toISOString(),
    };
    const acknowledgementPath = path.join(root, `website-stop-ack.${requestId}.json`);
    fs.writeFileSync(acknowledgementPath, JSON.stringify(acknowledgement), { flag: 'wx' });
    fs.unlinkSync(claim);
    return { acknowledgement, acknowledgementPath };
  } catch (error) {
    restoreClaimedRequest(stop, claim);
    throw error;
  }
}

export function installWebsiteControl(server, dashboard, workflowReady, exitProcess = () => process.exit(0)) {
  const root = process.env.OCEAN_WEBSITE_CONTROL_ROOT;
  if (!root) return;
  if (!path.isAbsolute(root) || !fs.existsSync(root)) throw new Error('Protected website control directory unavailable');
  const nonce = randomUUID();
  const receipt = path.join(root, 'website-process.json');
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
    server.close(exitProcess);
    server.closeIdleConnections();
    setTimeout(() => server.closeAllConnections(), 10_000).unref();
  }
  const timer = setInterval(() => {
    try {
      if (consumeWebsiteStopRequest(root, process.pid, nonce)) shutdown();
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

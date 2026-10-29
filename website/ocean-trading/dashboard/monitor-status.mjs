import { open } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { timedSync } from './request-timing.mjs';

export class MonitorStatusReadError extends Error {
  constructor(code) { super(code); this.code = code; this.status = 503; }
}
const error = code => new MonitorStatusReadError(code);
const stopped = () => ({ running: false, status: 'stopped' });

export async function readMonitorStatusFile(file, { signal, maxBytes }, openFile = open) {
  if (signal.aborted) throw error('MONITOR_STATUS_READ_CANCELLED');
  const fd = await openFile(file, 'r');
  try {
    if (signal.aborted) throw error('MONITOR_STATUS_READ_CANCELLED');
    const metadata = await fd.stat();
    if (!metadata.isFile()) throw Object.assign(new Error('Not a regular file'), { code: 'EISDIR' });
    if (metadata.size > maxBytes) throw error('MONITOR_STATUS_SIZE_LIMIT');
    const chunks = []; let bytes = 0;
    while (true) {
      if (signal.aborted) throw error('MONITOR_STATUS_READ_CANCELLED');
      const chunk = Buffer.alloc(Math.min(65536, maxBytes - bytes + 1));
      const { bytesRead } = await fd.read(chunk, 0, chunk.length, null);
      if (signal.aborted) throw error('MONITOR_STATUS_READ_CANCELLED');
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > maxBytes) throw error('MONITOR_STATUS_SIZE_LIMIT');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, bytes);
  } finally { await fd.close(); }
}

// Read-only status projection, identical to monitorState's process semantics.
// The source study/monitor and synchronous startup/action callers are untouched.
export function projectMonitorStatus(state, managedProcess, isProcessAlive, diagnosticTiming = false) {
  const running = managedProcess && !managedProcess.killed && managedProcess.exitCode === null;
  const observe = () => isProcessAlive(state.pid);
  const externalRunning = diagnosticTiming ? timedSync('workflow.companion.monitor-process', observe) : observe();
  const isRunning = Boolean(running || externalRunning);
  return { ...state, running: isRunning, status: isRunning ? state.status || 'running' : 'stopped', managedByServer: Boolean(running) };
}

export function createMonitorStatusReader({ file, getManagedProcess, isProcessAlive, timeoutMs = 10000,
  maxBytes = 4 * 1024 * 1024, readFile = readMonitorStatusFile } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || typeof getManagedProcess !== 'function'
    || typeof isProcessAlive !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10000
    || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 4 * 1024 * 1024) throw error('MONITOR_STATUS_READER_CONFIG_INVALID');
  let active = null, queue = [], closed = false;
  const settle = (job, failure, value) => {
    if (job.settled) return;
    job.settled = true; clearTimeout(job.timer); job.signal?.removeEventListener('abort', job.abort);
    if (failure) job.reject(failure); else job.resolve(value);
  };
  const pump = () => {
    if (closed || active || !queue.length) return;
    const job = active = queue.shift();
    if (performance.now() >= job.deadline) { settle(job, error('MONITOR_STATUS_READ_TIMEOUT')); active = null; pump(); return; }
    void (async () => {
      try {
        let state;
        try {
          const bytes = await readFile(file, { signal: job.controller.signal, maxBytes });
          if (job.controller.signal.aborted) throw error('MONITOR_STATUS_READ_CANCELLED');
          if (performance.now() >= job.deadline) throw error('MONITOR_STATUS_READ_TIMEOUT');
          if (bytes.length > maxBytes) throw error('MONITOR_STATUS_SIZE_LIMIT');
          const parse = () => JSON.parse(bytes.toString('utf8'));
          state = job.diagnosticTiming ? timedSync('workflow.companion.monitor-read', parse) : parse();
        } catch (failure) {
          if (failure instanceof MonitorStatusReadError || job.controller.signal.aborted) throw failure;
          state = stopped();
        }
        if (!job.settled) {
          if (performance.now() >= job.deadline) throw error('MONITOR_STATUS_READ_TIMEOUT');
          settle(job, null, projectMonitorStatus(state, getManagedProcess(), isProcessAlive, job.diagnosticTiming));
        }
      } catch (failure) { settle(job, failure); }
      finally {
        // A cancelled caller does not free a native I/O slot. Wait for actual
        // open/read/close completion before starting the next bounded request.
        active = null; pump();
      }
    })();
  };
  return {
    read({ signal, diagnosticTiming = false } = {}) {
      if (closed) return Promise.reject(error('MONITOR_STATUS_READER_CLOSED'));
      if (signal?.aborted) return Promise.reject(error('MONITOR_STATUS_READ_CANCELLED'));
      if (queue.length >= 2) return Promise.reject(error('MONITOR_STATUS_READER_BUSY'));
      return new Promise((resolve, reject) => {
        const job = { signal, diagnosticTiming, resolve, reject, controller: new AbortController(), settled: false, deadline: performance.now() + timeoutMs };
        const cancel = code => {
          job.controller.abort(); queue = queue.filter(item => item !== job);
          settle(job, error(code));
        };
        job.abort = () => cancel('MONITOR_STATUS_READ_CANCELLED');
        signal?.addEventListener('abort', job.abort, { once: true });
        job.timer = setTimeout(() => cancel('MONITOR_STATUS_READ_TIMEOUT'), timeoutMs);
        queue.push(job); pump();
      });
    },
    close() {
      if (closed) return; closed = true;
      for (const job of [active, ...queue].filter(Boolean)) { job.controller.abort(); settle(job, error('MONITOR_STATUS_READER_CLOSED')); }
      queue = [];
    },
  };
}

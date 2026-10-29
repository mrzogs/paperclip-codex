import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { WorkflowError } from './common.mjs';
import { restoreOnboardingProjectionError } from './onboarding-projection-errors.mjs';

export const ONBOARDING_PROJECTION_DEADLINE_MS = 20000;
const fail = code => new WorkflowError(503, code);
const defaultWorker = () => new Worker(new URL('./onboarding-projection-worker.mjs', import.meta.url), {
  env: {}, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
});

// One worker and at most two queued jobs per backend. No result or approval
// cache: every accepted caller awaits a fresh read. Injection is test transport
// only; production always runs the fixed module above, never report-selected code.
export function createOnboardingProjectionReader({ workerFactory = defaultWorker, timeoutMs = ONBOARDING_PROJECTION_DEADLINE_MS } = {}) {
  let worker = null, retiring = null, active = null, queue = [], closed = false, sequence = 0;
  const cleanup = job => { clearTimeout(job.timer); job.signal?.removeEventListener('abort', job.abort); };
  const reset = (code, expectedWorker = worker, preserveQueue = false) => {
    if (expectedWorker !== worker) return;
    const previous = worker; worker = null;
    for (const job of [active, ...(preserveQueue ? [] : queue)].filter(Boolean)) { cleanup(job); job.reject(fail(code)); }
    active = null; if (!preserveQueue) queue = [];
    if (previous) {
      previous.removeAllListeners(); previous.on('error', () => {});
      // A failed termination is not proof that the old thread exited. Keep
      // retirement latched in that case; queued jobs retain their deadlines.
      retiring = Promise.resolve(previous.terminate()).then(() => { retiring = null; pump(); }, () => {});
    }
  };
  const pump = () => {
    if (closed || retiring || active || !queue.length) return;
    if (!worker) {
      try {
        worker = workerFactory(); const current = worker;
        current.on('message', message => {
          if (worker !== current || !active || message.id !== active.id) return reset('ONBOARDING_WORKER_PROTOCOL_ERROR', current);
          if (performance.now() > active.deadline) return reset('ONBOARDING_READ_TIMEOUT', current, true);
          const job = active; active = null; cleanup(job); current.unref();
          if (message.error) job.reject(restoreOnboardingProjectionError(message.error));
          else job.resolve(message.result);
          pump();
        });
        current.on('error', () => reset('ONBOARDING_WORKER_UNAVAILABLE', current));
        current.on('exit', () => reset('ONBOARDING_WORKER_UNAVAILABLE', current));
        current.unref();
      } catch { reset('ONBOARDING_WORKER_UNAVAILABLE'); return; }
    }
    active = queue.shift();
    try { worker.ref(); worker.postMessage({ id: active.id, kind: active.kind, options: active.options }); }
    catch { reset('ONBOARDING_INPUT_REJECTED'); }
  };
  return {
    read(kind, options, { signal, deadline = performance.now() + timeoutMs } = {}) {
      if (closed) return Promise.reject(fail('ONBOARDING_READER_CLOSED'));
      if (!['identity', 'projection'].includes(kind)) return Promise.reject(fail('ONBOARDING_INPUT_REJECTED'));
      if (signal?.aborted) return Promise.reject(fail('ONBOARDING_READ_CANCELLED'));
      if (queue.length >= 2) return Promise.reject(fail('ONBOARDING_READER_BUSY'));
      let bytes;
      try { bytes = Buffer.byteLength(JSON.stringify(options)); } catch { return Promise.reject(fail('ONBOARDING_INPUT_REJECTED')); }
      if (bytes > 256 * 1024) return Promise.reject(fail('ONBOARDING_INPUT_SIZE_LIMIT'));
      const remaining = Math.min(timeoutMs, deadline - performance.now());
      if (remaining <= 0) return Promise.reject(fail('ONBOARDING_READ_TIMEOUT'));
      return new Promise((resolve, reject) => {
        const job = { id: ++sequence, kind, options, signal, resolve, reject, deadline: performance.now() + remaining };
        job.abort = () => {
          if (active === job) reset('ONBOARDING_READ_CANCELLED', worker, true);
          else { queue = queue.filter(item => item !== job); cleanup(job); reject(fail('ONBOARDING_READ_CANCELLED')); }
        };
        signal?.addEventListener('abort', job.abort, { once: true });
        job.timer = setTimeout(() => {
          if (active === job) reset('ONBOARDING_READ_TIMEOUT', worker, true);
          else { queue = queue.filter(item => item !== job); cleanup(job); reject(fail('ONBOARDING_READ_TIMEOUT')); }
        }, remaining);
        queue.push(job); pump();
      });
    },
    close() { if (closed) return; closed = true; reset('ONBOARDING_READER_CLOSED'); },
  };
}

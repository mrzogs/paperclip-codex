import fs from 'node:fs';
import { WorkflowBackend } from './backend.mjs';

const state = JSON.parse(fs.readFileSync(0, 'utf8'));
const segmentId = process.argv[2];
const backend = new WorkflowBackend(state.config, state.environment);
const actor = { id: 'wayne-ocean-ui', role: 'HUMAN', namespace: 'TEST', scopes: [], strategyIds: [], instanceIds: [] };
const runs = {
  'june-2025-m25-pre-roll': 'test-run-cicd-vwap-june-2025-m25-v013',
  'june-2025-u25-post-roll': 'test-run-cicd-vwap-june-2025-u25-v013',
};

try {
  const runId = runs[segmentId];
  if (!runId) throw new Error('SEALED_SEGMENT_REQUIRED');
  let context = backend.runs.read(actor, runId);
  if (context.state === 'ACTIVE') {
    context = backend.runs.perform('end', actor, {
      run_id: runId,
      expected_revision: context.revision,
      outcome: 'COMPLETED',
    });
  } else if (!['COMPLETING', 'COMPLETED'].includes(context.state)) {
    throw new Error('RUN_NOT_COMPLETABLE');
  }
  process.stdout.write(`${JSON.stringify({
    status: context.state === 'COMPLETED' ? 'ALREADY_COMPLETED' : 'DRAIN_REQUESTED',
    segment_id: segmentId,
    run_id: runId,
    run_state: context.state,
    revision: context.revision,
    outcome: 'COMPLETED',
  }, null, 2)}\n`);
} finally {
  backend.close();
}

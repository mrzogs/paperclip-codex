import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReprocessRunId } from '../public/workflow/reprocess-identity.js';

const uuid = '56334e44-b21a-4258-bcbf-35bf3508b790';

test('repeat reprocessing uses the stable original run without nesting IDs', () => {
  const context = { run_id: `reprocess-cicd-vwap-october-r7-${uuid}` };
  const manager = { plan: { reprocess_of_run_id: 'cicd-vwap-october-r7' } };
  assert.equal(
    buildReprocessRunId(context, manager, uuid),
    `reprocess-cicd-vwap-october-r7-${uuid}`,
  );
});

test('generated reprocess IDs stay inside the workflow identity contract', () => {
  const result = buildReprocessRunId({ run_id: 'a'.repeat(200) }, null, uuid);
  assert.ok(result.length <= 128);
  assert.match(result, /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
});

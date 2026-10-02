import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareOperation, commitOperation } from './operator.mjs';
import { WorkflowBackend } from './backend.mjs';
import { digest, objectHash, sealedHash } from './common.mjs';
import { knownSetupTask } from './setup-operator.mjs';

test('S31.4 accepts an additive strategy-scoped Brain dataset receipt without changing S31.3', () => {
  assert.equal(knownSetupTask('S31.3'), true);
  assert.equal(knownSetupTask('S31.4'), true);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocean-s314-dataset-'));
  let backend;
  try {
    const plan = prepareOperation({ action: 'bootstrap', operator_id: 'S-1-5-21-1000', root });
    commitOperation(plan);
    const state = plan.next;
    const examples = JSON.parse(fs.readFileSync(new URL('./contracts/2.1.0/shared-contracts/examples/positive-examples.json', import.meta.url)));
    const manifest = { ...examples['dataset-manifest'], dataset_manifest_id: 'isolated-s314-strategy-dataset' };
    manifest.manifest_hash = sealedHash(manifest, 'manifest_hash');
    const manifestText = JSON.stringify(manifest);
    const instance = { ...examples['execution-instance'], execution_instance_id: 'isolated-s314-instance', strategy_id: 'isolated_s314_strategy' };
    const binding = { instance, strategy_id: instance.strategy_id, strategy_code_hash: digest('isolated code'), profile_hash: digest('isolated profile'), state: 'VERIFIED_FACTS_ONLY', operational_enabled: false };
    binding.binding_hash = objectHash(binding);
    state.config.operational_factual_bindings = [binding];
    backend = new WorkflowBackend(state.config, state.environment);
    const sourceMember = 'artifacts/brain-runtime-dataset-manifest.json';
    const sourceBundleSha256 = 'a'.repeat(64);
    backend.db.prepare("INSERT INTO ow_setup_receipts VALUES(?,?,?,'HISTORICAL_SETUP_NOT_APPROVAL')").run(
      'S31.4', digest('isolated S31.4 receipt'), JSON.stringify({ task_id: 'S31.4', status: 'PASS', verified_bundle_sha256: sourceBundleSha256, verified_members: { [sourceMember]: digest(manifestText).slice(7) } }),
    );
    const actor = { id: 'isolated-s314-brain', role: 'BRAIN', scopes: ['read', 'event.write'], strategyIds: [instance.strategy_id], instanceIds: [instance.execution_instance_id] };
    const input = { strategy_id: instance.strategy_id, instance_id: instance.execution_instance_id, manifest_text: manifestText, source_member: sourceMember, source_task: 'S31.4', source_bundle_sha256: sourceBundleSha256 };
    const first = backend.operational.manifest(actor, input);
    assert.equal(first.state, 'PENDING_HUMAN_DATASET_RELEASE');
    assert.equal(first.runtime_eligible, false);
    assert.equal(first.learner_permission, 'NONE');
    assert.equal(backend.operational.manifest(actor, input).idempotent, true);
    assert.throws(() => backend.operational.manifest(actor, { ...input, source_task: 'S31.5' }), /DATASET_OWNER_RECEIPT_REQUIRED/);
  } finally {
    backend?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

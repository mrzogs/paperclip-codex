import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sealedHash } from './common.mjs';
import {
  DEFAULT_VWAP_PHYSICAL_COMPARATOR_CONTRACT,
  physicalComparatorContractHash,
  readVwapPhysicalComparatorContract,
} from './vwap-physical-comparator-contract.mjs';

function sourceContract() {
  return JSON.parse(fs.readFileSync(DEFAULT_VWAP_PHYSICAL_COMPARATOR_CONTRACT, 'utf8'));
}

function writeContract(value) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocean-v238-comparator-'));
  const target = path.join(root, 'contract.json');
  fs.writeFileSync(target, JSON.stringify(value));
  return target;
}

function reseal(value) {
  value.contract_hash = physicalComparatorContractHash(value);
  value.document_hash = sealedHash(value, 'document_hash');
  return value;
}

test('accepts the exact TEST-only v238 comparator and create-new discovery context', () => {
  const result = readVwapPhysicalComparatorContract();
  assert.equal(result.state, 'AVAILABLE');
  assert.equal(result.status, 'PENDING_HUMAN_APPROVAL');
  assert.equal(result.logical_baseline.logical_version, 'v0.1.1');
  assert.equal(result.physical_comparator.version, 'v0.6.238');
  assert.equal(result.preserved_candidate_v240.state, 'DISTINCT_UNSELECTED_UNCHANGED');
  assert.equal(result.dataset_selection.role, 'DISCOVERY');
  assert.equal(result.execution_plan.run_record_inserted, false);
  assert.equal(result.execution_plan.release_record_inserted, false);
  assert.equal(result.required_human_approvals.length, 2);
});

test('fails closed if the sealed document is changed', () => {
  const value = sourceContract();
  value.execution_plan.replay_started = true;
  const result = readVwapPhysicalComparatorContract(writeContract(value));
  assert.equal(result.state, 'ATTENTION_REQUIRED');
  assert.equal(result.status, 'BLOCKED_FAIL_CLOSED');
});

test('rejects role alteration even when an altered document is resealed', () => {
  const value = sourceContract();
  value.dataset_selection.role = 'VALIDATION';
  reseal(value);
  const result = readVwapPhysicalComparatorContract(writeContract(value));
  assert.equal(result.state, 'ATTENTION_REQUIRED');
  assert.equal(result.reason, 'PHYSICAL_COMPARATOR_DATASET_ROLE_INVALID');
});

test('rejects selecting or changing the preserved v240 candidate even when resealed', () => {
  const value = sourceContract();
  value.preserved_candidate_v240.selected = true;
  value.preserved_candidate_v240.active_bridge_changed = true;
  reseal(value);
  const result = readVwapPhysicalComparatorContract(writeContract(value));
  assert.equal(result.state, 'ATTENTION_REQUIRED');
  assert.equal(result.reason, 'PHYSICAL_COMPARATOR_V240_BOUNDARY_INVALID');
});

test('rejects reusing one approval record for both decisions', () => {
  const value = sourceContract();
  value.required_human_approvals[1].approval_id = value.required_human_approvals[0].approval_id;
  value.document_hash = sealedHash(value, 'document_hash');
  const result = readVwapPhysicalComparatorContract(writeContract(value));
  assert.equal(result.state, 'ATTENTION_REQUIRED');
  assert.equal(result.reason, 'PHYSICAL_COMPARATOR_APPROVALS_REUSED');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { digest, objectHash } from './common.mjs';
import {
  CANDIDATE_EVALUATION_RESULT_VERSION,
  OperationalCandidateEvaluator,
} from './operational-candidate-evaluation.mjs';

const noAuthority = Object.freeze({
  automatic_strategy_change: false,
  candidate_approved: false,
  paper_authorized: false,
  live_authorized: false,
  automatic_promotion: false,
});

function exchange(conclusion, policyStatus = 'NOT_PREDECLARED') {
  const request = {
    plan_hash: digest('plan'),
    logical: { candidate_hash: digest('candidate') },
    evaluation_policy: { status: policyStatus },
    source_artifacts: { 'test-backtest': digest('backtest') },
    correlation: { event_id: 'candidate-evaluation:test', job_id: 'test-job', input_sha256: digest('input') },
    authority: noAuthority,
  };
  const content = JSON.stringify({
    schema_version: CANDIDATE_EVALUATION_RESULT_VERSION,
    conclusion,
    plan_hash: request.plan_hash,
    candidate_hash: request.logical.candidate_hash,
  });
  const response = {
    schema_version: CANDIDATE_EVALUATION_RESULT_VERSION,
    record_id: 'reasoning-test-candidate-evaluation',
    relative_path: 'reasoning/test-candidate-evaluation.md',
    content,
    content_sha256: digest(content),
    conclusion,
    plan_hash: request.plan_hash,
    candidate_hash: request.logical.candidate_hash,
    source_artifacts: request.source_artifacts,
    correlation: request.correlation,
    authority: { ...noAuthority, human_governance_required: true },
  };
  return { request, response };
}

test('undeclared evaluation policy cannot manufacture a benefit or no-benefit verdict after holdout', () => {
  const evaluator = Object.create(OperationalCandidateEvaluator.prototype);
  for (const conclusion of ['BENEFIT_SUPPORTED', 'NO_BENEFIT']) {
    const { request, response } = exchange(conclusion);
    assert.throws(() => evaluator.verifyResponse(response, request), /CANDIDATE_EVALUATION_BRAIN_RESPONSE_INVALID/);
  }
  for (const conclusion of ['BENEFIT_NOT_ESTABLISHED', 'MORE_EVIDENCE_REQUIRED']) {
    const { request, response } = exchange(conclusion);
    assert.equal(objectHash(evaluator.verifyResponse(response, request)), objectHash(response));
  }
});

test('declared policy still requires exact lineage, source echo and no-authority response', () => {
  const evaluator = Object.create(OperationalCandidateEvaluator.prototype);
  const { request, response } = exchange('BENEFIT_SUPPORTED', 'PREDECLARED');
  assert.equal(objectHash(evaluator.verifyResponse(response, request)), objectHash(response));
  for (const changed of [
    { ...response, plan_hash: digest('other-plan') },
    { ...response, source_artifacts: { 'test-backtest': digest('other-backtest') } },
    { ...response, authority: { ...response.authority, paper_authorized: true } },
  ]) assert.throws(() => evaluator.verifyResponse(changed, request), /CANDIDATE_EVALUATION_BRAIN_RESPONSE_INVALID/);
});

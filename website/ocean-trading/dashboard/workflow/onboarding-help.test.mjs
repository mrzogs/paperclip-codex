import assert from 'node:assert/strict';
import test from 'node:test';
import { ONBOARDING_HELP } from '../public/workflow/onboarding-help.js';
import { QUESTIONNAIRES } from './strategy-onboarding.mjs';

test('help covers every onboarding step and questionnaire field', () => {
  assert.deepEqual(ONBOARDING_HELP.steps.map(step => step.number), [1,2,3]);
  assert.equal(new Set(ONBOARDING_HELP.steps.map(step => step.id)).size, 3);

  const documented = new Map(ONBOARDING_HELP.questionnaires.map(item => [item.id, item]));
  assert.deepEqual([...documented.keys()].sort(), QUESTIONNAIRES.map(item => item.id).sort());

  for (const questionnaire of QUESTIONNAIRES) {
    const help = documented.get(questionnaire.id);
    assert.equal(help.title, questionnaire.title);
    assert.equal(help.step_id, questionnaire.step_id);
    assert.deepEqual(help.fields.map(item => item.key), questionnaire.fields.map(item => item.key));
    for (const [index, schemaField] of questionnaire.fields.entries()) {
      const helpField = help.fields[index];
      assert.equal(helpField.label, schemaField.label);
      assert.ok(helpField.meaning.length >= 20, `${questionnaire.id}.${schemaField.key} meaning`);
      assert.ok(helpField.provide.length >= 15, `${questionnaire.id}.${schemaField.key} provide`);
      assert.ok(helpField.validation.length >= 8, `${questionnaire.id}.${schemaField.key} validation`);
    }
  }

  assert.deepEqual(ONBOARDING_HELP.submission_record.map(item => item.key), ['status','author','timestamp','source_fingerprint','receipt']);
  assert.ok(ONBOARDING_HELP.registration_fields.length >= 5);
  assert.ok(ONBOARDING_HELP.lifecycle_fields.length >= 4);
});

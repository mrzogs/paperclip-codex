import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {protectedOperatorCommitTimeoutMs,protectedOperatorTimeoutMs} from './maintenance.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));

test('protected operator startup and maintenance allow the measured large-state verification window',()=>{
  assert.equal(protectedOperatorTimeoutMs,90_000);
  assert.equal(protectedOperatorCommitTimeoutMs,900_000);
  const backend=fs.readFileSync(path.join(here,'backend.mjs'),'utf8');
  const maintenance=fs.readFileSync(path.join(here,'maintenance.mjs'),'utf8');
  const wrapper=fs.readFileSync(path.resolve(here,'../../../../scripts/ocean-workflow-operator.ps1'),'utf8');
  assert.match(backend,/timeout:\s*protectedOperatorTimeoutMs/);
  assert.match(maintenance,/\['Commit','Maintenance'\]\.includes\(action\) \? protectedOperatorCommitTimeoutMs : protectedOperatorTimeoutMs/);
  assert.match(maintenance,/setTimeout\([^\n]+timeoutMs\)/);
  assert.match(wrapper,/StandardOutput\.ReadToEndAsync\(\)/);
  assert.match(wrapper,/StandardError\.ReadToEndAsync\(\)/);
  assert.match(wrapper,/OCEAN_WORKFLOW_COMMIT_TIMEOUT_SECONDS/);
  assert.match(wrapper,/WaitForExit\(\$timeoutMilliseconds\)/);
  assert.match(wrapper,/Kill\(\$true\)/);
  assert.ok(wrapper.indexOf('StandardOutput.ReadToEndAsync()') < wrapper.indexOf('StandardInput.WriteAsync($json)'));
});

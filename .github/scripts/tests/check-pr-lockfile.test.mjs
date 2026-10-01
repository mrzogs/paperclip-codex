import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLockfile } from '../check-pr-lockfile.mjs';

const makeFiles = (filenames) => filenames.map(f => ({ filename: f, status: 'modified' }));

test('passes when lockfile is not changed', () => {
  assert.equal(checkLockfile(makeFiles(['src/foo.ts'])).passed, true);
});

test('passes when lockfile changes with a package manifest', () => {
  const result = checkLockfile(makeFiles(['package.json', 'pnpm-lock.yaml']));
  assert.equal(result.passed, true);
});

test('fails when lockfile changes without a dependency manifest', () => {
  const result = checkLockfile(makeFiles(['src/foo.ts', 'pnpm-lock.yaml']));
  assert.equal(result.passed, false);
  assert.ok(result.failures[0].includes('pnpm-lock.yaml'));
});

test('passes when lockfile changes with a workspace package manifest', () => {
  const result = checkLockfile(makeFiles(['packages/shared/package.json', 'pnpm-lock.yaml']));
  assert.equal(result.passed, true);
});

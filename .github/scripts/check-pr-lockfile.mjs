#!/usr/bin/env node
/**
 * check-pr-lockfile.mjs
 * Checks that pnpm-lock.yaml changes accompany a dependency manifest change.
 * Export: checkLockfile(files) → { passed, failures }
 */
import { fileURLToPath } from 'node:url';

export function checkLockfile(files) {
  const lockfileChanged = files.some(f => f.filename === 'pnpm-lock.yaml');
  if (!lockfileChanged) return { passed: true, failures: [] };

  const dependencyManifestChanged = files.some(f =>
    f.filename === 'pnpm-workspace.yaml' ||
    f.filename.endsWith('/package.json') ||
    f.filename === 'package.json' ||
    f.filename.startsWith('patches/')
  );

  return {
    passed: dependencyManifestChanged,
    failures: dependencyManifestChanged ? [] : [
      '`pnpm-lock.yaml` changed without a dependency manifest or patch. ' +
      'Regenerate it locally from the intended manifest change, or remove the unrelated lockfile edit.',
    ],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = JSON.parse(process.env.PR_FILES ?? '[]');
  const result = checkLockfile(files);
  console.log(JSON.stringify(result));
  process.exit(result.passed ? 0 : 1);
}

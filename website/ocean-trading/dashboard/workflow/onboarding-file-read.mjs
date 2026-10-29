import fs from 'node:fs';
import { OnboardingProjectionLimitError } from './onboarding-projection-errors.mjs';

// Only the fixed read-only projection worker enters this scope. Existing action
// validation and other callers keep the original synchronous filesystem API.
let scope = null;
const limitError = code => new OnboardingProjectionLimitError(code);
export function withBoundedOnboardingReads(limits, work) {
  const previous = scope, current = { ...limits, bytes: 0, reads: 0, failure: null };
  scope = current;
  try {
    const value = work();
    if (current.failure) throw current.failure;
    return value;
  } finally { scope = previous; }
}
export function readOnboardingFileSync(filename, options) {
  if (!scope) return fs.readFileSync(filename, options);
  const current = scope;
  const fail = code => { current.failure ||= limitError(code); throw current.failure; };
  if (++current.reads > current.maxReads) fail('ONBOARDING_READ_COUNT_LIMIT');
  const fd = fs.openSync(filename, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) fail('ONBOARDING_REGULAR_FILE_REQUIRED');
    if (stat.size > current.maxFileBytes) fail('ONBOARDING_FILE_SIZE_LIMIT');
    const chunks = []; let size = 0;
    while (true) {
      const capacity = Math.min(65536, current.maxFileBytes - size + 1, current.maxTotalBytes - current.bytes + 1);
      const chunk = Buffer.alloc(Math.max(1, capacity));
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      size += count; current.bytes += count;
      if (size > current.maxFileBytes) fail('ONBOARDING_FILE_SIZE_LIMIT');
      if (current.bytes > current.maxTotalBytes) fail('ONBOARDING_TOTAL_SIZE_LIMIT');
      chunks.push(chunk.subarray(0, count));
    }
    const bytes = Buffer.concat(chunks, size), encoding = typeof options === 'string' ? options : options?.encoding;
    return encoding ? bytes.toString(encoding) : bytes;
  } finally { fs.closeSync(fd); }
}

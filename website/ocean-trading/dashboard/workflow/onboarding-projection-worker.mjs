import { parentPort } from 'node:worker_threads';
import { loadStrategyOnboarding, readOnboardingStrategyId } from './strategy-onboarding.mjs';
import { withBoundedOnboardingReads } from './onboarding-file-read.mjs';
import { OnboardingProjectionLimitError, serializeOnboardingProjectionError } from './onboarding-projection-errors.mjs';

export const ONBOARDING_READ_LIMITS = Object.freeze({ maxFileBytes: 4 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024, maxReads: 16 });
const maxInputBytes = 256 * 1024, maxOutputBytes = 2 * 1024 * 1024;

parentPort.on('message', message => {
  const { id, kind, options } = message;
  try {
    if (!Number.isSafeInteger(id) || !['identity', 'projection'].includes(kind)
      || Buffer.byteLength(JSON.stringify(options)) > maxInputBytes) throw new OnboardingProjectionLimitError('ONBOARDING_INPUT_REJECTED');
    const result = withBoundedOnboardingReads(ONBOARDING_READ_LIMITS, () => {
      if (kind === 'identity') return readOnboardingStrategyId(options.root);
      let runtimeSpec;
      const projection = loadStrategyOnboarding({ ...options, runtimeProbe: input => {
        runtimeSpec = input;
        // Internal transport placeholder only; never sent to the HTTP caller.
        return { chart_replay: { started: null } };
      } });
      return { projection, runtimeSpec };
    });
    if (Buffer.byteLength(JSON.stringify(result)) > maxOutputBytes) throw new OnboardingProjectionLimitError('ONBOARDING_OUTPUT_SIZE_LIMIT');
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({ id, error: serializeOnboardingProjectionError(error) });
  }
});

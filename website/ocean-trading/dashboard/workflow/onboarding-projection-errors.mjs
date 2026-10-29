import { WorkflowError } from './common.mjs';

export class OnboardingProjectionLimitError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export function serializeOnboardingProjectionError(error) {
  if (error instanceof OnboardingProjectionLimitError) return { kind: 'UNAVAILABLE', code: error.code };
  // WorkflowError messages are the existing deliberately public contract.
  // Never transport an unexpected source exception's message, stack or details.
  if (error instanceof WorkflowError) return { kind: 'WORKFLOW', status: error.status, code: error.code, message: error.message };
  return { kind: 'INTERNAL' };
}
export function restoreOnboardingProjectionError(error) {
  if (error?.kind === 'WORKFLOW') return new WorkflowError(error.status, error.code, error.message);
  if (error?.kind === 'UNAVAILABLE') return new WorkflowError(503, error.code);
  if (error?.kind === 'INTERNAL') return new Error('Workflow operation failed');
  return new WorkflowError(503, 'ONBOARDING_WORKER_PROTOCOL_ERROR');
}

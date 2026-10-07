const MAX_ID_LENGTH = 128;
const UUID_LENGTH = 36;
const PREFIX = 'reprocess-';

export function buildReprocessRunId(context, manager, uuid = crypto.randomUUID()) {
  const originalRunId = manager?.plan?.reprocess_of_run_id || context.run_id;
  const maximumBaseLength = MAX_ID_LENGTH - PREFIX.length - UUID_LENGTH - 1;
  const boundedBase = String(originalRunId).slice(0, maximumBaseLength).replace(/[^A-Za-z0-9_.:-]/g, '-');
  return `${PREFIX}${boundedBase}-${uuid}`;
}

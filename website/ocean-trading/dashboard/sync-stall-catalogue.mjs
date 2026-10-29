import { createHash } from 'node:crypto';
import { QUANT_SYNC } from './quant-terminal/lib/sync-observer.js';

export const SYNC_OP = Object.freeze({ UNKNOWN: 0, FILE_STAT: 101, POLL_MANIFEST: 102, POLL_INPUT: 103, POLL_EXISTS: 104,
  JSON_EXISTS: 105, JSON_READ: 106, STATIC_READ: 107, STATIC_EXISTS:108, CONTROL_RENAME: 201, CONTROL_READ: 202,
  CONTROL_WRITE: 203, CONTROL_UNLINK: 204, CONTROL_RECEIPT: 205, CONTROL_EXISTS:206, CONTROL_POLL:207, AUTH_IDENTITY: 301,
  AUTH_SESSION: 302, AUTH_BROWSER: 303 });
const labels = ['manifest.sqlite.child','manifest.build','learning.telemetry-qualification','workflow.run-manager-read',
  'workflow.run-receipt-count','workflow.run-trade-count','workflow.run-analysis-count','workflow.run-events',
  'workflow.onboarding','workflow.onboarding.source.identity','workflow.onboarding.runtime-cache',
  ...['registry','profile','instance','setup','unresolved','remediation'].map(x=>`workflow.onboarding.source.${x}`),
  ...['events','brain-outbox','registration','activation'].map(x=>`workflow.onboarding.db.${x}`),
  ...['campaign','priority','autonomous','monitor','comparator','dispatch'].map(x=>`workflow.onboarding.aux.${x}`),
  ...['legacy-state','monitor-read','monitor-process','reader-config','report-loader.sync','approval-config','runtime-launch',
    'runtime-json','strategy-assembly','status-project','view-serialize','status-serialize'].map(x=>`workflow.companion.${x}`),
  ...['dashboard','strategies','cases','runs','approvals','history','artifacts','onboarding-guide','other'].map(x=>`workflow./api/workflow/view/${x}`)];
export const TIMING_OPS = Object.freeze(Object.fromEntries(labels.map((label,index)=>[label,1000+index])));
export const SYNC_CATALOGUE = Object.freeze({ version:'ocean-sync-stall-catalogue/v1', operations:SYNC_OP,
  timing:TIMING_OPS, quant:QUANT_SYNC });
export const SYNC_CATALOGUE_SHA256 = createHash('sha256').update(JSON.stringify(SYNC_CATALOGUE)).digest('hex');
const knownSyncIds = new Set([...Object.values(SYNC_OP),...Object.values(TIMING_OPS),...Object.values(QUANT_SYNC)]);
export const isKnownSyncId = value => knownSyncIds.has(value);

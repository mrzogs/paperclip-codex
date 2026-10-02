import crypto from 'node:crypto';
import fs from 'node:fs';
import { id, objectHash, requireThat } from './common.mjs';

const PROJECT = 'ocean-trading-website';
const DOMAIN = 'software';
const DEFAULT_API = 'http://127.0.0.1:4001';
const DEFAULT_TOKEN_FILE = 'D:\\Paperclip-codex\\workspaces\\hermes-brain-console\\secrets\\clients\\ocean-website-development.token';
const SYSTEM_ACTOR = Object.freeze({ id: 'ocean-onboarding-brain-sync', role: 'BRAIN', namespace: 'TEST' });

const safeError = error => String(error?.code || error?.message || 'BRAIN_SYNC_FAILED').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 500);
const markerFor = row => `ocean-onboarding-milestone:${row.milestone_id}:${row.payload_hash}`;
const recordIdFromPath = value => /^reasoning\/(reasoning-[A-Za-z0-9-]+)\.md$/.exec(value || '')?.[1] || null;

export function readOnboardingBrainOutbox(db) {
  return db.prepare('SELECT * FROM ow_onboarding_brain_outbox ORDER BY rowid').all().map(row => ({
    id: row.id,
    strategy_id: row.strategy_id,
    milestone_type: row.milestone_type,
    milestone_id: row.milestone_id,
    payload_hash: row.payload_hash,
    state: row.state,
    attempts: row.attempts,
    brain_record_id: row.brain_record_id,
    brain_relative_path: row.brain_relative_path,
    last_error: row.last_error,
    created_at_utc: row.created_at_utc,
    acknowledged_at_utc: row.acknowledged_at_utc,
  }));
}

export function enqueueOnboardingBrain(backend, { strategy_id, milestone_type, milestone_id, title, summary, conclusion, source_fingerprint, receipt_hash }) {
  id(strategy_id); id(milestone_id, true);
  requireThat(['QUESTIONNAIRE','REGISTRATION','ACTIVATION'].includes(milestone_type), 422, 'ONBOARDING_BRAIN_MILESTONE_INVALID');
  requireThat(typeof title === 'string' && title.length >= 3 && title.length <= 200, 422, 'ONBOARDING_BRAIN_TITLE_INVALID');
  requireThat(typeof summary === 'string' && summary.length >= 3 && summary.length <= 6000, 422, 'ONBOARDING_BRAIN_SUMMARY_INVALID');
  requireThat(typeof conclusion === 'string' && conclusion.length >= 3 && conclusion.length <= 6000, 422, 'ONBOARDING_BRAIN_CONCLUSION_INVALID');
  const payload = {
    schema_version: 'ocean-onboarding-brain-milestone/v1', strategy_id, milestone_type, milestone_id,
    title, summary, conclusion, source_fingerprint: source_fingerprint || null, receipt_hash: receipt_hash || null,
  };
  const payloadHash = objectHash(payload);
  const existing = backend.db.prepare('SELECT payload_hash FROM ow_onboarding_brain_outbox WHERE milestone_id=?').get(milestone_id);
  if (existing) {
    requireThat(existing.payload_hash === payloadHash, 409, 'ONBOARDING_BRAIN_MILESTONE_CONFLICT');
    return backend.db.prepare('SELECT * FROM ow_onboarding_brain_outbox WHERE milestone_id=?').get(milestone_id);
  }
  requireThat(backend.db.prepare("SELECT COUNT(*) AS n FROM ow_onboarding_brain_outbox WHERE state NOT IN ('ACKNOWLEDGED','DEAD_LETTER')").get().n < 500, 429, 'ONBOARDING_BRAIN_BACKPRESSURE');
  const row = {
    id: `test-onboarding-brain-${crypto.randomUUID()}`,
    strategy_id,
    milestone_type,
    milestone_id,
    payload_hash: payloadHash,
    payload_json: JSON.stringify(payload),
    state: 'PENDING',
    next_attempt_ms: Date.now(),
    created_at_utc: new Date().toISOString(),
  };
  backend.db.prepare("INSERT INTO ow_onboarding_brain_outbox(id,strategy_id,milestone_type,milestone_id,payload_hash,payload_json,state,next_attempt_ms,created_at_utc) VALUES(?,?,?,?,?,?,'PENDING',?,?)")
    .run(row.id, row.strategy_id, row.milestone_type, row.milestone_id, row.payload_hash, row.payload_json, row.next_attempt_ms, row.created_at_utc);
  return row;
}

export function retryOnboardingBrain(backend, actor, data) {
  requireThat(actor.role === 'HUMAN', 403, 'WAYNE_BROWSER_ONLY');
  requireThat(data && Object.keys(data).every(key => key === 'outbox_id'), 422, 'UNKNOWN_OR_AUTHORITY_FIELD');
  id(data.outbox_id, true);
  const row = backend.db.prepare('SELECT * FROM ow_onboarding_brain_outbox WHERE id=?').get(data.outbox_id);
  requireThat(row, 404, 'ONBOARDING_BRAIN_ITEM_NOT_FOUND');
  requireThat(['FAILED','DEAD_LETTER'].includes(row.state), 409, 'ONBOARDING_BRAIN_RETRY_NOT_REQUIRED');
  backend.db.prepare("UPDATE ow_onboarding_brain_outbox SET state='PENDING',attempts=0,next_attempt_ms=?,lease_id=NULL,lease_until_ms=NULL,last_error=NULL WHERE id=?").run(Date.now(), row.id);
  backend.event(row.strategy_id, 'onboarding.brain.retry', actor, { outbox_id: row.id, milestone_id: row.milestone_id });
  return { outbox_id: row.id, state: 'PENDING' };
}

export class OnboardingBrainSync {
  constructor(backend, options = {}) {
    this.backend = backend;
    this.enabled = options.enabled !== false;
    this.api = String(options.api || DEFAULT_API).replace(/\/$/, '');
    this.tokenFile = options.token_file || DEFAULT_TOKEN_FILE;
    this.fetch = options.fetch || globalThis.fetch;
    const requestedIntervalMs = Number(options.interval_ms || 5000);
    this.intervalMs = Number.isFinite(requestedIntervalMs) && requestedIntervalMs >= 1000
      ? requestedIntervalMs
      : 5000;
    this.timer = null;
    this.running = false;
    this.lastSuccessUtc = null;
    this.lastError = null;
    this.identityVerified = false;
  }
  status() {
    const counts = Object.fromEntries(this.backend.db.prepare('SELECT state,COUNT(*) AS n FROM ow_onboarding_brain_outbox GROUP BY state').all().map(row => [row.state, row.n]));
    return {
      enabled: this.enabled,
      state: !this.enabled ? 'DISABLED' : this.lastError ? 'DEGRADED' : this.identityVerified ? 'READY' : 'STARTING',
      identity: this.identityVerified ? `${PROJECT}/${DOMAIN}` : 'PENDING_VERIFICATION',
      pending: (counts.PENDING || 0) + (counts.FAILED || 0) + (counts.DELIVERING || 0),
      acknowledged: counts.ACKNOWLEDGED || 0,
      dead_letter: counts.DEAD_LETTER || 0,
      last_success_utc: this.lastSuccessUtc,
      last_error: this.lastError,
    };
  }
  start() {
    if (!this.enabled || this.timer) return;
    const run = () => void this.flushOnce().catch(error => { this.lastError = safeError(error); });
    this.timer = setInterval(run, Math.max(1000, this.intervalMs));
    this.timer.unref?.();
    run();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  token() {
    requireThat(fs.existsSync(this.tokenFile), 503, 'ONBOARDING_BRAIN_CREDENTIAL_MISSING');
    const token = fs.readFileSync(this.tokenFile, 'utf8').trim();
    requireThat(token.length >= 20, 503, 'ONBOARDING_BRAIN_CREDENTIAL_INVALID');
    return token;
  }
  async call(path, { token, body } = {}) {
    const response = await this.fetch(`${this.api}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const value = await response.json().catch(() => ({}));
    requireThat(response.ok, 503, `ONBOARDING_BRAIN_HTTP_${response.status}`);
    return value;
  }
  async verifyIdentity(token) {
    const identity = await this.call('/auth/me', { token });
    requireThat(identity?.client?.scope === 'PROJECT' && identity.client.project === PROJECT && identity.client.domain === DOMAIN, 503, 'ONBOARDING_BRAIN_IDENTITY_MISMATCH');
    this.identityVerified = true;
  }
  claim() {
    const now = Date.now();
    return this.backend.store.transaction(() => {
      this.backend.db.prepare("UPDATE ow_onboarding_brain_outbox SET state='DEAD_LETTER',lease_id=NULL,lease_until_ms=NULL,last_error='MAX_ATTEMPTS_EXCEEDED' WHERE state IN ('PENDING','FAILED','DELIVERING') AND attempts>=5 AND (lease_until_ms IS NULL OR lease_until_ms<=?)").run(now);
      const row = this.backend.db.prepare("SELECT * FROM ow_onboarding_brain_outbox WHERE state IN ('PENDING','FAILED','DELIVERING') AND attempts<5 AND next_attempt_ms<=? AND (lease_until_ms IS NULL OR lease_until_ms<=?) ORDER BY rowid LIMIT 1").get(now, now);
      if (!row) return null;
      const lease = crypto.randomUUID();
      this.backend.db.prepare("UPDATE ow_onboarding_brain_outbox SET state='DELIVERING',attempts=attempts+1,lease_id=?,lease_until_ms=? WHERE id=?").run(lease, now + 30000, row.id);
      return { ...row, lease_id: lease, attempts: row.attempts + 1 };
    });
  }
  async deliver(row, token) {
    const payload = JSON.parse(row.payload_json);
    const marker = markerFor(row);
    const found = await this.call('/search', { token, body: { query: marker, project: PROJECT, domain: DOMAIN, strategy: null, limit: 5 } });
    let relativePath = found.results?.find(item => item.relative_path?.startsWith('reasoning/'))?.relative_path || null;
    let recordId = recordIdFromPath(relativePath);
    if (!recordId) {
      const created = await this.call('/reasoning', { token, body: {
        title: `${payload.title} [${marker}]`,
        question: `What validated Ocean onboarding milestone was recorded for ${payload.strategy_id}?`,
        analysis_summary: payload.summary,
        conclusion: `${payload.conclusion}\n\nOcean receipt: ${payload.milestone_id}. Payload: ${payload.receipt_hash || payload.payload_hash || row.payload_hash}. Marker: ${marker}.`,
        project: PROJECT, domain: DOMAIN, strategy: null, status: 'needs-review',
      } });
      recordId = created.id;
      relativePath = created.relative_path;
    }
    requireThat(recordId && relativePath, 503, 'ONBOARDING_BRAIN_RECEIPT_MISSING');
    const readback = await this.call(`/reasoning/${recordId}`, { token });
    const readbackPath = readback?.relative_path || readback?.record?.relative_path;
    requireThat(readback?.record?.id === recordId && readbackPath === relativePath && readback.record.content?.includes(marker), 503, 'ONBOARDING_BRAIN_READBACK_MISMATCH');
    return { record_id: recordId, relative_path: relativePath };
  }
  acknowledge(row, receipt) {
    this.backend.store.transaction(() => {
      const current = this.backend.db.prepare('SELECT * FROM ow_onboarding_brain_outbox WHERE id=?').get(row.id);
      requireThat(current?.state === 'DELIVERING' && current.lease_id === row.lease_id, 409, 'ONBOARDING_BRAIN_LEASE_CONFLICT');
      const now = new Date().toISOString();
      this.backend.db.prepare("UPDATE ow_onboarding_brain_outbox SET state='ACKNOWLEDGED',lease_id=NULL,lease_until_ms=NULL,brain_record_id=?,brain_relative_path=?,last_error=NULL,acknowledged_at_utc=? WHERE id=?")
        .run(receipt.record_id, receipt.relative_path, now, row.id);
      this.backend.event(row.strategy_id, 'onboarding.brain.acknowledged', SYSTEM_ACTOR, { outbox_id: row.id, milestone_id: row.milestone_id, brain_record_id: receipt.record_id, brain_relative_path: receipt.relative_path });
    });
  }
  fail(row, error) {
    const message = safeError(error);
    this.backend.store.transaction(() => {
      const current = this.backend.db.prepare('SELECT * FROM ow_onboarding_brain_outbox WHERE id=?').get(row.id);
      if (!current || current.state !== 'DELIVERING' || current.lease_id !== row.lease_id) return;
      const terminal = row.attempts >= 5;
      this.backend.db.prepare("UPDATE ow_onboarding_brain_outbox SET state=?,next_attempt_ms=?,lease_id=NULL,lease_until_ms=NULL,last_error=? WHERE id=?")
        .run(terminal ? 'DEAD_LETTER' : 'FAILED', Date.now() + Math.min(60000, 1000 * 2 ** row.attempts), message, row.id);
      this.backend.event(row.strategy_id, 'onboarding.brain.failed', SYSTEM_ACTOR, { outbox_id: row.id, milestone_id: row.milestone_id, terminal, error: message });
    });
    this.lastError = message;
  }
  async flushOnce() {
    if (!this.enabled || this.running) return this.status();
    this.running = true;
    try {
      const token = this.token();
      await this.verifyIdentity(token);
      let row;
      while ((row = this.claim())) {
        try {
          const receipt = await this.deliver(row, token);
          this.acknowledge(row, receipt);
          this.lastSuccessUtc = new Date().toISOString();
          this.lastError = null;
        } catch (error) { this.fail(row, error); }
      }
      return this.status();
    } finally { this.running = false; }
  }
}

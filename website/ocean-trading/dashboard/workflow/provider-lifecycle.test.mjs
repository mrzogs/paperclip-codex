import assert from 'node:assert/strict';
import test from 'node:test';
import { identityProjection, identityReadback, validateIdentityProbe } from './provider-lifecycle.mjs';

const identity = {
  identity_id: 'test-cicd-vwap-pull-back-replay-two-v013-telemetry',
  role: 'TELEMETRY',
  namespace: 'TEST',
  audience: 'Ocean workflow TEST',
  scopes: ['read', 'event.write', 'health.write'],
  strategy_ids: ['cicd-vwap-pull-back-strategy'],
  instance_ids: ['test-cicd-vwap-pull-back-replay-two-v013'],
  factual_binding_hash: null,
  credential_version: 1,
  expires_at_utc: '2026-10-31T23:59:59Z',
  revoked: false,
};

test('identity readback canonicalizes equivalent ISO timestamps for exact probe comparison', () => {
  const actor = { id: identity.identity_id, role: identity.role, namespace: identity.namespace, scopes: identity.scopes };
  const result = identityReadback({ identities: [{ ...identity, expires_at_utc: new Date('2026-10-31T23:59:59.000Z') }] }, actor, 'TEST');
  assert.equal(result.identity.expires_at_utc, '2026-10-31T23:59:59.000Z');
  assert.equal(identityProjection(identity).expires_at_utc, '2026-10-31T23:59:59.000Z');
  assert.equal(validateIdentityProbe({ ...result, identity: { ...result.identity, expires_at_utc: new Date(result.identity.expires_at_utc) } }, identity).schema_version, result.schema_version);
});

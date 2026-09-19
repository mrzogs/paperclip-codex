import { objectHash, requireThat, ROLES } from './common.mjs';

// Includes revoked/expired tombstones. Renewal does not allocate another slot.
export const MAX_SERVICE_IDENTITIES = 64;
export function validateIdentityCapacity(identities) {
  requireThat(Array.isArray(identities) && identities.length <= MAX_SERVICE_IDENTITIES, 503, 'IDENTITY_REGISTRY_CAPACITY_REACHED');
}
export function identityProbePath(namespace) {
  requireThat(['TEST', 'OPERATIONAL'].includes(namespace), 403, 'VERIFIED_NAMESPACE_REQUIRED');
  return namespace === 'OPERATIONAL' ? '/api/workflow/operational/v1/identity' : '/api/workflow/identity/v1';
}
export function identityProjection(identity) {
  return { id: identity.identity_id, role: identity.role, namespace: identity.namespace,
    audience: identity.audience, scopes: identity.scopes || ROLES[identity.role], strategy_ids: identity.strategy_ids,
    instance_ids: identity.instance_ids, factual_binding_hash: identity.factual_binding_hash ?? null,
    credential_version: identity.credential_version || 1, expires_at_utc: identity.expires_at_utc };
}
export function identityReadback(config, actor, namespace) {
  requireThat(actor.role !== 'HUMAN' && actor.namespace === namespace, 403, 'IDENTITY_NAMESPACE_MISMATCH');
  requireThat(actor.scopes.includes('read'), 403, 'WRONG_ACTION_SCOPE');
  const identity = config.identities.find(row => row.identity_id === actor.id);
  requireThat(identity && !identity.revoked && Date.parse(identity.expires_at_utc) > Date.now(), 401, 'EXPIRED_OR_REVOKED_CREDENTIAL');
  return { schema_version: 'ocean-service-identity/v1', identity: identityProjection(identity),
    operational_ingestion: 'OFF', live_real: 'DISABLED', approval_authority: false };
}
export function validateIdentityProbe(result, identity) {
  requireThat(result?.schema_version === 'ocean-service-identity/v1' &&
    objectHash(result.identity) === objectHash(identityProjection(identity)) &&
    result.operational_ingestion === 'OFF' && result.live_real === 'DISABLED' && result.approval_authority === false,
  503, 'IDENTITY_PROBE_MISMATCH');
  return result;
}
export function factualReadback(state, instanceId) {
  const binding = state.config.operational_factual_bindings?.find(row => row.instance.execution_instance_id === instanceId);
  requireThat(binding?.state === 'VERIFIED_FACTS_ONLY' && binding.operational_enabled === false, 404, 'FACTUAL_BINDING_NOT_FOUND');
  const { binding_hash, ...payload } = binding;
  requireThat(binding_hash === objectHash(payload), 409, 'FACTUAL_BINDING_HASH_CONFLICT');
  return { schema_version: 'ocean-factual-registration-readback/v1', registry_revision: state.revision, binding };
}

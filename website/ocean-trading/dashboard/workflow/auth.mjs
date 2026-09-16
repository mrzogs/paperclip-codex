import { randomBytes, scryptSync } from "node:crypto";
import { ROLES, digest, equalSecret, future, id, requireThat, strategyId } from "./common.mjs";

// Issuance is a local operator API, never an HTTP/browser response. Values go to injected environment only.
export function issueOceanIdentity(identity, environment, expiresAtUtc) {
  requireThat(ROLES[identity.role], 422, "UNKNOWN_SERVICE_ROLE");
  requireThat(identity.namespace === "TEST" || (identity.namespace === 'OPERATIONAL' && identity.audience === 'Ocean workflow operational v1' && /^sha256:[a-f0-9]{64}$/.test(identity.factual_binding_hash || '')), 403, "VERIFIED_NAMESPACE_REQUIRED");
  id(identity.identity_id);
  requireThat(/^OCEAN_[A-Z0-9_]+_TOKEN$/.test(identity.credential_ref), 422, "OCEAN_SECRET_REFERENCE_REQUIRED");
  requireThat(Array.isArray(identity.strategy_ids) && identity.strategy_ids.length > 0, 422, "EXACT_SCOPE_REQUIRED");
  requireThat(Array.isArray(identity.instance_ids) && identity.instance_ids.length > 0, 422, "EXACT_SCOPE_REQUIRED");
  identity.strategy_ids.forEach(strategyId);
  identity.instance_ids.forEach((value) => {id(value, identity.namespace==='TEST');requireThat(identity.namespace==='TEST' || !value.startsWith('test-'),403,'TEST_IDENTITY_PROMOTION_REJECTED');});
  if (identity.scopes) requireThat(Array.isArray(identity.scopes) && identity.scopes.length && identity.scopes.every(scope => ROLES[identity.role].includes(scope)), 422, "WRONG_ACTION_SCOPE");
  requireThat(future(expiresAtUtc), 422, "CREDENTIAL_EXPIRY_REQUIRED");
  requireThat(Date.parse(expiresAtUtc) <= Date.now() + 90 * 86400000, 422, 'CREDENTIAL_LIFETIME_EXCEEDS_90_DAYS');
  const value = `ocean_service_v1.${identity.identity_id}.${randomBytes(32).toString("base64url")}`;
  environment[identity.credential_ref] = value;
  return { ...identity, provider: "OCEAN_TRADING", credential_hash: digest(value), expires_at_utc: expiresAtUtc, revoked: false };
}

export function passwordVerifier(password) {
  requireThat(typeof password === "string" && password.length >= 14 && password.length <= 256, 422, "PASSWORD_LENGTH_14_TO_256_REQUIRED");
  const salt = randomBytes(16).toString("hex");
  return `ocean_password_v1.${salt}.${scryptSync(password, salt, 32).toString("hex")}`;
}

export function humanBinding(config, environment) {
  if (config.browser?.state === 'UNENROLLED') return { state: 'UNENROLLED', hash: null };
  const ref = config.browser?.credential_ref;
  const secret = environment[ref];
  const valid = config.browser?.subject_id === 'wayne-ocean-ui' && /^OCEAN_[A-Z0-9_]+_SECRET$/.test(ref || '') &&
    typeof secret === 'string' && (/^ocean_password_v1\.[a-f0-9]{32}\.[a-f0-9]{64}$/.test(secret) || (!config.operator_managed && secret.startsWith('ocean_browser_v1.')));
  return valid ? { state: 'CONFIGURED', hash: digest(secret) } : { state: 'ERROR', hash: null };
}

function matchesBrowserCredential(input, stored) {
  if (!stored?.startsWith("ocean_password_v1.")) return equalSecret(input, stored);
  const [, salt, hash] = stored.split(".");
  return equalSecret(scryptSync(input, salt, 32).toString("hex"), hash);
}

export function issueTestBrowserSecret(environment, reference) {
  requireThat(/^OCEAN_[A-Z0-9_]+_SECRET$/.test(reference), 422, "OCEAN_SECRET_REFERENCE_REQUIRED");
  environment[reference] = `ocean_browser_v1.${randomBytes(32).toString("base64url")}`;
}

export class OceanAuth {
  constructor(config, store, environment) {
    this.config = config;
    this.store = store;
    this.environment = environment;
    requireThat(config.test_only === true, 503, "S20_TEST_ONLY");
    requireThat(Array.isArray(config.allowed_origins) && config.allowed_origins.length > 0, 503, "BROWSER_ORIGIN_UNBOUND");
    for (const origin of config.allowed_origins) {
      const url = new URL(origin);
      requireThat(url.origin === origin && (url.protocol === "https:" || ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)), 503, "UNSAFE_BROWSER_ORIGIN");
    }
    this.human = humanBinding(config, environment);
    requireThat(Array.isArray(config.identities) && config.identities.length <= 32, 503, "INVALID_SERVICE_IDENTITIES");
    if (!config.pending_services) requireThat(config.identities.length === 3 && new Set(config.identities.map((entry) => entry.role)).size === 3, 503, "THREE_SEPARATE_SERVICE_IDENTITIES_REQUIRED");
    else requireThat(Array.isArray(config.pending_services) && config.pending_services.every(entry => ROLES[entry.role] && typeof entry.due_step === "string"), 503, "INVALID_PENDING_SERVICES");
    requireThat(new Set(config.identities.map((entry) => entry.identity_id)).size === config.identities.length, 503, "DUPLICATE_IDENTITY");
    requireThat(new Set(config.identities.map((entry) => entry.credential_ref)).size === config.identities.length, 503, "SHARED_CREDENTIAL_REFERENCE_REJECTED");
    const values = [];
    this.bindingErrors = new Map();
    for (const identity of config.identities) {
      try {
      requireThat(identity.provider === "OCEAN_TRADING" && ['TEST','OPERATIONAL'].includes(identity.namespace) && ROLES[identity.role], 503, "INVALID_PROVIDER_IDENTITY");
      if (config.operator_managed) requireThat(identity.audience === (identity.namespace==='TEST'?'Ocean workflow TEST':'Ocean workflow operational v1') && identity.identity_id !== 'wayne-ocean-ui',503,'INVALID_OCEAN_AUDIENCE');
      if(identity.namespace==='OPERATIONAL')requireThat(config.operational_factual_bindings?.some(b=>b.binding_hash===identity.factual_binding_hash && b.strategy_id===identity.strategy_ids[0] && identity.strategy_ids.length===1 && identity.instance_ids.length===1 && b.instance.execution_instance_id===identity.instance_ids[0]),503,'FACTUAL_BINDING_REQUIRED');
      requireThat(/^OCEAN_[A-Z0-9_]+_TOKEN$/.test(identity.credential_ref) && identity.strategy_ids?.length && identity.instance_ids?.length, 503, "EXACT_SCOPE_REQUIRED");
      identity.strategy_ids.forEach(strategyId);
      identity.instance_ids.forEach((value) => {id(value,identity.namespace==='TEST');requireThat(identity.namespace==='TEST' || !value.startsWith('test-'),503,'TEST_IDENTITY_PROMOTION_REJECTED');});
      if (identity.scopes) requireThat(Array.isArray(identity.scopes) && identity.scopes.length && identity.scopes.every(scope => ROLES[identity.role].includes(scope)), 503, "WRONG_ACTION_SCOPE");
      const value = environment[identity.credential_ref];
      requireThat(typeof value === "string" && value.startsWith(`ocean_service_v1.${identity.identity_id}.`) && digest(value) === identity.credential_hash, 503, "PROVIDER_CREDENTIAL_UNRESOLVED");
      values.push(value);
      if (config.operator_managed) requireThat(store.identityCurrent(identity), 503, "IDENTITY_RECONCILIATION_REQUIRED");
      else store.registerIdentity(identity);
      } catch (error) {
        if (!config.operator_managed) throw error;
        this.bindingErrors.set(identity.identity_id, error.code || 'BINDING_INVALID');
      }
    }
    requireThat(new Set(values).size === values.length, 503, "SHARED_CREDENTIAL_VALUE_REJECTED");
    if (!config.operator_managed) requireThat(this.human.state === 'CONFIGURED', 503, 'WAYNE_BROWSER_SECRET_UNRESOLVED');
    this.browserHash = this.human.hash;
    if (this.browserHash) {
      try { store.bindBrowser(this.browserHash, config.operator_managed); }
      catch (error) { if (!config.operator_managed) throw error; this.human = { state: 'ERROR', hash: null }; this.browserHash = null; }
    }
    this.sessionTtlMs = 15 * 60 * 1000;
    this.loginFailures = new Map();
  }

  browserOrigin(request, mutation = false) {
    const hostAllowed = this.config.allowed_origins.some((origin) => new URL(origin).host === request.headers.host);
    requireThat(hostAllowed, 403, "HOST_REJECTED");
    if (mutation || request.headers.origin) requireThat(this.config.allowed_origins.includes(request.headers.origin), 403, "ORIGIN_REJECTED");
    requireThat(!request.headers["sec-fetch-site"] || ["same-origin", "none"].includes(request.headers["sec-fetch-site"]), 403, "CROSS_SITE_REJECTED");
  }

  readiness() {
    return { local_readiness: 'READY', integration_readiness: 'PENDING',
      machine_readiness: this.bindingErrors.size ? 'DEGRADED' : 'READY',
      human_readiness: this.human.state, human_acceptance_due: 'S33',
      pending_bindings: this.config.pending_services || [],
      bindings: this.config.identities.map(identity => ({ identity_id: identity.identity_id, role: identity.role,
        owner: identity.owner || identity.role, verification_only: identity.verification_only === true,
        state: identity.revoked ? 'REVOKED' : !future(identity.expires_at_utc) ? 'EXPIRED' : this.bindingErrors.has(identity.identity_id) || !this.store.identityCurrent(identity) ? 'ERROR' : identity.verification_state || 'CONFIGURED_NOT_VERIFIED',
        reason: this.bindingErrors.get(identity.identity_id) || null })) };
  }

  rejectForgedHeaders(request) {
    for (const header of ['x-actor-id','x-role','x-scope','x-strategy-id','x-instance-id','x-decision-by']) requireThat(!request.headers[header],403,'FORGED_AUTHORITY_HEADER');
  }

  login(request, input, response) {
    this.rejectForgedHeaders(request);
    this.browserOrigin(request, true);
    requireThat(this.human.state === 'CONFIGURED' && this.browserHash, 401, this.human.state === 'UNENROLLED' ? 'HUMAN_UNENROLLED' : 'HUMAN_ACCESS_UNAVAILABLE');
    requireThat(Object.keys(input).length === 1 && typeof input.credential === "string" && input.credential.length <= 256, 422, "INVALID_LOGIN_BODY");
    requireThat(this.store.browserCurrent(this.browserHash), 503, "BROWSER_RECOVERY_RELOAD_REQUIRED");
    const key = request.socket.remoteAddress;
    const failure = this.loginFailures.get(key);
    requireThat(!failure || failure.count < 5 || Date.now() > failure.until, 429, "LOGIN_RATE_LIMIT");
    if (!matchesBrowserCredential(input.credential, this.environment[this.config.browser.credential_ref])) {
      this.loginFailures.set(key, { count: (failure && Date.now() < failure.until ? failure.count : 0) + 1, until: Date.now() + 60_000 });
      requireThat(false, 401, "INVALID_BROWSER_CREDENTIAL");
    }
    this.loginFailures.delete(key);
    const session = randomBytes(32).toString("base64url");
    const csrf = randomBytes(32).toString("base64url");
    this.store.saveSession(digest(session), digest(csrf), this.config.browser.subject_id, Date.now() + this.sessionTtlMs);
    const secure = request.headers.origin.startsWith("https:") ? "; Secure" : "";
    response.setHeader("Set-Cookie", `ocean_workflow_session=${session}; Path=/api/workflow; HttpOnly; SameSite=Strict; Max-Age=900${secure}`);
    return { subject_id: this.config.browser.subject_id, role: "HUMAN", csrf_token: csrf, expires_in_seconds: 900 };
  }

  authenticate(request, mutation) {
    requireThat(this.config.allowed_origins.some(origin => new URL(origin).host === request.headers.host),403,'HOST_REJECTED');
    for (const header of ["x-actor-id", "x-role", "x-scope", "x-strategy-id", "x-instance-id", "x-decision-by"]) {
      requireThat(!request.headers[header], 403, "FORGED_AUTHORITY_HEADER");
    }
    if (request.headers.authorization) {
      requireThat(!request.headers.origin && !request.headers.cookie, 403, "BROWSER_SERVICE_TOKEN_REJECTED");
      const match = /^Bearer (ocean_service_v1\.[A-Za-z0-9_.:-]+)$/.exec(request.headers.authorization);
      requireThat(match, 401, "INVALID_OCEAN_CREDENTIAL");
      const identity = this.config.identities.find((item) => !this.bindingErrors.has(item.identity_id) && equalSecret(match[1], this.environment[item.credential_ref]));
      requireThat(identity && this.store.identityCurrent(identity), 401, "INVALID_OCEAN_CREDENTIAL");
      requireThat(!identity.revoked && future(identity.expires_at_utc), 401, "EXPIRED_OR_REVOKED_CREDENTIAL");
      return { id: identity.identity_id, role: identity.role, scopes: identity.scopes || ROLES[identity.role], strategyIds: identity.strategy_ids, instanceIds: identity.instance_ids, namespace:identity.namespace, audience:identity.audience, factualBindingHash:identity.factual_binding_hash };
    }
    this.browserOrigin(request, mutation);
    requireThat(this.human.state === 'CONFIGURED' && this.browserHash, 401, this.human.state === 'UNENROLLED' ? 'HUMAN_UNENROLLED' : 'HUMAN_ACCESS_UNAVAILABLE');
    requireThat(this.store.browserCurrent(this.browserHash), 401, "SESSION_EXPIRED_OR_INVALID");
    const cookie = /(?:^|;\s*)ocean_workflow_session=([A-Za-z0-9_-]+)/.exec(request.headers.cookie || "");
    requireThat(cookie, 401, "AUTHENTICATION_REQUIRED");
    const session = this.store.getSession(digest(cookie[1]));
    requireThat(session && session.expires_ms > Date.now() && session.subject_id === this.config.browser.subject_id, 401, "SESSION_EXPIRED_OR_INVALID");
    if (mutation) requireThat(equalSecret(digest(String(request.headers["x-csrf-token"] || "")), session.csrf_hash), 403, "CSRF_REJECTED");
    return { id: session.subject_id, role: "HUMAN", scopes: ["*"], strategyIds: null, instanceIds: null };
  }

  sessionInfo(request, actor) {
    requireThat(actor.role === "HUMAN", 403, "WAYNE_BROWSER_ONLY");
    const cookie = /(?:^|;\s*)ocean_workflow_session=([A-Za-z0-9_-]+)/.exec(request.headers.cookie || "");
    const session = this.store.getSession(digest(cookie[1]));
    return { subject_id: session.subject_id, role: "HUMAN", expires_at_utc: new Date(session.expires_ms).toISOString() };
  }

  logout(request, actor, response) {
    requireThat(actor.role === "HUMAN", 403, "WAYNE_BROWSER_ONLY");
    const cookie = /(?:^|;\s*)ocean_workflow_session=([A-Za-z0-9_-]+)/.exec(request.headers.cookie || "");
    this.store.db.prepare("DELETE FROM ow_sessions WHERE session_hash=?").run(digest(cookie[1]));
    response.setHeader("Set-Cookie", "ocean_workflow_session=; Path=/api/workflow; HttpOnly; SameSite=Strict; Max-Age=0");
  }
}

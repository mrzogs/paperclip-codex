import { randomUUID } from "node:crypto";
import { exactKeys, id, noSecrets, objectHash, requireThat } from "./common.mjs";

export const REPLAY_TWO_BOOKING_RESOURCE = "sierra-replay-two:primary";
export const REPLAY_TWO_EXECUTABLE = "D:\\Trading\\SierraChart-Replay Two\\SierraChart_64.exe";
export const REPLAY_TWO_OPERATION_SCOPE = Object.freeze(["Stage", "VerifySelection", "Rollback"]);
export const REPLAY_TWO_RECEIPT_SCHEMA = "oql.replay-two-booking-receipt/v1";
export const REPLAY_TWO_ACQUIRE_SCHEMA = "oql.replay-two-booking-register-request/v1";
export const REPLAY_TWO_TERMINAL_SCHEMA = "oql.replay-two-booking-terminal-request/v1";

const HASH = /^sha256:[0-9a-f]{64}$/;
const UTC_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_GENERATION = Number.MAX_SAFE_INTEGER;
const ACQUIRE_KEYS = [
  "schema", "resource_key", "owner_project", "owner_agent_id", "approval_id",
  "approval_snapshot_sha256", "package_sha256", "instance_executable", "operation_scope",
  "requested_expires_utc", "expected_prior_generation", "expected_prior_receipt_hash",
];
const TERMINAL_KEYS = ["schema", "generation", "receipt_hash", "reason"];
const APPROVAL_BINDING_KEYS = [
  "identity_id", "owner_project", "approval_id", "approval_snapshot_sha256",
  "package_sha256", "expires_utc",
];

function isUtcMillis(value) {
  if (typeof value !== "string" || !UTC_MILLIS.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function hash(value, code) {
  requireThat(typeof value === "string" && HASH.test(value), 422, code);
  return value;
}

function utc(value, code) {
  requireThat(isUtcMillis(value), 422, code);
  return Date.parse(value);
}

function sameScope(value) {
  return Array.isArray(value)
    && value.length === REPLAY_TWO_OPERATION_SCOPE.length
    && value.every((item, index) => item === REPLAY_TWO_OPERATION_SCOPE[index]);
}

function receiptCore(receipt) {
  return {
    schema: receipt.schema,
    booking_id: receipt.booking_id,
    resource_key: receipt.resource_key,
    generation: receipt.generation,
    status: receipt.status,
    owner_project: receipt.owner_project,
    owner_agent_id: receipt.owner_agent_id,
    approval_id: receipt.approval_id,
    approval_snapshot_sha256: receipt.approval_snapshot_sha256,
    package_sha256: receipt.package_sha256,
    instance_executable: receipt.instance_executable,
    operation_scope: receipt.operation_scope,
    acquired_utc: receipt.acquired_utc,
    expires_utc: receipt.expires_utc,
    prior_receipt_hash: receipt.prior_receipt_hash,
  };
}

function eventCore(event) {
  const { event_hash: ignored, ...core } = event;
  return core;
}

function effectiveStatus(terminalEvent, expired) {
  return terminalEvent?.kind || (expired ? "EXPIRED" : "ACTIVE");
}

export class ReplayTwoBookingRegistry {
  constructor(backend) {
    this.backend = backend;
    this.db = backend.db;
    this.config = backend.config.replay_two_booking_registry || { enabled: false };
    this.now = () => Date.now();
    if (!this.config.enabled) return;
    requireThat(this.config.test_only === true, 503, "BOOKING_TEST_ONLY_REQUIRED");
    requireThat(this.config.resource_key === REPLAY_TWO_BOOKING_RESOURCE, 503, "BOOKING_RESOURCE_BINDING_REQUIRED");
    requireThat(this.config.instance_executable === REPLAY_TWO_EXECUTABLE, 503, "BOOKING_EXECUTABLE_BINDING_REQUIRED");
    requireThat(Number.isSafeInteger(this.config.min_ttl_ms) && this.config.min_ttl_ms >= 1000, 503, "BOOKING_TTL_BOUND_REQUIRED");
    requireThat(Number.isSafeInteger(this.config.max_ttl_ms) && this.config.max_ttl_ms >= this.config.min_ttl_ms && this.config.max_ttl_ms <= 900000, 503, "BOOKING_TTL_BOUND_REQUIRED");
    requireThat(Array.isArray(this.config.issuers) && this.config.issuers.length > 0, 503, "BOOKING_ISSUER_BINDING_REQUIRED");
    requireThat(this.config.issuers.every((entry) => entry && typeof entry.owner_project === "string" && /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(entry.owner_project) && id(entry.identity_id)), 503, "BOOKING_ISSUER_BINDING_REQUIRED");
    requireThat(new Set(this.config.issuers.map((entry) => entry.identity_id)).size === this.config.issuers.length, 503, "BOOKING_ISSUER_BINDING_REQUIRED");
    requireThat(Array.isArray(this.config.approval_bindings) && this.config.approval_bindings.length > 0, 503, "BOOKING_APPROVAL_BINDING_REQUIRED");
    requireThat(this.config.approval_bindings.every((entry) => {
      if (!entry || Object.keys(entry).length !== APPROVAL_BINDING_KEYS.length || !APPROVAL_BINDING_KEYS.every((key) => Object.hasOwn(entry, key))) return false;
      const issuer = this.config.issuers.find((candidate) => candidate.identity_id === entry.identity_id && candidate.owner_project === entry.owner_project);
      return Boolean(issuer)
        && typeof entry.approval_id === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(entry.approval_id)
        && HASH.test(entry.approval_snapshot_sha256)
        && HASH.test(entry.package_sha256)
        && isUtcMillis(entry.expires_utc);
    }), 503, "BOOKING_APPROVAL_BINDING_REQUIRED");
    requireThat(new Set(this.config.approval_bindings.map((entry) => `${entry.identity_id}\0${entry.approval_id}`)).size === this.config.approval_bindings.length, 503, "BOOKING_APPROVAL_BINDING_REQUIRED");
    requireThat(Array.isArray(this.config.reader_identity_ids) && this.config.reader_identity_ids.every((entry) => id(entry)), 503, "BOOKING_READER_BINDING_REQUIRED");
  }

  available() {
    requireThat(this.config.enabled === true, 503, "BOOKING_AUTHORITY_UNAVAILABLE");
  }

  issuer(actor) {
    this.available();
    requireThat(actor.role === "STRATEGY" && actor.namespace === "OPERATIONAL" && actor.scopes.includes("booking.issue"), 403, "BOOKING_ISSUER_REQUIRED");
    const binding = this.config.issuers.find((entry) => entry.identity_id === actor.id);
    requireThat(binding, 403, "BOOKING_ISSUER_REQUIRED");
    return binding;
  }

  authorizeRead(actor, receipt = null) {
    this.available();
    if (actor.role === "HUMAN") return;
    requireThat(actor.namespace === "OPERATIONAL" && actor.scopes.includes("booking.read"), 403, "BOOKING_READ_SCOPE_REQUIRED");
    const allowed = this.config.reader_identity_ids.includes(actor.id) || this.config.issuers.some((entry) => entry.identity_id === actor.id);
    requireThat(allowed, 403, "BOOKING_READER_REQUIRED");
    if (receipt && actor.role === "STRATEGY") requireThat(receipt.owner_agent_id === actor.id, 403, "BOOKING_OWNER_CONFLICT");
  }

  readNonce(value) {
    this.available();
    requireThat(typeof value === "string", 422, "BOOKING_READ_NONCE_REQUIRED");
    return id(value);
  }

  latest(resourceKey) {
    return this.db.prepare("SELECT payload_json FROM ow_replay_two_bookings WHERE resource_key=? ORDER BY generation DESC LIMIT 1").get(resourceKey);
  }

  terminal(bookingId) {
    const row = this.db.prepare("SELECT payload_json FROM ow_replay_two_booking_events WHERE booking_id=? ORDER BY rowid DESC LIMIT 1").get(bookingId);
    return row ? JSON.parse(row.payload_json) : null;
  }

  exactReadback(receipt) {
    const terminalEvent = this.terminal(receipt.booking_id);
    const expired = this.now() >= Date.parse(receipt.expires_utc);
    return {
      schema: "oql.replay-two-booking-readback/v1",
      receipt,
      terminal_event: terminalEvent,
      effective_status: effectiveStatus(terminalEvent, expired),
      observed_at_utc: new Date(this.now()).toISOString(),
    };
  }

  currentState(receipt) {
    const terminalEvent = this.terminal(receipt.booking_id);
    if (terminalEvent || this.now() >= Date.parse(receipt.expires_utc)) return null;
    return {
      booking_id: receipt.booking_id,
      generation: receipt.generation,
      receipt_hash: receipt.receipt_hash,
      effective_status: "ACTIVE",
      expires_utc: receipt.expires_utc,
      owner_project: receipt.owner_project,
      owner_agent_id: receipt.owner_agent_id,
      approval_id: receipt.approval_id,
      package_sha256: receipt.package_sha256,
      instance_executable: receipt.instance_executable,
      operation_scope: [...receipt.operation_scope],
    };
  }

  registerResponse(receipt) {
    return {
      schema: "oql.replay-two-booking-register-response/v1",
      receipt,
      current: {
        resource_key: receipt.resource_key,
        booking_id: receipt.booking_id,
        generation: receipt.generation,
        receipt_hash: receipt.receipt_hash,
        effective_status: "ACTIVE",
        expires_utc: receipt.expires_utc,
      },
      observed_at_utc: new Date(this.now()).toISOString(),
    };
  }

  expireIfNeeded(receipt) {
    if (this.terminal(receipt.booking_id) || this.now() < Date.parse(receipt.expires_utc)) return;
    this.insertTerminal(receipt, "EXPIRED", "Server-observed lease expiry", "ocean-booking-registry");
  }

  acquire(actor, input) {
    const binding = this.issuer(actor);
    exactKeys(input, ACQUIRE_KEYS);
    noSecrets(input, this.backend.environment);
    requireThat(input.schema === REPLAY_TWO_ACQUIRE_SCHEMA, 422, "BOOKING_SCHEMA_REQUIRED");
    requireThat(input.resource_key === this.config.resource_key, 422, "BOOKING_RESOURCE_CONFLICT");
    requireThat(input.instance_executable === this.config.instance_executable, 422, "BOOKING_EXECUTABLE_CONFLICT");
    requireThat(input.owner_project === binding.owner_project && input.owner_agent_id === actor.id, 403, "BOOKING_OWNER_CONFLICT");
    id(input.approval_id);
    hash(input.approval_snapshot_sha256, "BOOKING_APPROVAL_SNAPSHOT_HASH_REQUIRED");
    hash(input.package_sha256, "BOOKING_PACKAGE_HASH_REQUIRED");
    requireThat(sameScope(input.operation_scope), 422, "BOOKING_OPERATION_SCOPE_CONFLICT");
    const now = this.now();
    // This pins the approved artifact identity for booking acquisition. Physical
    // clients still revalidate live approval before and after every mutation.
    const approvalBinding = this.config.approval_bindings.find((entry) => entry.identity_id === actor.id
      && entry.owner_project === input.owner_project
      && entry.approval_id === input.approval_id
      && entry.approval_snapshot_sha256 === input.approval_snapshot_sha256
      && entry.package_sha256 === input.package_sha256);
    requireThat(approvalBinding, 403, "BOOKING_APPROVAL_BINDING_REQUIRED");
    const approvalExpires = Date.parse(approvalBinding.expires_utc);
    requireThat(now < approvalExpires, 403, "BOOKING_APPROVAL_BINDING_EXPIRED");
    const expires = utc(input.requested_expires_utc, "BOOKING_EXPIRY_REQUIRED");
    requireThat(expires - now >= this.config.min_ttl_ms && expires - now <= this.config.max_ttl_ms, 422, "BOOKING_TTL_BOUND_REJECTED");
    requireThat(expires <= approvalExpires, 422, "BOOKING_TTL_EXCEEDS_APPROVAL");
    const first = input.expected_prior_generation === null && input.expected_prior_receipt_hash === null;
    if (!first) {
      requireThat(Number.isSafeInteger(input.expected_prior_generation) && input.expected_prior_generation >= 1 && input.expected_prior_generation <= MAX_GENERATION, 422, "BOOKING_PRIOR_GENERATION_REQUIRED");
      hash(input.expected_prior_receipt_hash, "BOOKING_PRIOR_RECEIPT_HASH_REQUIRED");
    } else requireThat(input.expected_prior_generation === null && input.expected_prior_receipt_hash === null, 422, "BOOKING_PRIOR_CAS_PAIR_REQUIRED");

    return this.backend.store.transaction(() => {
      const latestRow = this.latest(input.resource_key);
      const latest = latestRow ? JSON.parse(latestRow.payload_json) : null;
      if (latest) this.expireIfNeeded(latest);
      const active = latest && !this.terminal(latest.booking_id) && this.now() < Date.parse(latest.expires_utc);
      requireThat(!active, 409, "BOOKING_RESOURCE_BUSY");
      if (!latest) requireThat(first, 409, "BOOKING_PRIOR_CAS_CONFLICT");
      else requireThat(!first && input.expected_prior_generation === latest.generation && input.expected_prior_receipt_hash === latest.receipt_hash, 409, "BOOKING_PRIOR_CAS_CONFLICT");
      const generation = latest ? latest.generation + 1 : 1;
      requireThat(Number.isSafeInteger(generation) && generation <= MAX_GENERATION, 409, "BOOKING_GENERATION_EXHAUSTED");
      const receipt = {
        schema: REPLAY_TWO_RECEIPT_SCHEMA,
        booking_id: `replay-two-booking-${generation}-${randomUUID()}`,
        resource_key: input.resource_key,
        generation,
        status: "ACTIVE",
        owner_project: input.owner_project,
        owner_agent_id: input.owner_agent_id,
        approval_id: input.approval_id,
        approval_snapshot_sha256: input.approval_snapshot_sha256,
        package_sha256: input.package_sha256,
        instance_executable: input.instance_executable,
        operation_scope: [...input.operation_scope],
        acquired_utc: new Date(now).toISOString(),
        expires_utc: input.requested_expires_utc,
        prior_receipt_hash: latest?.receipt_hash || null,
        receipt_hash: null,
        registry_comment_id: null,
        registry_body_sha256: null,
      };
      receipt.receipt_hash = objectHash(receiptCore(receipt));
      this.db.prepare("INSERT INTO ow_replay_two_bookings(booking_id,resource_key,generation,receipt_hash,owner_project,owner_agent_id,expires_ms,payload_json) VALUES(?,?,?,?,?,?,?,?)")
        .run(receipt.booking_id, receipt.resource_key, receipt.generation, receipt.receipt_hash, receipt.owner_project, receipt.owner_agent_id, expires, JSON.stringify(receipt));
      return this.registerResponse(receipt);
    });
  }

  exact(actor, bookingId) {
    this.available();
    const row = this.db.prepare("SELECT payload_json FROM ow_replay_two_bookings WHERE booking_id=?").get(id(bookingId));
    requireThat(row, 404, "BOOKING_NOT_FOUND");
    const receipt = JSON.parse(row.payload_json);
    this.authorizeRead(actor, receipt);
    return this.exactReadback(receipt);
  }

  current(actor, resourceKey) {
    this.available();
    requireThat(resourceKey === this.config.resource_key, 404, "BOOKING_RESOURCE_NOT_FOUND");
    const row = this.latest(resourceKey);
    requireThat(row, 404, "BOOKING_NOT_FOUND");
    const receipt = JSON.parse(row.payload_json);
    this.authorizeRead(actor, receipt);
    return {
      schema: "oql.replay-two-booking-current/v1",
      resource_key: receipt.resource_key,
      current: this.currentState(receipt),
      observed_at_utc: new Date(this.now()).toISOString(),
    };
  }

  renew(actor, input) {
    this.issuer(actor);
    noSecrets(input, this.backend.environment);
    requireThat(false, 409, "BOOKING_RENEWAL_UNAVAILABLE");
  }

  insertTerminal(receipt, status, reason, actorId) {
    const event = {
      schema: "oql.replay-two-booking-terminal-event/v1",
      event_id: `replay-two-booking-event-${randomUUID()}`,
      booking_id: receipt.booking_id,
      resource_key: receipt.resource_key,
      generation: receipt.generation,
      receipt_hash: receipt.receipt_hash,
      kind: status,
      actor_type: status === "RELEASED" ? "STRATEGY" : status === "REVOKED" ? "HUMAN" : "OCEAN_SYSTEM",
      reason,
      actor_id: actorId,
      occurred_at_utc: new Date(this.now()).toISOString(),
      event_hash: null,
    };
    event.event_hash = objectHash(eventCore(event));
    this.db.prepare("INSERT INTO ow_replay_two_booking_events(event_id,booking_id,resource_key,generation,status,event_hash,payload_json) VALUES(?,?,?,?,?,?,?)")
      .run(event.event_id, event.booking_id, event.resource_key, event.generation, event.kind, event.event_hash, JSON.stringify(event));
    return event;
  }

  finish(kind, actor, input, bookingId) {
    this.available();
    exactKeys(input, TERMINAL_KEYS);
    noSecrets(input, this.backend.environment);
    requireThat(input.schema === REPLAY_TWO_TERMINAL_SCHEMA, 422, "BOOKING_TERMINAL_SCHEMA_REQUIRED");
    requireThat(Number.isSafeInteger(input.generation) && input.generation >= 1 && input.generation <= MAX_GENERATION, 422, "BOOKING_GENERATION_REQUIRED");
    hash(input.receipt_hash, "BOOKING_RECEIPT_HASH_REQUIRED");
    requireThat(typeof input.reason === "string" && input.reason.trim().length >= 1 && input.reason.length <= 1024, 422, "BOOKING_TERMINAL_REASON_REQUIRED");
    const row = this.db.prepare("SELECT payload_json FROM ow_replay_two_bookings WHERE generation=? AND receipt_hash=?").get(input.generation, input.receipt_hash);
    requireThat(row, 404, "BOOKING_NOT_FOUND");
    const receipt = JSON.parse(row.payload_json);
    requireThat(id(bookingId) === receipt.booking_id, 409, "BOOKING_PIN_CONFLICT");
    if (kind === "RELEASED") {
      const binding = this.issuer(actor);
      requireThat(binding.owner_project === receipt.owner_project && actor.id === receipt.owner_agent_id, 403, "BOOKING_OWNER_CONFLICT");
    } else requireThat(kind === "REVOKED" && actor.role === "HUMAN" && actor.id === "wayne-ocean-ui", 403, "BOOKING_REVOKER_REQUIRED");
    return this.backend.store.transaction(() => {
      const existing = this.terminal(receipt.booking_id);
      if (existing) {
        requireThat(existing.kind === kind && existing.reason === input.reason && existing.actor_id === actor.id, 409, "BOOKING_ALREADY_TERMINAL");
        return { schema: "oql.replay-two-booking-terminal-response/v1", event: existing, current: null, observed_at_utc: new Date(this.now()).toISOString() };
      }
      const event = this.insertTerminal(receipt, kind, input.reason, actor.id);
      return { schema: "oql.replay-two-booking-terminal-response/v1", event, current: null, observed_at_utc: new Date(this.now()).toISOString() };
    });
  }
}

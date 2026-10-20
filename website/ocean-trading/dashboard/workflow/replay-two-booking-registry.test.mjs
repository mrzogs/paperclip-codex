import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkflowBackend } from "./backend.mjs";
import { issueOceanIdentity, issueTestBrowserSecret } from "./auth.mjs";
import { objectHash } from "./common.mjs";
import { WorkflowStore } from "./store.mjs";
import {
  REPLAY_TWO_ACQUIRE_SCHEMA,
  REPLAY_TWO_BOOKING_RESOURCE,
  REPLAY_TWO_EXECUTABLE,
  REPLAY_TWO_OPERATION_SCOPE,
  REPLAY_TWO_TERMINAL_SCHEMA,
} from "./replay-two-booking-registry.mjs";

const OWNER_PROJECT = "oql-vwap-wave-pullback";
const STRATEGY = "vwap_wave_pullback_balanced_nasdaq_v0434";
const INSTANCE = "cicd-vwap-pull-back-strategy:replay-two:chart1";
const FACTUAL_BINDING = `sha256:${"f".repeat(64)}`;
const APPROVAL_HASH = `sha256:${"a".repeat(64)}`;
const PACKAGE_HASH = `sha256:${"b".repeat(64)}`;
const FIXED_NOW = Date.parse("2026-10-20T16:00:00.000Z");

function receiptCore(receipt) {
  return Object.fromEntries([
    "schema", "booking_id", "resource_key", "generation", "status", "owner_project",
    "owner_agent_id", "approval_id", "approval_snapshot_sha256", "package_sha256",
    "instance_executable", "operation_scope", "acquired_utc", "expires_utc", "prior_receipt_hash",
  ].map((key) => [key, receipt[key]]));
}

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ocean-replay-booking-"));
  const environment = {};
  let backend;
  const server = http.createServer((request, response) => void backend.handle(request, response, new URL(request.url, `http://${request.headers.host}`)));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const binding = { binding_hash: FACTUAL_BINDING, strategy_id: STRATEGY, instance: { execution_instance_id: INSTANCE } };
  const definitions = [
    ["BRAIN", "ocean-booking-brain", ["read"]],
    ["TELEMETRY", "ocean-booking-telemetry", ["booking.read"]],
    ["STRATEGY", "ocean-booking-oql", ["booking.read", "booking.issue"]],
  ];
  const identities = definitions.map(([role, identityId, scopes]) => issueOceanIdentity({
    identity_id: identityId,
    role,
    namespace: "OPERATIONAL",
    audience: "Ocean workflow operational v1",
    factual_binding_hash: FACTUAL_BINDING,
    credential_ref: `OCEAN_${role}_TOKEN`,
    strategy_ids: [STRATEGY],
    instance_ids: [INSTANCE],
    scopes,
  }, environment, new Date(Date.now() + 3600000).toISOString()));
  const config = {
    db_file: path.join(directory, "workflow.sqlite"),
    test_only: true,
    contract_release: "2.1.0",
    allowed_origins: [base],
    python_executable: process.env.OCEAN_TRADING_PYTHON || "python",
    browser: { subject_id: "wayne-ocean-ui", credential_ref: "OCEAN_WAYNE_BROWSER_SECRET" },
    identities,
    operational_factual_bindings: [binding],
    brain_submission: "OFF",
    live_real: "DISABLED",
    dispatch_worker: "OFF",
    replay_two_booking_registry: {
      enabled: true,
      test_only: true,
      resource_key: REPLAY_TWO_BOOKING_RESOURCE,
      instance_executable: REPLAY_TWO_EXECUTABLE,
      min_ttl_ms: 1000,
      max_ttl_ms: 120000,
      issuers: [{ identity_id: "ocean-booking-oql", owner_project: OWNER_PROJECT }],
      approval_bindings: [{
        identity_id: "ocean-booking-oql",
        owner_project: OWNER_PROJECT,
        approval_id: "9f8cd5c6-948a-4818-9fad-5bd56d00cb23",
        approval_snapshot_sha256: APPROVAL_HASH,
        package_sha256: PACKAGE_HASH,
        expires_utc: new Date(FIXED_NOW + 90000).toISOString(),
      }],
      reader_identity_ids: ["ocean-booking-telemetry"],
    },
  };
  issueTestBrowserSecret(environment, config.browser.credential_ref);
  const load = () => {
    backend = new WorkflowBackend(config, environment);
    backend.replayTwoBookings.now = () => FIXED_NOW;
  };
  load();

  const loginResponse = await fetch(`${base}/api/workflow/session`, {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ credential: environment.OCEAN_WAYNE_BROWSER_SECRET }),
  });
  assert.equal(loginResponse.status, 200);
  const login = await loginResponse.json();
  const cookie = loginResponse.headers.get("set-cookie").split(";")[0];
  let readSequence = 0;

  async function request(local, { role = "STRATEGY", method = "GET", body, readNonce, omitReadNonce = false } = {}) {
    const headers = {};
    if (role === "HUMAN") Object.assign(headers, { Origin: base, Cookie: cookie, "X-CSRF-Token": login.csrf_token });
    else if (role) headers.Authorization = `Bearer ${environment[`OCEAN_${role}_TOKEN`]}`;
    if (method === "GET" && local.startsWith("replay-two-bookings/") && role && !omitReadNonce) headers["X-Ocean-Booking-Read-Nonce"] = readNonce || `test-booking-read-${++readSequence}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${base}/api/workflow/operational/v1/${local}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    return {
      status: response.status,
      value: await response.json(),
      readNonce: response.headers.get("x-ocean-booking-read-nonce"),
      cacheControl: response.headers.get("cache-control"),
    };
  }

  const acquire = (overrides = {}) => ({
    schema: REPLAY_TWO_ACQUIRE_SCHEMA,
    resource_key: REPLAY_TWO_BOOKING_RESOURCE,
    owner_project: OWNER_PROJECT,
    owner_agent_id: "ocean-booking-oql",
    approval_id: "9f8cd5c6-948a-4818-9fad-5bd56d00cb23",
    approval_snapshot_sha256: APPROVAL_HASH,
    package_sha256: PACKAGE_HASH,
    instance_executable: REPLAY_TWO_EXECUTABLE,
    operation_scope: [...REPLAY_TWO_OPERATION_SCOPE],
    requested_expires_utc: new Date(FIXED_NOW + 60000).toISOString(),
    expected_prior_generation: null,
    expected_prior_receipt_hash: null,
    ...overrides,
  });

  return {
    request,
    acquire,
    backend: () => backend,
    restart() {
      backend.close();
      load();
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      backend.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("protected atomic Replay Two registry preserves fencing, immutable receipts and fail-closed v1 renewal", { timeout: 120000 }, async () => {
  const app = await fixture();
  try {
    let result = await app.request(`replay-two-bookings/current?resource_key=${encodeURIComponent(REPLAY_TWO_BOOKING_RESOURCE)}`, { role: null });
    assert.equal(result.status, 401);
    result = await app.request(`replay-two-bookings/current?resource_key=${encodeURIComponent(REPLAY_TWO_BOOKING_RESOURCE)}`, { role: "TELEMETRY", omitReadNonce: true });
    assert.equal(result.status, 422);
    assert.equal(result.value.error.code, "BOOKING_READ_NONCE_REQUIRED");
    result = await app.request(`replay-two-bookings/current?resource_key=${encodeURIComponent(REPLAY_TWO_BOOKING_RESOURCE)}&extra=1`, { role: "TELEMETRY" });
    assert.equal(result.status, 400);
    assert.equal(result.value.error.code, "BOOKING_CURRENT_QUERY_REQUIRED");

    result = await app.request("replay-two-bookings", { role: "TELEMETRY", method: "POST", body: app.acquire() });
    assert.equal(result.status, 403);
    assert.equal(result.value.error.code, "BOOKING_ISSUER_REQUIRED");

    result = await app.request("replay-two-bookings", { method: "POST", body: app.acquire({ owner_project: "wrong-project" }) });
    assert.equal(result.status, 403);
    assert.equal(result.value.error.code, "BOOKING_OWNER_CONFLICT");
    result = await app.request("replay-two-bookings", { method: "POST", body: app.acquire({ approval_id: "unbound-approval" }) });
    assert.equal(result.status, 403);
    assert.equal(result.value.error.code, "BOOKING_APPROVAL_BINDING_REQUIRED");

    result = await app.request("replay-two-bookings", { method: "POST", body: app.acquire() });
    assert.equal(result.status, 200);
    const first = result.value.receipt;
    assert.equal(result.value.schema, "oql.replay-two-booking-register-response/v1");
    assert.equal(result.value.current.effective_status, "ACTIVE");
    assert.equal(first.generation, 1);
    assert.equal(first.prior_receipt_hash, null);
    assert.equal(first.registry_comment_id, null);
    assert.equal(first.registry_body_sha256, null);
    assert.equal(first.receipt_hash, objectHash(receiptCore(first)));
    assert.deepEqual(first.operation_scope, REPLAY_TWO_OPERATION_SCOPE);

    result = await app.request(`replay-two-bookings/${first.booking_id}`, { role: "TELEMETRY" });
    assert.equal(result.status, 200);
    assert.match(result.readNonce, /^test-booking-read-/);
    assert.equal(result.cacheControl, "no-store");
    assert.deepEqual(result.value.receipt, first);
    result = await app.request(`replay-two-bookings/current?resource_key=${encodeURIComponent(REPLAY_TWO_BOOKING_RESOURCE)}`, { role: "TELEMETRY" });
    assert.equal(result.status, 200);
    assert.equal(result.value.schema, "oql.replay-two-booking-current/v1");
    assert.equal(result.value.current.receipt_hash, first.receipt_hash);

    const configuredApprovals = app.backend().replayTwoBookings.config.approval_bindings;
    app.backend().replayTwoBookings.config.approval_bindings = [];
    result = await app.request(`replay-two-bookings/${first.booking_id}`, { role: "TELEMETRY" });
    assert.equal(result.value.effective_status, "ACTIVE", "booking state is not a substitute for the separate live approval gate");
    app.backend().replayTwoBookings.config.approval_bindings = configuredApprovals;

    result = await app.request("replay-two-bookings", { method: "POST", body: app.acquire() });
    assert.equal(result.status, 409);
    assert.equal(result.value.error.code, "BOOKING_RESOURCE_BUSY");

    result = await app.request("replay-two-bookings/renew", { method: "POST", body: { receipt_hash: first.receipt_hash } });
    assert.equal(result.status, 409);
    assert.equal(result.value.error.code, "BOOKING_RENEWAL_UNAVAILABLE");
    result = await app.request(`replay-two-bookings/${first.booking_id}`);
    assert.deepEqual(result.value.receipt, first);

    const terminal = { schema: REPLAY_TWO_TERMINAL_SCHEMA, generation: 1, receipt_hash: first.receipt_hash, reason: "Completed guarded operation" };
    result = await app.request(`replay-two-bookings/${first.booking_id}/release`, { role: "TELEMETRY", method: "POST", body: terminal });
    assert.equal(result.status, 403);
    result = await app.request(`replay-two-bookings/${first.booking_id}/release`, { method: "POST", body: terminal });
    assert.equal(result.status, 200);
    assert.equal(result.value.schema, "oql.replay-two-booking-terminal-response/v1");
    assert.equal(result.value.event.kind, "RELEASED");
    assert.equal(result.value.current, null);
    result = await app.request(`replay-two-bookings/${first.booking_id}/release`, { method: "POST", body: terminal });
    assert.equal(result.status, 200);

    result = await app.request("replay-two-bookings", { method: "POST", body: app.acquire({ expected_prior_generation: 1, expected_prior_receipt_hash: PACKAGE_HASH }) });
    assert.equal(result.status, 409);
    assert.equal(result.value.error.code, "BOOKING_PRIOR_CAS_CONFLICT");
    result = await app.request("replay-two-bookings", { method: "POST", body: app.acquire({ expected_prior_generation: 1, expected_prior_receipt_hash: first.receipt_hash }) });
    assert.equal(result.status, 200);
    const second = result.value.receipt;
    assert.equal(second.generation, 2);
    assert.equal(second.prior_receipt_hash, first.receipt_hash);

    result = await app.request(`replay-two-bookings/${second.booking_id}/revoke`, {
      role: "HUMAN",
      method: "POST",
      body: { schema: REPLAY_TWO_TERMINAL_SCHEMA, generation: 2, receipt_hash: second.receipt_hash, reason: "Approval withdrawn by operator" },
    });
    assert.equal(result.status, 200);
    assert.equal(result.value.event.kind, "REVOKED");
    const afterRevoke = await app.request(`replay-two-bookings/current?resource_key=${encodeURIComponent(REPLAY_TWO_BOOKING_RESOURCE)}`, { role: "TELEMETRY", readNonce: "test-after-revoke" });
    assert.equal(afterRevoke.status, 200);
    assert.equal(afterRevoke.readNonce, "test-after-revoke");
    assert.equal(afterRevoke.value.current.effective_status, "REVOKED");
    assert.equal(afterRevoke.value.current.generation, 2);
    assert.equal(afterRevoke.value.current.receipt_hash, second.receipt_hash);

    app.restart();
    result = await app.request(`replay-two-bookings/${second.booking_id}`, { role: "TELEMETRY" });
    assert.equal(result.status, 200);
    assert.equal(result.value.effective_status, "REVOKED");
    const recoveredFence = await app.request(`replay-two-bookings/current?resource_key=${encodeURIComponent(REPLAY_TWO_BOOKING_RESOURCE)}`, { role: "TELEMETRY" });
    assert.equal(recoveredFence.value.current.effective_status, "REVOKED");
    assert.throws(() => app.backend().db.prepare("UPDATE ow_replay_two_bookings SET owner_project='changed' WHERE booking_id=?").run(first.booking_id), /immutable replay two booking receipt/);
    assert.throws(() => app.backend().db.prepare("DELETE FROM ow_replay_two_booking_events WHERE booking_id=?").run(first.booking_id), /immutable replay two booking event/);

    result = await app.request("replay-two-bookings", { method: "POST", body: app.acquire({
      expected_prior_generation: recoveredFence.value.current.generation,
      expected_prior_receipt_hash: recoveredFence.value.current.receipt_hash,
      requested_expires_utc: new Date(FIXED_NOW + 2000).toISOString(),
    }) });
    assert.equal(result.status, 200);
    const third = result.value.receipt;
    app.backend().replayTwoBookings.now = () => FIXED_NOW + 3000;
    result = await app.request(`replay-two-bookings/current?resource_key=${encodeURIComponent(REPLAY_TWO_BOOKING_RESOURCE)}`, { role: "TELEMETRY" });
    assert.equal(result.value.current.effective_status, "EXPIRED");
    const lateRelease = await app.request(`replay-two-bookings/${third.booking_id}/release`, {
      method: "POST",
      body: { schema: REPLAY_TWO_TERMINAL_SCHEMA, generation: 3, receipt_hash: third.receipt_hash, reason: "Late cleanup" },
    });
    assert.equal(lateRelease.status, 409);
    assert.equal(lateRelease.value.error.code, "BOOKING_EXPIRED");
    const expiredReadback = await app.request(`replay-two-bookings/${third.booking_id}`, { role: "TELEMETRY" });
    assert.equal(expiredReadback.value.effective_status, "EXPIRED");
    assert.equal(expiredReadback.value.terminal_event.kind, "EXPIRED");
    result = await app.request("replay-two-bookings", { method: "POST", body: app.acquire({
      expected_prior_generation: result.value.current.generation,
      expected_prior_receipt_hash: result.value.current.receipt_hash,
      requested_expires_utc: new Date(FIXED_NOW + 63000).toISOString(),
    }) });
    assert.equal(result.status, 200);
    assert.equal(result.value.receipt.generation, 4);
    const expired = await app.request(`replay-two-bookings/${third.booking_id}`, { role: "TELEMETRY" });
    assert.equal(expired.value.effective_status, "EXPIRED");
    assert.equal(expired.value.terminal_event.kind, "EXPIRED");

    app.backend().replayTwoBookings.config.enabled = false;
    result = await app.request(`replay-two-bookings/current?resource_key=${encodeURIComponent(REPLAY_TWO_BOOKING_RESOURCE)}`, { role: "TELEMETRY" });
    assert.equal(result.status, 503);
    assert.equal(result.value.error.code, "BOOKING_AUTHORITY_UNAVAILABLE");
  } finally {
    await app.close();
  }
});

test("registry rejects altered executable, operation order, hash formats and unknown authority fields", { timeout: 120000 }, async () => {
  const app = await fixture();
  try {
    for (const [override, code] of [
      [{ instance_executable: "D:\\Trading\\SierraChart-Replay\\SierraChart_64.exe" }, "BOOKING_EXECUTABLE_CONFLICT"],
      [{ operation_scope: ["VerifySelection", "Stage", "Rollback"] }, "BOOKING_OPERATION_SCOPE_CONFLICT"],
      [{ package_sha256: `sha256:${"A".repeat(64)}` }, "BOOKING_PACKAGE_HASH_REQUIRED"],
      [{ approval_snapshot_sha256: "not-a-hash" }, "BOOKING_APPROVAL_SNAPSHOT_HASH_REQUIRED"],
      [{ requested_expires_utc: "2026-10-20T16:01:00Z" }, "BOOKING_EXPIRY_REQUIRED"],
      [{ requested_expires_utc: new Date(FIXED_NOW + 100000).toISOString() }, "BOOKING_TTL_EXCEEDS_APPROVAL"],
    ]) {
      const result = await app.request("replay-two-bookings", { method: "POST", body: app.acquire(override) });
      assert.equal(result.status, 422);
      assert.equal(result.value.error.code, code);
    }
    const result = await app.request("replay-two-bookings", { method: "POST", body: { ...app.acquire(), authority: true } });
    assert.equal(result.status, 422);
    assert.equal(result.value.error.code, "UNKNOWN_OR_AUTHORITY_FIELD");
    const noNonce = await app.request(`replay-two-bookings/current?resource_key=${encodeURIComponent(REPLAY_TWO_BOOKING_RESOURCE)}`, { role: null });
    assert.equal(noNonce.status, 401);
  } finally {
    await app.close();
  }
});

test("published contract fixtures retain the exact canonical receipt and terminal hashes", () => {
  const contract = JSON.parse(fs.readFileSync(new URL("./contracts/replay-two-booking-v1.json", import.meta.url), "utf8"));
  const { receipt, terminal_event: terminalEvent } = contract.fixture;
  assert.equal(contract.schema, "ocean.replay-two-booking-contract/v1");
  assert.equal(receipt.receipt_hash, objectHash(receiptCore(receipt)));
  const { event_hash: ignored, ...eventCore } = terminalEvent;
  assert.equal(terminalEvent.event_hash, objectHash(eventCore));
  assert.deepEqual(contract.fixture.register_response.receipt, receipt);
  assert.deepEqual(contract.fixture.exact_readback.receipt, receipt);
  assert.deepEqual(contract.fixture.terminal_response.event, terminalEvent);
  assert.equal(contract.fresh_read.request_header, "X-Ocean-Booking-Read-Nonce");
  assert.equal(contract.fresh_read.response_header, "X-Ocean-Booking-Read-Nonce");
  assert.equal(contract.approval_authority.live_status_authoritative, false);
  assert.match(contract.approval_authority.client_gate, /before and after each mutation/);
  assert.equal(contract.current_semantics.latest_fence_always_present_after_first_acquisition, true);
  assert.equal(contract.fixture.terminal_current_readback.current.effective_status, "RELEASED");
  assert.equal(contract.fixture.terminal_current_readback.current.generation, receipt.generation);
  assert.equal(contract.fixture.terminal_current_readback.current.receipt_hash, receipt.receipt_hash);
  assert.equal(receipt.registry_comment_id, null);
  assert.equal(receipt.registry_body_sha256, null);
});

test("stored booking receipts and terminal events fail closed when indexed or canonical integrity changes", { timeout: 120000 }, async () => {
  const receiptApp = await fixture();
  try {
    const created = await receiptApp.request("replay-two-bookings", { method: "POST", body: receiptApp.acquire() });
    const receipt = created.value.receipt;
    receiptApp.backend().db.exec("DROP TRIGGER ow_replay_two_bookings_no_update");
    receiptApp.backend().db.prepare("UPDATE ow_replay_two_bookings SET payload_json=? WHERE booking_id=?")
      .run(JSON.stringify({ ...receipt, package_sha256: `sha256:${"c".repeat(64)}` }), receipt.booking_id);
    const corrupted = await receiptApp.request(`replay-two-bookings/${receipt.booking_id}`, { role: "TELEMETRY" });
    assert.equal(corrupted.status, 503);
    assert.equal(corrupted.value.error.code, "BOOKING_RECEIPT_INTEGRITY_REQUIRED");
  } finally {
    await receiptApp.close();
  }

  const eventApp = await fixture();
  try {
    const created = await eventApp.request("replay-two-bookings", { method: "POST", body: eventApp.acquire() });
    const receipt = created.value.receipt;
    await eventApp.request(`replay-two-bookings/${receipt.booking_id}/release`, {
      method: "POST",
      body: { schema: REPLAY_TWO_TERMINAL_SCHEMA, generation: 1, receipt_hash: receipt.receipt_hash, reason: "Complete" },
    });
    eventApp.backend().db.exec("DROP TRIGGER ow_replay_two_booking_events_no_update");
    const row = eventApp.backend().db.prepare("SELECT payload_json FROM ow_replay_two_booking_events WHERE booking_id=?").get(receipt.booking_id);
    const event = JSON.parse(row.payload_json);
    eventApp.backend().db.prepare("UPDATE ow_replay_two_booking_events SET payload_json=? WHERE booking_id=?")
      .run(JSON.stringify({ ...event, reason: "Changed offline" }), receipt.booking_id);
    const corrupted = await eventApp.request(`replay-two-bookings/${receipt.booking_id}`, { role: "TELEMETRY" });
    assert.equal(corrupted.status, 503);
    assert.equal(corrupted.value.error.code, "BOOKING_EVENT_INTEGRITY_REQUIRED");
  } finally {
    await eventApp.close();
  }
});

test("separate SQLite processes race for one resource and exactly one generation wins", { timeout: 120000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ocean-replay-booking-race-"));
  const database = path.join(directory, "workflow.sqlite");
  const identities = ["race-owner-one", "race-owner-two"];
  const config = {
    enabled: true,
    test_only: true,
    resource_key: REPLAY_TWO_BOOKING_RESOURCE,
    instance_executable: REPLAY_TWO_EXECUTABLE,
    min_ttl_ms: 1000,
    max_ttl_ms: 120000,
    issuers: identities.map((identity, index) => ({ identity_id: identity, owner_project: `race-project-${index + 1}` })),
    approval_bindings: identities.map((identity, index) => ({
      identity_id: identity,
      owner_project: `race-project-${index + 1}`,
      approval_id: `race-approval-${index + 1}`,
      approval_snapshot_sha256: APPROVAL_HASH,
      package_sha256: PACKAGE_HASH,
      expires_utc: new Date(FIXED_NOW + 90000).toISOString(),
    })),
    reader_identity_ids: [],
  };
  const setupStore = new WorkflowStore(database);
  for (const identity of identities) setupStore.db.prepare("INSERT INTO ow_identities VALUES(?,?,?)").run(identity, "STRATEGY", "{}");
  setupStore.close();

  const children = [];
  try {
    const workerPath = fileURLToPath(new URL("./replay-two-booking-race-worker.mjs", import.meta.url));
    const startWorker = (index) => {
      const identity = identities[index];
      const actor = { id: identity, role: "STRATEGY", namespace: "OPERATIONAL", scopes: ["booking.issue", "booking.read"] };
      const input = {
        schema: REPLAY_TWO_ACQUIRE_SCHEMA,
        resource_key: REPLAY_TWO_BOOKING_RESOURCE,
        owner_project: `race-project-${index + 1}`,
        owner_agent_id: identity,
        approval_id: `race-approval-${index + 1}`,
        approval_snapshot_sha256: APPROVAL_HASH,
        package_sha256: PACKAGE_HASH,
        instance_executable: REPLAY_TWO_EXECUTABLE,
        operation_scope: [...REPLAY_TWO_OPERATION_SCOPE],
        requested_expires_utc: new Date(FIXED_NOW + 60000).toISOString(),
        expected_prior_generation: null,
        expected_prior_receipt_hash: null,
      };
      const child = fork(workerPath, [database, JSON.stringify(config), JSON.stringify(actor), JSON.stringify(input), String(FIXED_NOW)], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
      children.push(child);
      let readyResolve;
      const ready = new Promise((resolve) => { readyResolve = resolve; });
      const result = new Promise((resolve, reject) => {
        child.on("message", (message) => {
          if (message.type === "ready") readyResolve();
          if (message.type === "result") resolve(message);
        });
        child.on("error", reject);
        child.on("exit", (code) => { if (code !== 0) reject(new Error(`Race worker exited ${code}`)); });
      });
      return { child, ready, result };
    };

    const workers = [startWorker(0), startWorker(1)];
    await Promise.all(workers.map((worker) => worker.ready));
    for (const worker of workers) worker.child.send({ type: "go" });
    const outcomes = await Promise.all(workers.map((worker) => worker.result));
    assert.equal(outcomes.filter((outcome) => outcome.ok).length, 1);
    assert.deepEqual(outcomes.filter((outcome) => !outcome.ok).map((outcome) => outcome.code), ["BOOKING_RESOURCE_BUSY"]);

    const readStore = new WorkflowStore(database);
    try {
      const rows = readStore.db.prepare("SELECT generation FROM ow_replay_two_bookings ORDER BY generation").all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].generation, 1);
    } finally { readStore.close(); }
  } finally {
    for (const child of children) if (!child.killed) child.kill();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WorkflowBackend } from "./backend.mjs";
import { issueTestBrowserSecret } from "./auth.mjs";
import { digest, requireThat } from "./common.mjs";
import { REPLAY_TWO_BOOKING_RESOURCE, REPLAY_TWO_EXECUTABLE } from "./replay-two-booking-registry.mjs";

const CONTRACT_SHA256 = "D8571CBA4EED6C6920AEFC439A1A23D78A9ED165B611771738BBD24825F14329";
const TOKEN_ENV = "OCEAN_REPLAY_TWO_FIXTURE_TOKEN";
const IDENTITY_ID = "ocean-booking-oql";
const OWNER_PROJECT = "oql-vwap-wave-pullback";
const STRATEGY_ID = "vwap_wave_pullback_balanced_nasdaq_v0434";
const INSTANCE_ID = "cicd-vwap-pull-back-strategy:replay-two:chart1";
const APPROVAL_ID = "test-approval-0001";
const APPROVAL_HASH = `sha256:${"a".repeat(64)}`;
const PACKAGE_HASH = `sha256:${"b".repeat(64)}`;
const FACTUAL_BINDING = `sha256:${"f".repeat(64)}`;

const token = process.env[TOKEN_ENV];
requireThat(typeof token === "string" && token.startsWith(`ocean_service_v1.${IDENTITY_ID}.`) && token.length >= 64, 503, "FIXTURE_TOKEN_REQUIRED");
const contractPath = new URL("./contracts/replay-two-booking-v1.json", import.meta.url);
const contractBytes = fs.readFileSync(contractPath);
requireThat(createHash("sha256").update(contractBytes).digest("hex").toUpperCase() === CONTRACT_SHA256, 503, "FIXTURE_CONTRACT_HASH_MISMATCH");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ocean-replay-booking-loopback-"));
const environment = { [TOKEN_ENV]: token };
const server = http.createServer((request, response) => void backend.handle(request, response, new URL(request.url, `http://${request.headers.host}`)));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const expiresAt = new Date(Date.now() + 20 * 60 * 1000).toISOString();
const approvalExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
const identity = {
  identity_id: IDENTITY_ID,
  provider: "OCEAN_TRADING",
  namespace: "OPERATIONAL",
  audience: "Ocean workflow operational v1",
  role: "STRATEGY",
  credential_ref: TOKEN_ENV,
  credential_hash: digest(token),
  strategy_ids: [STRATEGY_ID],
  instance_ids: [INSTANCE_ID],
  expires_at_utc: expiresAt,
  revoked: false,
  factual_binding_hash: FACTUAL_BINDING,
  scopes: ["booking.read", "booking.issue"],
};
const config = {
  db_file: path.join(directory, "workflow.sqlite"),
  test_only: true,
  contract_release: "2.1.0",
  allowed_origins: [origin],
  python_executable: process.env.OCEAN_TRADING_PYTHON || "python",
  browser: { subject_id: "wayne-ocean-ui", credential_ref: "OCEAN_FIXTURE_BROWSER_SECRET" },
  identities: [identity],
  pending_services: [],
  operational_factual_bindings: [{
    binding_hash: FACTUAL_BINDING,
    strategy_id: STRATEGY_ID,
    instance: { execution_instance_id: INSTANCE_ID },
  }],
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
    issuers: [{ identity_id: IDENTITY_ID, owner_project: OWNER_PROJECT }],
    approval_bindings: [{
      identity_id: IDENTITY_ID,
      owner_project: OWNER_PROJECT,
      approval_id: APPROVAL_ID,
      approval_snapshot_sha256: APPROVAL_HASH,
      package_sha256: PACKAGE_HASH,
      expires_utc: approvalExpiresAt,
    }],
    reader_identity_ids: [],
  },
};
issueTestBrowserSecret(environment, config.browser.credential_ref);
const backend = new WorkflowBackend(config, environment);
let closing = false;

async function shutdown(code) {
  if (closing) return;
  closing = true;
  await new Promise((resolve) => server.close(resolve));
  backend.close();
  fs.rmSync(directory, { recursive: true, force: true });
  process.exit(code);
}

process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));
process.once("uncaughtException", (error) => {
  console.error(`[ocean-booking-fixture] ${error?.code || "FIXTURE_FAILURE"}`);
  void shutdown(1);
});

process.stdout.write(`${JSON.stringify({
  schema: "ocean.replay-two-booking-loopback-fixture/v1",
  origin,
  contract_sha256: CONTRACT_SHA256,
  identity_id: IDENTITY_ID,
  owner_project: OWNER_PROJECT,
  approval_id: APPROVAL_ID,
  approval_snapshot_sha256: APPROVAL_HASH,
  package_sha256: PACKAGE_HASH,
  instance_executable: REPLAY_TWO_EXECUTABLE,
  approval_expires_utc: approvalExpiresAt,
})}\n`);


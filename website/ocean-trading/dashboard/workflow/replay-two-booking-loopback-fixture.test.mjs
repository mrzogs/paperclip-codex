import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  REPLAY_TWO_ACQUIRE_SCHEMA,
  REPLAY_TWO_BOOKING_RESOURCE,
  REPLAY_TWO_OPERATION_SCOPE,
} from "./replay-two-booking-registry.mjs";

test("real registry loopback fixture is temporary, authenticated and secret-silent", { timeout: 30000 }, async () => {
  const token = "ocean_service_v1.ocean-booking-oql.fixture-only-secret-material-0001";
  const child = spawn(process.execPath, [fileURLToPath(new URL("./replay-two-booking-loopback-fixture.mjs", import.meta.url))], {
    env: { ...process.env, OCEAN_REPLAY_TWO_FIXTURE_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
  const lines = readline.createInterface({ input: child.stdout });
  const ready = await new Promise((resolve, reject) => {
    lines.once("line", (line) => {
      try { resolve(JSON.parse(line)); }
      catch (error) { reject(error); }
    });
    child.once("error", reject);
    child.once("exit", (code) => { if (code !== null && code !== 0) reject(new Error(`Fixture exited ${code}`)); });
  });
  try {
    assert.equal(ready.schema, "ocean.replay-two-booking-loopback-fixture/v1");
    assert.equal(ready.contract_sha256, "D8571CBA4EED6C6920AEFC439A1A23D78A9ED165B611771738BBD24825F14329");
    assert.equal(JSON.stringify(ready).includes(token), false);

    const missing = await fetch(`${ready.origin}/api/workflow/operational/v1/replay-two-bookings/current?resource_key=${encodeURIComponent(REPLAY_TWO_BOOKING_RESOURCE)}`);
    assert.equal(missing.status, 401);
    assert.deepEqual(Object.keys(await missing.json()).sort(), ["api_version", "error"]);

    const requestedExpires = new Date(Date.now() + 60000).toISOString();
    const created = await fetch(`${ready.origin}/api/workflow/operational/v1/replay-two-bookings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        schema: REPLAY_TWO_ACQUIRE_SCHEMA,
        resource_key: REPLAY_TWO_BOOKING_RESOURCE,
        owner_project: ready.owner_project,
        owner_agent_id: ready.identity_id,
        approval_id: ready.approval_id,
        approval_snapshot_sha256: ready.approval_snapshot_sha256,
        package_sha256: ready.package_sha256,
        instance_executable: ready.instance_executable,
        operation_scope: [...REPLAY_TWO_OPERATION_SCOPE],
        requested_expires_utc: requestedExpires,
        expected_prior_generation: null,
        expected_prior_receipt_hash: null,
      }),
    });
    assert.equal(created.status, 200);
    const receipt = (await created.json()).receipt;

    const nonce = "fixture-read-0001";
    const current = await fetch(`${ready.origin}/api/workflow/operational/v1/replay-two-bookings/current?resource_key=${encodeURIComponent(REPLAY_TWO_BOOKING_RESOURCE)}`, {
      headers: { Authorization: `Bearer ${token}`, "X-Ocean-Booking-Read-Nonce": nonce },
    });
    assert.equal(current.status, 200);
    assert.equal(current.headers.get("x-ocean-booking-read-nonce"), nonce);
    assert.equal(current.headers.get("cache-control"), "no-store");
    assert.equal((await current.json()).current.receipt_hash, receipt.receipt_hash);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    lines.close();
  }
  assert.equal(stderr.join("").includes(token), false);
});

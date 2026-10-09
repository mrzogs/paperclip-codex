import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { consumeWebsiteStopRequest, installWebsiteControl } from "./process-control.mjs";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("updates protected website state when workflow readiness recovers", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ocean-website-control-"));
  const dashboard = path.join(tempRoot, "dashboard");
  fs.mkdirSync(dashboard);
  fs.writeFileSync(path.join(dashboard, "server.mjs"), "// test server\n");
  const previousRoot = process.env.OCEAN_WEBSITE_CONTROL_ROOT;
  process.env.OCEAN_WEBSITE_CONTROL_ROOT = tempRoot;

  let workflowReady = false;
  const server = new EventEmitter();
  server.close = () => {};
  server.closeIdleConnections = () => {};
  server.closeAllConnections = () => {};

  try {
    installWebsiteControl(server, dashboard, () => workflowReady);
    server.emit("listening");

    const receipt = path.join(tempRoot, "website-process.json");
    assert.equal(JSON.parse(fs.readFileSync(receipt, "utf8")).workflow_ready, false);

    workflowReady = true;
    await delay(650);
    assert.equal(JSON.parse(fs.readFileSync(receipt, "utf8")).workflow_ready, true);
  } finally {
    if (previousRoot === undefined) delete process.env.OCEAN_WEBSITE_CONTROL_ROOT;
    else process.env.OCEAN_WEBSITE_CONTROL_ROOT = previousRoot;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("acknowledges the exact protected stop request before shutdown", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ocean-website-stop-"));
  const dashboard = path.join(tempRoot, "dashboard");
  fs.mkdirSync(dashboard);
  fs.writeFileSync(path.join(dashboard, "server.mjs"), "// test server\n");
  const previousRoot = process.env.OCEAN_WEBSITE_CONTROL_ROOT;
  process.env.OCEAN_WEBSITE_CONTROL_ROOT = tempRoot;

  let exited = false;
  let ackAtShutdown = null;
  const acknowledgementPath = path.join(tempRoot, "website-stop-ack.operator-request.json");
  const server = new EventEmitter();
  server.close = (callback) => {
    ackAtShutdown = JSON.parse(fs.readFileSync(acknowledgementPath, "utf8"));
    callback();
  };
  server.closeIdleConnections = () => {};
  server.closeAllConnections = () => {};

  try {
    installWebsiteControl(server, dashboard, false, () => { exited = true; });
    server.emit("listening");
    const state = JSON.parse(fs.readFileSync(path.join(tempRoot, "website-process.json"), "utf8"));
    fs.writeFileSync(path.join(tempRoot, "website-stop.json"), JSON.stringify({
      pid: state.pid,
      nonce: state.nonce,
      request_id: "operator-request",
      requested_by: "protected-operator",
    }));

    await delay(650);
    const ack = JSON.parse(fs.readFileSync(acknowledgementPath, "utf8"));
    assert.equal(exited, true);
    assert.deepEqual(ackAtShutdown, ack);
    assert.equal(fs.existsSync(path.join(tempRoot, "website-stop.json")), false);
    assert.deepEqual({
      schema_version: ack.schema_version,
      pid: ack.pid,
      nonce: ack.nonce,
      request_id: ack.request_id,
      requested_by: ack.requested_by,
    }, {
      schema_version: "ocean-website-stop-ack/v1",
      pid: state.pid,
      nonce: state.nonce,
      request_id: "operator-request",
      requested_by: "protected-operator",
    });
    assert.match(ack.acknowledged_at_utc, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    if (previousRoot === undefined) delete process.env.OCEAN_WEBSITE_CONTROL_ROOT;
    else process.env.OCEAN_WEBSITE_CONTROL_ROOT = previousRoot;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("preserves an operator stop published after Node atomically claims the supervisor request", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ocean-website-stop-race-"));
  const stopPath = path.join(tempRoot, "website-stop.json");
  const supervisorRequest = {
    pid: process.pid,
    nonce: "race-nonce",
    request_id: "supervisor-request",
    requested_by: "ocean-website-liveness-supervisor",
  };
  const operatorRequest = {
    pid: process.pid,
    nonce: "race-nonce",
    request_id: "operator-request",
    requested_by: "protected-operator",
  };

  try {
    fs.writeFileSync(stopPath, JSON.stringify(supervisorRequest));
    const consumed = consumeWebsiteStopRequest(tempRoot, process.pid, "race-nonce", () => {
      assert.equal(fs.existsSync(stopPath), false);
      fs.writeFileSync(stopPath, JSON.stringify(operatorRequest), { flag: "wx" });
    });

    assert.equal(consumed.acknowledgement.request_id, "supervisor-request");
    assert.deepEqual(JSON.parse(fs.readFileSync(stopPath, "utf8")), operatorRequest);
    assert.equal(fs.existsSync(path.join(tempRoot, "website-stop-ack.supervisor-request.json")), true);
    assert.deepEqual(fs.readdirSync(tempRoot).filter((name) => name.startsWith("website-stop-claimed.")), []);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("does not clobber an existing request-specific acknowledgement", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ocean-website-stop-ack-race-"));
  const stopPath = path.join(tempRoot, "website-stop.json");
  const acknowledgementPath = path.join(tempRoot, "website-stop-ack.duplicate-request.json");
  const request = {
    pid: process.pid,
    nonce: "duplicate-nonce",
    request_id: "duplicate-request",
    requested_by: "protected-operator",
  };

  try {
    fs.writeFileSync(stopPath, JSON.stringify(request));
    fs.writeFileSync(acknowledgementPath, '{"preserve":true}');
    assert.throws(
      () => consumeWebsiteStopRequest(tempRoot, process.pid, "duplicate-nonce"),
      (error) => error?.code === "EEXIST",
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(stopPath, "utf8")), request);
    assert.equal(fs.readFileSync(acknowledgementPath, "utf8"), '{"preserve":true}');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

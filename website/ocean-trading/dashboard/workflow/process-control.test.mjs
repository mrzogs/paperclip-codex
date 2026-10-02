import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installWebsiteControl } from "./process-control.mjs";

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

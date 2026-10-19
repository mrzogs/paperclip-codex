import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { vwapProjectPaperSqliteFiles } from "./monitor.mjs";

test("discovers every configured project Paper telemetry database for monitor signatures", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocean-project-paper-signature-"));
  const configFile = path.join(dir, "monitor.json");
  fs.writeFileSync(configFile, JSON.stringify({
    schema_version: "ocean-vwap-continuous-improvement-monitor/v1",
    enabled: true,
    strategy_id: "cicd-vwap-pull-back-strategy",
    brain_identity: {
      domain: "trading-strategy",
      project: "cicd-vwap-pull-back-strategy",
      strategy: "cicd-vwap-pull-back-strategy",
    },
    routing: {
      mode: "BLOCK_UNTIL_EXACT_PROJECT_ROUTE",
      required_project_root: "C:\\CICD-VWAP",
      brain_credential_ref: "D:\\secrets\\cicd-vwap.token",
      required_agent_model: "gpt-6.1-sol",
      paperclip_project_id: null,
      paperclip_project_workspace_id: null,
    },
    sources: [
      { id: "replay", environment: "REPLAY", database_path: "D:\\replay.sqlite" },
      { id: "paper-sim1", environment: "PAPER", database_path: "D:\\paper-sim1.sqlite" },
      { id: "paper-sim1-duplicate", environment: "paper", database_path: "D:\\paper-sim1.sqlite" },
    ],
    safety: {
      production_version: null,
      automatic_approval_enabled: false,
      brain_normal_ingestion: "OFF",
      live_real_enabled: false,
      real_order_routing: "PROHIBITED",
    },
  }));

  assert.deepEqual(vwapProjectPaperSqliteFiles(configFile), ["D:\\paper-sim1.sqlite"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

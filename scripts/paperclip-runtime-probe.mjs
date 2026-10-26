#!/usr/bin/env node

import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "http://127.0.0.1:3100";
const DEFAULT_TIMEOUT_MS = 4_000;

function readOption(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function fetchWithDeadline(url, timeoutMs) {
  return fetch(url, {
    cache: "no-store",
    headers: { accept: "application/json, text/html;q=0.9" },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export async function probePaperclipRuntime({
  baseUrl = DEFAULT_BASE_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetchWithDeadline,
  issueIdentifier = null,
} = {}) {
  const normalizedBase = baseUrl.replace(/\/$/, "");
  const issuePrefix = issueIdentifier?.split("-", 1)[0] ?? null;
  const pagePath = issueIdentifier ? `/${issuePrefix}/issues/${encodeURIComponent(issueIdentifier)}` : "/";
  const dataPath = issueIdentifier ? `/api/issues/${encodeURIComponent(issueIdentifier)}` : "/api/companies";
  const result = {
    healthy: false,
    checkedAt: new Date().toISOString(),
    probes: {
      health: { ok: false },
      page: { ok: false },
      data: { ok: false },
    },
  };

  const checks = [
    ["health", `${normalizedBase}/api/health`, async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (body?.status !== "ok") throw new Error("health payload was not ok");
    }],
    ["page", `${normalizedBase}${pagePath}`, async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get("content-type") ?? "";
      const body = await response.text();
      if (!contentType.includes("text/html") || !body.includes('<div id="root"></div>')) {
        throw new Error("Paperclip application shell marker missing");
      }
    }],
    ["data", `${normalizedBase}${dataPath}`, async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (issueIdentifier) {
        if (body?.identifier !== issueIdentifier) throw new Error("issue payload did not match the requested issue");
      } else if (!Array.isArray(body)) {
        throw new Error("companies payload was not an array");
      }
    }],
  ];

  for (const [name, url, validate] of checks) {
    try {
      const response = await fetchImpl(url, timeoutMs);
      await validate(response);
      result.probes[name] = { ok: true, status: response.status };
    } catch (error) {
      result.probes[name] = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  result.healthy = Object.values(result.probes).every((probe) => probe.ok);
  return result;
}

export async function queryActiveRunCount({ configPath, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!configPath) throw new Error("configPath is required");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  if (config?.database?.mode !== "embedded-postgres") {
    throw new Error("active-run custody probe supports embedded-postgres only");
  }

  const port = Number(config.database.embeddedPostgresPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("embeddedPostgresPort is invalid");
  }

  const requireFromDbPackage = createRequire(new URL("../packages/db/package.json", import.meta.url));
  const postgresModuleUrl = requireFromDbPackage.resolve("postgres");
  const { default: postgres } = await import(pathToFileURL(postgresModuleUrl).href);
  const sql = postgres(`postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`, {
    max: 1,
    connect_timeout: Math.max(1, Math.ceil(timeoutMs / 1_000)),
    idle_timeout: 1,
  });

  try {
    await sql`select set_config('statement_timeout', ${String(timeoutMs)}, false)`;
    const rows = await sql`
      select id, status, process_pid as "processPid"
      from heartbeat_runs
      where status in ('queued', 'running')
    `;
    return {
      ...classifyActiveRunCustody(rows),
      checkedAt: new Date().toISOString(),
    };
  } finally {
    await sql.end({ timeout: 1 });
  }
}

function isLocalProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EPERM") return true;
    return false;
  }
}

export function classifyActiveRunCustody(rows, { processAlive = isLocalProcessAlive } = {}) {
  let queuedRunCount = 0;
  let liveRunningRunCount = 0;
  let deadRunningRunCount = 0;
  let unknownRunningRunCount = 0;

  for (const row of rows) {
    if (row?.status === "queued") {
      queuedRunCount++;
      continue;
    }
    if (row?.status !== "running") continue;
    const pid = Number(row.processPid);
    if (!Number.isInteger(pid) || pid <= 0) {
      unknownRunningRunCount++;
    } else if (processAlive(pid)) {
      liveRunningRunCount++;
    } else {
      deadRunningRunCount++;
    }
  }

  return {
    activeRunCount: liveRunningRunCount,
    custodyKnown: unknownRunningRunCount === 0,
    queuedRunCount,
    liveRunningRunCount,
    deadRunningRunCount,
    unknownRunningRunCount,
    recoverableRunCount: queuedRunCount + deadRunningRunCount,
  };
}

async function main(args) {
  const command = args[0] ?? "health";
  const timeoutMs = parsePositiveInteger(readOption(args, "--timeout-ms", DEFAULT_TIMEOUT_MS), DEFAULT_TIMEOUT_MS);

  if (command === "health") {
    const result = await probePaperclipRuntime({
      baseUrl: readOption(args, "--base-url", DEFAULT_BASE_URL),
      issueIdentifier: readOption(args, "--issue", null),
      timeoutMs,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.healthy ? 0 : 1;
    return;
  }

  if (command === "active-runs") {
    try {
      const result = await queryActiveRunCount({
        configPath: readOption(args, "--config", null),
        timeoutMs,
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({
        activeRunCount: null,
        custodyKnown: false,
        checkedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      })}\n`);
      process.exitCode = 2;
    }
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

const invokedPath = process.argv[1] ? fileURLToPath(new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`)) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 2;
  });
}


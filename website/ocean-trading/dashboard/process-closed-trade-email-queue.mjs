import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = rest[index + 1];
    if (next == null || next.startsWith("--")) {
      options[key] = "true";
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return { command, options };
}

function usage() {
  console.error(`Usage:
  node process-closed-trade-email-queue.mjs list [--base-dir <dashboard-dir>] [--json]
  node process-closed-trade-email-queue.mjs ack-delivered --id <alert-id> [--base-dir <dashboard-dir>] [--actor <name>] [--message-id <gmail-message-id>] [--detail <text>]
  node process-closed-trade-email-queue.mjs ack-failed --id <alert-id> --error <text> [--base-dir <dashboard-dir>] [--actor <name>] [--detail <text>]`);
}

function readJson(filePath, fallback) {
  try {
    return fs.existsSync(filePath)
      ? JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""))
      : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function resolveFiles(baseDirOption) {
  const baseDir = path.resolve(baseDirOption || __dirname);
  return {
    baseDir,
    pendingFile: path.join(baseDir, "data", "closed-trade-email-pending.json"),
    logFile: path.join(baseDir, "data", "closed-trade-email-alerts.json"),
  };
}

function loadState(baseDirOption) {
  const files = resolveFiles(baseDirOption);
  const pending = readJson(files.pendingFile, { alerts: [] }) || { alerts: [] };
  const log = readJson(files.logFile, { alerts: [] }) || { alerts: [] };
  pending.alerts = Array.isArray(pending.alerts) ? pending.alerts : [];
  log.alerts = Array.isArray(log.alerts) ? log.alerts : [];
  return { ...files, pending, log };
}

function saveState(state) {
  state.pending.updatedAtUtc = new Date().toISOString();
  state.log.updatedAtUtc = new Date().toISOString();
  writeJson(state.pendingFile, state.pending);
  writeJson(state.logFile, state.log);
}

function requireOption(options, name) {
  const value = options[name];
  if (typeof value === "string" && value.trim().length) return value.trim();
  throw new Error(`Missing required option --${name}`);
}

function upsertLogAlert(log, alertId, mutate) {
  const index = log.alerts.findIndex((entry) => entry?.id === alertId);
  if (index >= 0) {
    log.alerts[index] = mutate(log.alerts[index]);
    return log.alerts[index];
  }
  const nextEntry = mutate({ id: alertId });
  log.alerts.push(nextEntry);
  return nextEntry;
}

function listPending(state, asJson) {
  const payload = {
    baseDir: state.baseDir,
    pendingFile: state.pendingFile,
    logFile: state.logFile,
    pendingCount: state.pending.alerts.length,
    alerts: state.pending.alerts.map((alert) => ({
      id: alert.id,
      createdAtUtc: alert.createdAtUtc || null,
      mode: alert.mode || null,
      recipient: alert.recipient || null,
      deliveryPath: alert.deliveryPath || null,
      deliveryAgent: alert.deliveryAgent || null,
      queueReason: alert.queueReason || null,
      subject: alert.email?.subject || null,
      body: alert.email?.body || null,
      account: alert.trade?.account || null,
      symbol: alert.trade?.symbol || null,
      pnl: alert.trade?.realizedPnlDollars ?? null,
      lastError: alert.lastError || null,
      attempts: alert.attempts || 0,
    })),
  };

  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`Pending alerts: ${payload.pendingCount}`);
  for (const alert of payload.alerts) {
    console.log(`- ${alert.id} | ${alert.subject || "no subject"} | ${alert.recipient || "no recipient"} | attempts=${alert.attempts}`);
    if (alert.lastError) console.log(`  lastError=${alert.lastError}`);
  }
}

function ackDelivered(state, options) {
  const alertId = requireOption(options, "id");
  const actor = options.actor?.trim() || "Reporter";
  const detail = options.detail?.trim() || null;
  const messageId = options["message-id"]?.trim() || null;
  const alertIndex = state.pending.alerts.findIndex((entry) => entry?.id === alertId);
  if (alertIndex < 0) throw new Error(`Pending alert not found: ${alertId}`);

  const alert = state.pending.alerts[alertIndex];
  const deliveredAtUtc = new Date().toISOString();
  upsertLogAlert(state.log, alertId, (existing) => ({
    ...existing,
    ...alert,
    lastAttemptAtUtc: deliveredAtUtc,
    lastActor: actor,
    lastError: null,
    delivery: {
      ...(existing.delivery || {}),
      sent: true,
      queued: false,
      reason: "sent_via_reporter_gmail_connector",
      deliveryPath: alert.deliveryPath || existing.delivery?.deliveryPath || "reporter_gmail_connector",
      deliveryAgent: actor,
      deliveredAtUtc,
      messageId,
      detail,
      error: null,
      attemptedAtUtc: null,
    },
    finalDelivery: {
      status: "sent",
      actor,
      deliveredAtUtc,
      messageId,
      detail,
    },
  }));
  state.pending.alerts.splice(alertIndex, 1);
  saveState(state);
  console.log(JSON.stringify({ status: "sent", id: alertId, deliveredAtUtc, messageId, remaining: state.pending.alerts.length }, null, 2));
}

function ackFailed(state, options) {
  const alertId = requireOption(options, "id");
  const error = requireOption(options, "error");
  const actor = options.actor?.trim() || "Reporter";
  const detail = options.detail?.trim() || null;
  const alertIndex = state.pending.alerts.findIndex((entry) => entry?.id === alertId);
  if (alertIndex < 0) throw new Error(`Pending alert not found: ${alertId}`);

  const attemptedAtUtc = new Date().toISOString();
  const alert = {
    ...state.pending.alerts[alertIndex],
    attempts: Number(state.pending.alerts[alertIndex]?.attempts || 0) + 1,
    lastAttemptAtUtc: attemptedAtUtc,
    lastError: error,
    lastActor: actor,
  };
  state.pending.alerts[alertIndex] = alert;
  upsertLogAlert(state.log, alertId, (existing) => ({
    ...existing,
    ...alert,
    delivery: {
      ...(existing.delivery || {}),
      sent: false,
      queued: true,
      reason: "reporter_gmail_connector_failed",
      deliveryPath: alert.deliveryPath || existing.delivery?.deliveryPath || "reporter_gmail_connector",
      deliveryAgent: actor,
      attemptedAtUtc,
      error,
      detail,
    },
    finalDelivery: {
      status: "failed",
      actor,
      attemptedAtUtc,
      error,
      detail,
    },
  }));
  saveState(state);
  console.log(JSON.stringify({ status: "failed", id: alertId, attemptedAtUtc, attempts: alert.attempts, error }, null, 2));
}

try {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "--help" || command === "help") {
    usage();
    process.exit(command ? 0 : 1);
  }

  const state = loadState(options["base-dir"]);
  if (command === "list") {
    listPending(state, options.json === "true");
  } else if (command === "ack-delivered") {
    ackDelivered(state, options);
  } else if (command === "ack-failed") {
    ackFailed(state, options);
  } else {
    usage();
    process.exit(1);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

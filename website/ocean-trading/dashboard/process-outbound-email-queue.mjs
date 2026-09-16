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
  node process-outbound-email-queue.mjs list [--base-dir <dashboard-dir>] [--json]
  node process-outbound-email-queue.mjs ack-delivered --id <request-id> [--base-dir <dashboard-dir>] [--actor <name>] [--message-id <gmail-message-id>] [--detail <text>]
  node process-outbound-email-queue.mjs ack-failed --id <request-id> --error <text> [--base-dir <dashboard-dir>] [--actor <name>] [--detail <text>]
  node process-outbound-email-queue.mjs archive-failed --id <request-id> --error <text> [--base-dir <dashboard-dir>] [--actor <name>] [--detail <text>]`);
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
    queueFile: path.join(baseDir, "data", "outbound-email-queue.json"),
    logFile: path.join(baseDir, "data", "outbound-email-log.json"),
  };
}

function loadState(baseDirOption) {
  const files = resolveFiles(baseDirOption);
  const queue = readJson(files.queueFile, { requests: [] }) || { requests: [] };
  const log = readJson(files.logFile, { requests: [] }) || { requests: [] };
  queue.requests = Array.isArray(queue.requests) ? queue.requests : [];
  log.requests = Array.isArray(log.requests) ? log.requests : [];
  return { ...files, queue, log };
}

function saveState(state) {
  state.queue.updatedAtUtc = new Date().toISOString();
  state.log.updatedAtUtc = new Date().toISOString();
  writeJson(state.queueFile, state.queue);
  writeJson(state.logFile, state.log);
}

function requireOption(options, name) {
  const value = options[name];
  if (typeof value === "string" && value.trim().length) return value.trim();
  throw new Error(`Missing required option --${name}`);
}

function upsertLogRequest(log, requestId, mutate) {
  const index = log.requests.findIndex((entry) => entry?.id === requestId);
  if (index >= 0) {
    log.requests[index] = mutate(log.requests[index]);
    return log.requests[index];
  }
  const nextEntry = mutate({ id: requestId });
  log.requests.push(nextEntry);
  return nextEntry;
}

function listPending(state, asJson) {
  const payload = {
    baseDir: state.baseDir,
    queueFile: state.queueFile,
    logFile: state.logFile,
    pendingCount: state.queue.requests.length,
    requests: state.queue.requests.map((request) => ({
      id: request.id,
      createdAtUtc: request.createdAtUtc || null,
      requestType: request.requestType || null,
      recipient: request.recipient || null,
      deliveryPath: request.deliveryPath || null,
      deliveryAgent: request.deliveryAgent || null,
      subject: request.subject || null,
      body: request.body || null,
      status: request.status || null,
      mode: request.metadata?.mode || null,
      tradeId: request.metadata?.tradeId || null,
      lastError: request.lastError || null,
      attempts: request.attempts || 0,
    })),
  };

  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`Pending outbound email requests: ${payload.pendingCount}`);
  for (const request of payload.requests) {
    console.log(`- ${request.id} | ${request.subject || "no subject"} | ${request.recipient || "no recipient"} | ${request.deliveryAgent || "no agent"}`);
    if (request.lastError) console.log(`  lastError=${request.lastError}`);
  }
}

function ackDelivered(state, options) {
  const requestId = requireOption(options, "id");
  const actor = options.actor?.trim() || "Riley - Connection Manager";
  const detail = options.detail?.trim() || null;
  const messageId = options["message-id"]?.trim() || null;
  const requestIndex = state.queue.requests.findIndex((entry) => entry?.id === requestId);
  if (requestIndex < 0) throw new Error(`Pending request not found: ${requestId}`);

  const request = state.queue.requests[requestIndex];
  const deliveredAtUtc = new Date().toISOString();
  upsertLogRequest(state.log, requestId, (existing) => ({
    ...existing,
    ...request,
    status: "delivered",
    lastAttemptAtUtc: deliveredAtUtc,
    lastActor: actor,
    lastError: null,
    delivery: {
      ...(existing.delivery || {}),
      sent: true,
      queued: false,
      reason: "sent_via_riley_gmail_connector",
      deliveryPath: request.deliveryPath || existing.delivery?.deliveryPath || "reporter_gmail_connector",
      deliveryAgent: actor,
      deliveredAtUtc,
      messageId,
      detail,
      error: null,
    },
  }));
  state.queue.requests.splice(requestIndex, 1);
  saveState(state);
  console.log(JSON.stringify({ status: "delivered", id: requestId, deliveredAtUtc, messageId, remaining: state.queue.requests.length }, null, 2));
}

function ackFailed(state, options) {
  const requestId = requireOption(options, "id");
  const error = requireOption(options, "error");
  const actor = options.actor?.trim() || "Riley - Connection Manager";
  const detail = options.detail?.trim() || null;
  const requestIndex = state.queue.requests.findIndex((entry) => entry?.id === requestId);
  if (requestIndex < 0) throw new Error(`Pending request not found: ${requestId}`);

  const attemptedAtUtc = new Date().toISOString();
  const request = {
    ...state.queue.requests[requestIndex],
    attempts: Number(state.queue.requests[requestIndex]?.attempts || 0) + 1,
    lastAttemptAtUtc: attemptedAtUtc,
    lastActor: actor,
    lastError: error,
  };
  state.queue.requests[requestIndex] = request;
  upsertLogRequest(state.log, requestId, (existing) => ({
    ...existing,
    ...request,
    status: "failed",
    delivery: {
      ...(existing.delivery || {}),
      sent: false,
      queued: true,
      reason: "riley_gmail_connector_failed",
      deliveryPath: request.deliveryPath || existing.delivery?.deliveryPath || "reporter_gmail_connector",
      deliveryAgent: actor,
      attemptedAtUtc,
      error,
      detail,
    },
  }));
  saveState(state);
  console.log(JSON.stringify({ status: "failed", id: requestId, attemptedAtUtc, attempts: request.attempts, error }, null, 2));
}

function archiveFailed(state, options) {
  const requestId = requireOption(options, "id");
  const error = requireOption(options, "error");
  const actor = options.actor?.trim() || "Riley - Connection Manager";
  const detail = options.detail?.trim() || null;
  const requestIndex = state.queue.requests.findIndex((entry) => entry?.id === requestId);
  if (requestIndex < 0) throw new Error(`Pending request not found: ${requestId}`);

  const attemptedAtUtc = new Date().toISOString();
  const request = {
    ...state.queue.requests[requestIndex],
    attempts: Number(state.queue.requests[requestIndex]?.attempts || 0) + 1,
    lastAttemptAtUtc: attemptedAtUtc,
    lastActor: actor,
    lastError: error,
  };
  upsertLogRequest(state.log, requestId, (existing) => ({
    ...existing,
    ...request,
    status: "failed",
    delivery: {
      ...(existing.delivery || {}),
      sent: false,
      queued: false,
      reason: "riley_gmail_connector_failed_archived",
      deliveryPath: request.deliveryPath || existing.delivery?.deliveryPath || "reporter_gmail_connector",
      deliveryAgent: actor,
      attemptedAtUtc,
      error,
      detail,
    },
  }));
  state.queue.requests.splice(requestIndex, 1);
  saveState(state);
  console.log(JSON.stringify({ status: "failed_archived", id: requestId, attemptedAtUtc, error, remaining: state.queue.requests.length }, null, 2));
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
  } else if (command === "archive-failed") {
    archiveFailed(state, options);
  } else {
    usage();
    process.exit(1);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

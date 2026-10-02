import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, "config", "sierra-symbols.json");
const OUTPUT_FILE = path.join(__dirname, "data", "dtc-position-snapshot.json");
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = Number(process.env.OCEAN_DTC_SNAPSHOT_TIMEOUT_MS || 3000);
const DTC_PROTOCOL_VERSION = 8;
const DTC_MESSAGE_TYPES = {
  LOGON_REQUEST: 1,
  LOGON_RESPONSE: 2,
  HEARTBEAT: 3,
  LOGOFF: 5,
  ENCODING_REQUEST: 6,
  ENCODING_RESPONSE: 7,
  CURRENT_POSITIONS_REQUEST: 305,
  POSITION_UPDATE: 306,
  CURRENT_POSITIONS_REJECT: 307,
  TRADE_ACCOUNTS_REQUEST: 400,
  TRADE_ACCOUNT_RESPONSE: 401,
  ACCOUNT_BALANCE_UPDATE: 600,
  ACCOUNT_BALANCE_REQUEST: 601,
  ACCOUNT_BALANCE_REJECT: 602,
};

function readJson(filePath, fallback) {
  try {
    return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf8")) : fallback;
  } catch {
    return fallback;
  }
}

function encodingRequestMessage() {
  const buffer = Buffer.alloc(16);
  buffer.writeUInt16LE(16, 0);
  buffer.writeUInt16LE(DTC_MESSAGE_TYPES.ENCODING_REQUEST, 2);
  buffer.writeInt32LE(DTC_PROTOCOL_VERSION, 4);
  buffer.writeInt32LE(2, 8); // JSON_ENCODING
  buffer.write("DTC\0", 12, "ascii");
  return buffer;
}

function jsonFrame(message) {
  return Buffer.from(`${JSON.stringify(message)}\0`, "utf8");
}

function requestMessage(type, requestId, tradeAccount = "") {
  return JSON.stringify({
    Type: type,
    RequestID: requestId,
    RequestIDInternal: requestId,
    ...(tradeAccount ? { TradeAccount: tradeAccount } : {}),
  }) + "\0";
}

function logonMessage(tradeAccount = "") {
  return JSON.stringify({
    Type: DTC_MESSAGE_TYPES.LOGON_REQUEST,
    ProtocolVersion: DTC_PROTOCOL_VERSION,
    Username: process.env.OCEAN_DTC_USERNAME || "",
    Password: process.env.OCEAN_DTC_PASSWORD || "",
    TradeAccount: tradeAccount,
    ClientName: "Ocean Trading",
    GeneralTextData: "Ocean Trading read-only position snapshot",
  }) + "\0";
}

function logoffMessage() {
  return JSON.stringify({ Type: DTC_MESSAGE_TYPES.LOGOFF }) + "\0";
}

function parseFrames(buffer) {
  const parts = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer || "");
  const frames = parts
    .split(/\0+/)
    .map((part) => part.trim())
    .filter((part) => part.startsWith("{"));
  const messages = [];
  const errors = [];
  for (const part of frames) {
    try {
      messages.push(JSON.parse(part));
    } catch {
      errors.push(part.slice(0, 240));
    }
  }
  return { messages, errors };
}

function messageType(message) {
  const type = message?.Type ?? message?.type ?? message?.MessageType ?? message?.messageType ?? "";
  if (typeof type === "number") {
    const match = Object.entries(DTC_MESSAGE_TYPES).find(([, value]) => value === type);
    return match?.[0] || String(type);
  }
  return String(type);
}

function snapshotInstance(name, instance) {
  const host = instance.dtcHost || instance.host || DEFAULT_HOST;
  const port = Number(instance.tradingPort || instance.dtcTradingPort || instance.port);
  const startedAtUtc = new Date().toISOString();
  if (!Number.isInteger(port) || port <= 0) {
    return Promise.resolve({
      ok: false,
      mode: name,
      host,
      port: null,
      startedAtUtc,
      completedAtUtc: new Date().toISOString(),
      error: "No DTC trading port configured.",
      positions: [],
      balances: [],
      messages: [],
      parseErrors: [],
    });
  }

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let raw = Buffer.alloc(0);
    let settled = false;

    function finish(result) {
      if (settled) return;
      settled = true;
      try {
        socket.write(logoffMessage());
      } catch {
        // Ignore best-effort logoff failures.
      }
      socket.destroy();
      resolve({
        mode: name,
        host,
        port,
        startedAtUtc,
        completedAtUtc: new Date().toISOString(),
        ...result,
      });
    }

    const timer = setTimeout(() => {
      const parsed = parseFrames(raw);
      const positions = parsed.messages.filter((message) => /POSITION/i.test(messageType(message)));
      const balances = parsed.messages.filter((message) => /BALANCE/i.test(messageType(message)));
      finish({
        ok: positions.length > 0 || balances.length > 0,
        error: positions.length || balances.length ? null : "No JSON DTC position or balance messages were received before timeout.",
        positions,
        balances,
        messages: parsed.messages,
        parseErrors: parsed.errors,
        rawBytes: raw.length,
      });
    }, DEFAULT_TIMEOUT_MS);

    socket.setTimeout(DEFAULT_TIMEOUT_MS);
    socket.on("data", (chunk) => {
      raw = Buffer.concat([raw, chunk]);
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      finish({
        ok: false,
        error: String(error?.message || error),
        positions: [],
        balances: [],
        messages: [],
        parseErrors: [],
        rawBytes: raw.length,
      });
    });
    socket.on("timeout", () => {
      clearTimeout(timer);
      const parsed = parseFrames(raw);
      const positions = parsed.messages.filter((message) => /POSITION/i.test(messageType(message)));
      const balances = parsed.messages.filter((message) => /BALANCE/i.test(messageType(message)));
      finish({
        ok: positions.length > 0 || balances.length > 0,
        error: positions.length || balances.length ? null : "DTC JSON snapshot timed out before usable position or balance data was received.",
        positions,
        balances,
        messages: parsed.messages,
        parseErrors: parsed.errors,
        rawBytes: raw.length,
      });
    });
    socket.connect(port, host, () => {
      const tradeAccount = String(instance.account || instance.tradeAccount || "").trim();
      socket.write(encodingRequestMessage());
      setTimeout(() => {
        socket.write(logonMessage(tradeAccount));
        socket.write(jsonFrame({
          Type: DTC_MESSAGE_TYPES.TRADE_ACCOUNTS_REQUEST,
          RequestID: 1,
          RequestIDInternal: 1,
        }));
        socket.write(requestMessage(DTC_MESSAGE_TYPES.CURRENT_POSITIONS_REQUEST, 2, tradeAccount));
        socket.write(requestMessage(DTC_MESSAGE_TYPES.ACCOUNT_BALANCE_REQUEST, 3, tradeAccount));
      }, 100);
    });
  });
}

async function main() {
  const config = readJson(CONFIG_FILE, {});
  const reasonArgIndex = process.argv.indexOf("--reason");
  const reason = reasonArgIndex >= 0 ? process.argv[reasonArgIndex + 1] || "manual" : "manual";
  const snapshots = {
    live: await snapshotInstance("live", config.live || {}),
    paper: await snapshotInstance("paper", config.paper || {}),
  };
  const output = {
    generatedAtUtc: new Date().toISOString(),
    reason,
    note: "Read-only DTC snapshot. The client negotiates JSON encoding, then requests trade accounts, current positions, and account balances.",
    snapshots,
  };
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  process.exitCode = 0;
}

main().catch((error) => {
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(
    OUTPUT_FILE,
    JSON.stringify(
      {
        generatedAtUtc: new Date().toISOString(),
        ok: false,
        error: String(error?.message || error),
        snapshots: {},
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
});

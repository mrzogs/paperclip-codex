import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { windowsServiceProcessTree, type WindowsServiceProcessIdentity } from "./windows-service-process-tree.js";

const execFileAsync = promisify(execFile);

export interface LocalServiceRegistryRecord {
  version: 1;
  serviceKey: string;
  profileKind: string;
  serviceName: string;
  command: string;
  cwd: string;
  envFingerprint: string;
  port: number | null;
  url: string | null;
  pid: number;
  processGroupId: number | null;
  provider: "local_process";
  runtimeServiceId: string | null;
  reuseKey: string | null;
  startedAt: string;
  lastSeenAt: string;
  metadata: Record<string, unknown> | null;
  windowsProcessTree?: WindowsServiceProcessIdentity[];
  stopError?: string | null;
}

export interface LocalServiceIdentityInput {
  profileKind: string;
  serviceName: string;
  cwd: string;
  command: string;
  envFingerprint: string;
  port: number | null;
  scope: Record<string, unknown> | null;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    return `{${Object.keys(rec).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(rec[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sanitizeServiceKeySegment(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function getRuntimeServicesDir() {
  return path.resolve(resolvePaperclipInstanceRoot(), "runtime-services");
}

function getRuntimeServiceRegistryPath(serviceKey: string) {
  return path.resolve(getRuntimeServicesDir(), `${serviceKey}.json`);
}

function hasWindowsProcessIdentities(value: unknown): value is WindowsServiceProcessIdentity[] {
  return Array.isArray(value) && value.length > 0 && value.every((identity) =>
    identity && typeof identity === "object"
    && Number.isSafeInteger(identity.pid) && identity.pid > 0
    && Number.isSafeInteger(identity.parentPid) && identity.parentPid >= 0
    && typeof identity.startedAtTicks === "string" && /^[1-9]\d*$/.test(identity.startedAtTicks));
}

function normalizeRegistryRecord(raw: unknown): LocalServiceRegistryRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (
    rec.version !== 1 ||
    typeof rec.serviceKey !== "string" ||
    typeof rec.profileKind !== "string" ||
    typeof rec.serviceName !== "string" ||
    typeof rec.command !== "string" ||
    typeof rec.cwd !== "string" ||
    typeof rec.envFingerprint !== "string" ||
    typeof rec.pid !== "number"
  ) {
    return null;
  }

  return {
    version: 1,
    serviceKey: rec.serviceKey,
    profileKind: rec.profileKind,
    serviceName: rec.serviceName,
    command: rec.command,
    cwd: rec.cwd,
    envFingerprint: rec.envFingerprint,
    port: typeof rec.port === "number" ? rec.port : null,
    url: typeof rec.url === "string" ? rec.url : null,
    pid: rec.pid,
    processGroupId: typeof rec.processGroupId === "number" ? rec.processGroupId : null,
    windowsProcessTree: Array.isArray(rec.windowsProcessTree)
      && (rec.windowsProcessTree.length === 0 || hasWindowsProcessIdentities(rec.windowsProcessTree))
      ? rec.windowsProcessTree as WindowsServiceProcessIdentity[] : undefined,
    stopError: typeof rec.stopError === "string" ? rec.stopError : null,
    provider: "local_process",
    runtimeServiceId: typeof rec.runtimeServiceId === "string" ? rec.runtimeServiceId : null,
    reuseKey: typeof rec.reuseKey === "string" ? rec.reuseKey : null,
    startedAt: typeof rec.startedAt === "string" ? rec.startedAt : new Date().toISOString(),
    lastSeenAt: typeof rec.lastSeenAt === "string" ? rec.lastSeenAt : new Date().toISOString(),
    metadata:
      rec.metadata && typeof rec.metadata === "object" && !Array.isArray(rec.metadata)
        ? (rec.metadata as Record<string, unknown>)
        : null,
  };
}

async function safeReadRegistryRecord(filePath: string) {
  try {
    const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    return normalizeRegistryRecord(raw);
  } catch {
    return null;
  }
}

export function createLocalServiceKey(input: LocalServiceIdentityInput) {
  const digest = createHash("sha256")
    .update(
      stableStringify({
        profileKind: input.profileKind,
        serviceName: input.serviceName,
        cwd: path.resolve(input.cwd),
        command: input.command,
        envFingerprint: input.envFingerprint,
        port: input.port,
        scope: input.scope ?? null,
      }),
    )
    .digest("hex")
    .slice(0, 24);

  return `${sanitizeServiceKeySegment(input.profileKind, "service")}-${sanitizeServiceKeySegment(input.serviceName, "service")}-${digest}`;
}

export async function writeLocalServiceRegistryRecord(record: LocalServiceRegistryRecord) {
  if (process.platform === "win32" && !record.windowsProcessTree) {
    const captured = await windowsServiceProcessTree({ action: "capture", rootPid: record.pid });
    if (captured.error) throw new Error(captured.error);
    record.windowsProcessTree = captured.identities;
  }
  await fs.mkdir(getRuntimeServicesDir(), { recursive: true });
  await fs.writeFile(
    getRuntimeServiceRegistryPath(record.serviceKey),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
}

export async function removeLocalServiceRegistryRecord(serviceKey: string) {
  await fs.rm(getRuntimeServiceRegistryPath(serviceKey), { force: true });
}

export async function readLocalServiceRegistryRecord(serviceKey: string) {
  return await safeReadRegistryRecord(getRuntimeServiceRegistryPath(serviceKey));
}

export async function listLocalServiceRegistryRecords(filter?: {
  profileKind?: string;
  metadata?: Record<string, unknown>;
}) {
  try {
    const entries = await fs.readdir(getRuntimeServicesDir(), { withFileTypes: true });
    const records = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => safeReadRegistryRecord(path.resolve(getRuntimeServicesDir(), entry.name))),
    );

    return records
      .filter((record): record is LocalServiceRegistryRecord => record !== null)
      .filter((record) => {
        if (filter?.profileKind && record.profileKind !== filter.profileKind) return false;
        if (!filter?.metadata) return true;
        return Object.entries(filter.metadata).every(([key, value]) => record.metadata?.[key] === value);
      })
      .sort((left, right) => left.serviceKey.localeCompare(right.serviceKey));
  } catch {
    return [];
  }
}

export async function findLocalServiceRegistryRecordByRuntimeServiceId(input: {
  runtimeServiceId: string;
  profileKind?: string;
}) {
  const records = await listLocalServiceRegistryRecords(
    input.profileKind ? { profileKind: input.profileKind } : undefined,
  );
  const record = records.find((entry) => entry.runtimeServiceId === input.runtimeServiceId) ?? null;
  if (!record) return null;

  if (process.platform === "win32") return await verifyWindowsRegistryRecord(record);

  let candidate = record;
  if (!isPidAlive(candidate.pid)) {
    const ownerPid = candidate.port ? await readLocalServicePortOwner(candidate.port) : null;
    if (!ownerPid) {
      await removeLocalServiceRegistryRecord(candidate.serviceKey);
      return null;
    }
    candidate = {
      ...candidate,
      pid: ownerPid,
      processGroupId: candidate.processGroupId && isPidAlive(candidate.processGroupId) ? candidate.processGroupId : ownerPid,
      lastSeenAt: new Date().toISOString(),
    };
    await writeLocalServiceRegistryRecord(candidate);
  }

  if (!(await isLikelyMatchingCommand(candidate))) {
    await removeLocalServiceRegistryRecord(record.serviceKey);
    return null;
  }

  return candidate;
}

export function isPidAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isProcessGroupAlive(processGroupId: number | null | undefined) {
  if (process.platform === "win32") return false;
  if (typeof processGroupId !== "number" || !Number.isInteger(processGroupId) || processGroupId <= 0) return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch {
    return false;
  }
}

async function isLikelyMatchingCommand(record: LocalServiceRegistryRecord) {
  if (process.platform === "win32") return true;
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "command=", "-p", String(record.pid)]);
    const commandLine = stdout.trim();
    if (!commandLine) return false;
    const normalize = (value: string) => value.replace(/["']/g, "").replace(/\s+/g, " ").trim();
    const normalizedCommandLine = normalize(commandLine);
    const normalizedRecordedCommand = normalize(record.command);
    return normalizedCommandLine.includes(normalizedRecordedCommand) || normalizedCommandLine.includes(record.serviceName);
  } catch {
    return true;
  }
}

async function verifyWindowsRegistryRecord(record: LocalServiceRegistryRecord) {
  if (!hasWindowsProcessIdentities(record.windowsProcessTree)) {
    throw new Error(`Windows identity unavailable for ${record.serviceKey}; registry retained`);
  }
  const captured = await windowsServiceProcessTree({ action: "verify", rootPid: record.pid, identities: record.windowsProcessTree });
  if (captured.error) throw new Error(captured.error);
  if (!captured.identities.length) {
    if (record.stopError) throw new Error(`Service ${record.serviceKey} has unresolved stop evidence: ${record.stopError}; registry retained`);
    if (record.port && await isLocalServicePortListening(record.port)) {
      throw new Error(`Service ${record.serviceKey} still has a listener without verified process custody; registry retained`);
    }
    await removeLocalServiceRegistryRecord(record.serviceKey);
    return null;
  }
  // Preserve the original root PID. An orphan descendant remains reachable via
  // its saved identity; never substitute an arbitrary current port owner.
  return record;
}

export async function isLocalServicePortListening(port: number) {
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    const finish = (listening: boolean) => { socket.destroy(); resolve(listening); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1000, () => finish(true)); // Uncertain shutdown fails closed.
  });
}

export async function findAdoptableLocalService(input: {
  serviceKey: string;
  command?: string | null;
  cwd?: string | null;
  envFingerprint?: string | null;
  port?: number | null;
}) {
  const record = await readLocalServiceRegistryRecord(input.serviceKey);
  if (!record) return null;

  if (process.platform === "win32") {
    if (!(await verifyWindowsRegistryRecord(record))) return null;
    if (input.command && record.command !== input.command) return null;
    if (input.cwd && path.resolve(record.cwd) !== path.resolve(input.cwd)) return null;
    if (input.envFingerprint && record.envFingerprint !== input.envFingerprint) return null;
    if (input.port != null && record.port !== input.port) return null;
    return record;
  }

  if (!isPidAlive(record.pid)) {
    await removeLocalServiceRegistryRecord(input.serviceKey);
    return null;
  }
  if (!(await isLikelyMatchingCommand(record))) {
    await removeLocalServiceRegistryRecord(input.serviceKey);
    return null;
  }
  if (input.command && record.command !== input.command) return null;
  if (input.cwd && path.resolve(record.cwd) !== path.resolve(input.cwd)) return null;
  if (input.envFingerprint && record.envFingerprint !== input.envFingerprint) return null;
  if (input.port !== undefined && input.port !== null && record.port !== input.port) return null;
  return record;
}

export async function touchLocalServiceRegistryRecord(
  serviceKey: string,
  patch?: Partial<Omit<LocalServiceRegistryRecord, "serviceKey" | "version">>,
) {
  const existing = await readLocalServiceRegistryRecord(serviceKey);
  if (!existing) return null;
  const next: LocalServiceRegistryRecord = {
    ...existing,
    ...patch,
    version: 1,
    serviceKey,
    lastSeenAt: patch?.lastSeenAt ?? new Date().toISOString(),
  };
  await writeLocalServiceRegistryRecord(next);
  return next;
}

export async function terminateLocalService(
  record: Pick<LocalServiceRegistryRecord, "pid" | "processGroupId"> & Partial<LocalServiceRegistryRecord>,
  opts?: { signal?: NodeJS.Signals; forceAfterMs?: number },
) {
  // Registry-backed stops must never fall back to PID-only signalling. Raw
  // heartbeat/recovery callers omit serviceKey and retain their existing contract.
  if (process.platform === "win32" && (record.serviceKey !== undefined || record.windowsProcessTree !== undefined)) {
    if (!hasWindowsProcessIdentities(record.windowsProcessTree)) {
      // Do not touch/rewrite a legacy record: the writer captures missing
      // identities, which would turn an untrusted saved PID into fresh custody.
      throw new Error(`Windows identity unavailable for ${record.serviceKey ?? record.pid}; registry retained`);
    }
    try {
      const stopped = await windowsServiceProcessTree({
        action: "stop", rootPid: record.pid, identities: record.windowsProcessTree, waitMs: opts?.forceAfterMs,
        registryPath: record.serviceKey ? getRuntimeServiceRegistryPath(record.serviceKey) : undefined,
        registryRecord: { ...record },
      });
      if (stopped.error) throw new Error(stopped.error);
      if (record.port && await isLocalServicePortListening(record.port)) {
        throw new Error(`Service port ${record.port} still listens after owned-tree termination; ownership retained`);
      }
    } catch (error) {
      if (record.serviceKey) await touchLocalServiceRegistryRecord(record.serviceKey, { stopError: String(error) });
      throw error;
    }
    return;
  }
  const signal = opts?.signal ?? "SIGTERM";
  const targetProcessGroup = process.platform !== "win32" && record.processGroupId && record.processGroupId > 0;
  try {
    if (targetProcessGroup) {
      process.kill(-record.processGroupId!, signal);
    } else {
      process.kill(record.pid, signal);
    }
  } catch {
    return;
  }

  const deadline = Date.now() + (opts?.forceAfterMs ?? 2_000);
  while (Date.now() < deadline) {
    const targetAlive = targetProcessGroup
      ? isProcessGroupAlive(record.processGroupId)
      : isPidAlive(record.pid);
    if (!targetAlive) {
      return;
    }
    await delay(100);
  }

  const stillAlive = targetProcessGroup
    ? isProcessGroupAlive(record.processGroupId)
    : isPidAlive(record.pid);
  if (!stillAlive) return;
  try {
    if (targetProcessGroup) {
      process.kill(-record.processGroupId!, "SIGKILL");
    } else {
      process.kill(record.pid, "SIGKILL");
    }
  } catch {
    // Ignore cleanup races.
  }
}

export async function readLocalServicePortOwner(port: number) {
  if (!Number.isInteger(port) || port <= 0 || process.platform === "win32") return null;
  try {
    const { stdout } = await execFileAsync("lsof", ["-nPiTCP", `:${port}`, "-sTCP:LISTEN", "-t"]);
    const firstPid = stdout
      .split("\n")
      .map((line) => Number.parseInt(line.trim(), 10))
      .find((value) => Number.isInteger(value) && value > 0);
    return firstPid ?? null;
  } catch {
    return null;
  }
}

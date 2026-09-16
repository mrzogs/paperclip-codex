import { createHash, timingSafeEqual } from "node:crypto";

export const RELEASE = "2.1.0";
export const API_VERSION = "ocean-workflow/v1";
export const MAX_BODY_BYTES = 256 * 1024;
export const ROLES = Object.freeze({
  BRAIN: ["read", "artifact.write", "case.transition", "approval.request", "delivery", "event.write"],
  TELEMETRY: ["read", "event.write", "health.write"],
  STRATEGY: ["read", "artifact.write", "case.transition", "delivery", "event.write"],
});

export class WorkflowError extends Error {
  constructor(status, code, message = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export function requireThat(condition, status, code) {
  if (!condition) throw new WorkflowError(status, code);
}
export function id(value, test = false) {
  requireThat(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value), 422, "INVALID_ID");
  if (test) requireThat(value.startsWith("test-"), 403, "TEST_NAMESPACE_REQUIRED");
  return value;
}
export function strategyId(value) {
  requireThat(typeof value === "string" && /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/.test(value), 422, "INVALID_STRATEGY_ID");
  return value;
}
export function exactKeys(value, keys) {
  requireThat(value && typeof value === "object" && !Array.isArray(value), 422, "OBJECT_REQUIRED");
  requireThat(Object.keys(value).every((key) => keys.includes(key)), 422, "UNKNOWN_OR_AUTHORITY_FIELD");
}
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
export const objectHash = (value) => digest(canonical(value));
export function sealedHash(value, field) {
  const copy = { ...value };
  delete copy[field];
  return objectHash(copy);
}
export function equalSecret(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}
export function future(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.now();
}
export function noSecrets(value, environment) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  requireThat(!/ocean_(?:service|browser|password)_v1\.|Bearer\s+[A-Za-z0-9._-]+/i.test(text), 422, "SECRET_CONTENT_REJECTED");
  for (const [key, secret] of Object.entries(environment)) {
    if (/(?:TOKEN|SECRET|PASSWORD|API_KEY)$/.test(key) && typeof secret === "string" && secret.length >= 12) {
      requireThat(!text.includes(secret), 422, "SECRET_CONTENT_REJECTED");
    }
  }
}

export function configuredProcessTimeoutMs(name, fallbackMs, options = {}) {
  const minimumMs = Number(options.minimumMs ?? 1000);
  const maximumMs = Number(options.maximumMs ?? 900000);
  const configured = Number(process.env[name]);
  const selected = Number.isFinite(configured) && configured > 0 ? configured : fallbackMs;
  return Math.max(minimumMs, Math.min(selected, maximumMs));
}

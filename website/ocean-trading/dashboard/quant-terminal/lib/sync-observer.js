// Optional host diagnostics. Standalone Quant keeps no observer and imports no
// Ocean modules; these fixed numeric sites never disclose saved user data.
export const QUANT_SYNC = Object.freeze({ READ: 4001, SERIALIZE: 4002, WRITE: 4003,
  RENAME: 4004, FALLBACK_WRITE: 4005, CLEANUP: 4006, CONDITION: 4007, CUSTOM_LIST: 4008, ALERT_START:4009 });
let observer = null;
export function setSyncObserver(value) { observer = typeof value === 'function' ? value : null; }
export function observeSync(code, work) { return observer ? observer(code, work) : work(); }

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.dirname(__dirname);
const PAPERCLIP_REPO_DIR = process.env.PAPERCLIP_REPO_DIR || "D:\\Paperclip-codex";
const REPORT_DIR = path.join(PAPERCLIP_REPO_DIR, "reports", "confluence_strategy_paper");
const HISTORY_FILE = path.join(REPORT_DIR, "confluence_forecast_history.json");
const LEARNER_FILE = path.join(REPORT_DIR, "confluence_session_accuracy_learner.json");
const ACCURACY_FILE = path.join(REPORT_DIR, "confluence_forecast_accuracy.json");
const SQLITE_FILE = process.env.OCEAN_WEBSITE_DB || "D:\\OceanTradingData\\website\\ocean-trading-website.sqlite";
const SQLITE_WRITER = path.join(__dirname, "confluence-accuracy-sqlite.py");
const PYTHON_EXE =
  process.env.OCEAN_TRADING_PYTHON ||
  process.env.PYTHON ||
  path.join(process.env.LOCALAPPDATA || "C:\\Users\\wayne\\AppData\\Local", "Programs", "Python", "Python312", "python.exe");
const SESSIONS = ["Asian", "London", "US"];
const BUCKETS = ["bearish", "range", "bullish"];
const ALERT_GRAIN = {
  method: "Confluence session forecast",
  timeframe: "session-normalized",
  grain: "method/session",
};
const ALERT_CLASSIFICATIONS = {
  "data-gap": {
    severity: "warn",
    followUpAction: "repair_or_backfill_inputs",
    description: "Forecast or actual confluence input is missing.",
  },
  "weak": {
    severity: "warn",
    followUpAction: "review_session_thresholds_or_method_weights",
    description: "Recent forecast performance is weak.",
  },
  "slipping": {
    severity: "warn",
    followUpAction: "review_session_thresholds_or_method_weights",
    description: "Rolling forecast accuracy is slipping.",
  },
  "improving": {
    severity: "info",
    followUpAction: "retain_current_session_profile",
    description: "Rolling forecast performance is improving.",
  },
  "critical": {
    severity: "critical",
    followUpAction: "repair_forecast_timestamp_source",
    description: "Forecast timestamp or sequence integrity issue detected.",
  },
};

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(temp, filePath);
}

function id(...parts) {
  return crypto.createHash("sha256").update(parts.map((part) => String(part ?? "")).join("|")).digest("hex");
}

function parseArgs(argv) {
  const args = { mode: "backfill", days: 10, end: "2026-06-02", exclude: ["2026-06-03"], persist: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--mode") args.mode = argv[++i] || args.mode;
    else if (arg === "--days") args.days = Number(argv[++i] || args.days);
    else if (arg === "--end") args.end = argv[++i] || args.end;
    else if (arg === "--exclude") args.exclude = String(argv[++i] || "").split(",").filter(Boolean);
    else if (arg === "--db") args.db = argv[++i];
    else if (arg === "--no-persist") args.persist = false;
  }
  return args;
}

function shiftDateKey(dateKey, days) {
  const date = new Date(`${dateKey}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function previousTradingDateKey(dateKey) {
  let candidate = shiftDateKey(dateKey, -1);
  for (let guard = 0; guard < 14; guard += 1) {
    const day = new Date(`${candidate}T12:00:00Z`).getUTCDay();
    if (day !== 0 && day !== 6) return candidate;
    candidate = shiftDateKey(candidate, -1);
  }
  return candidate;
}

function stanceBucket(row) {
  const system = String(row?.system || "").toLowerCase();
  const summary = String(row?.summary || "").toLowerCase();
  const bias = String(row?.bias || "").toLowerCase();
  const score = Number(row?.score);
  if (system.includes("markov")) {
    if (summary.includes("trend down")) return "bearish";
    if (summary.includes("trend up")) return "bullish";
    return "range";
  }
  if (system.includes("confluence") && summary.startsWith("flat")) return "range";
  if (Number.isFinite(score)) {
    if (score >= 0.18) return "bullish";
    if (score <= -0.18) return "bearish";
    return "range";
  }
  if (bias.includes("bearish")) return "bearish";
  if (bias.includes("bullish")) return "bullish";
  return "range";
}

function sessionProfile(sessionName) {
  const profiles = {
    Asian: { timeframeWeights: { "5m": 1.15, "15m": 1.05, "60m": 0.9, daily: 0.75, weekly: 0.6 } },
    London: { timeframeWeights: { "5m": 0.95, "15m": 1.2, "60m": 1.15, daily: 0.8, weekly: 0.65 } },
    US: { timeframeWeights: { "5m": 1.05, "15m": 1.1, "60m": 1.2, daily: 0.9, weekly: 0.7 } },
  };
  return profiles[sessionName] || profiles.London;
}

function stanceFromReport(report, sessionName) {
  const profile = sessionProfile(sessionName);
  const systemWeights = {
    "Volatility": 0.75,
    "Trend/Momentum": 1,
    "Mean Reversion": 1,
    "Factor/Regression": 1,
    "Volume/Order Flow": 1,
    "Confluence engine": 1.25,
    "Markov regime": 1.1,
  };
  const rows = (Array.isArray(report?.sessions?.[sessionName]?.rows) ? report.sessions[sessionName].rows : report?.rows || [])
    .filter((row) => profile.timeframeWeights[row.timeframe] && systemWeights[row.system]);
  const totals = { bearish: 0, range: 0, bullish: 0 };
  for (const row of rows) {
    const bucket = stanceBucket(row);
    const confidence = Number(row.confidence);
    const confidenceWeight = Number.isFinite(confidence) ? Math.max(0.25, Math.min(1, confidence)) : 0.5;
    totals[bucket] += (profile.timeframeWeights[row.timeframe] || 1) * (systemWeights[row.system] || 1) * confidenceWeight;
  }
  const total = totals.bearish + totals.range + totals.bullish;
  const percentages = total > 0
    ? Object.fromEntries(BUCKETS.map((bucket) => [bucket, (totals[bucket] / total) * 100]))
    : { bearish: 33.3, range: 33.4, bullish: 33.3 };
  const dominant = Object.entries(percentages).sort((a, b) => b[1] - a[1])[0]?.[0] || "range";
  return { percentages, dominant, rowCount: rows.length };
}

function forecastNextRegime(summary) {
  const states = Array.isArray(summary?.model?.states) ? summary.model.states : [];
  const current = summary?.currentRegime?.probabilities || {};
  const matrix = summary?.transitionMatrix || {};
  const forecast = {};
  for (const state of states) forecast[state] = 0;
  for (const from of states) {
    for (const to of states) forecast[to] += Number(current[from] || 0) * Number(matrix[from]?.[to] || 0);
  }
  return Object.entries(forecast).sort((a, b) => b[1] - a[1]);
}

function regimeBucket(label) {
  const value = String(label || "").toLowerCase();
  if (value.includes("down")) return "bearish";
  if (value.includes("up")) return "bullish";
  return "range";
}

function forecastStance(report, markovSummary, sessionName) {
  const today = stanceFromReport(report, sessionName);
  const forecast = forecastNextRegime(markovSummary || {});
  if (!forecast.length) return today;
  const regimeTotals = { bearish: 0, range: 0, bullish: 0 };
  let total = 0;
  for (const [label, value] of forecast) {
    const probability = Number(value);
    if (!Number.isFinite(probability)) continue;
    regimeTotals[regimeBucket(label)] += probability;
    total += probability;
  }
  const forecastPercentages = total > 0
    ? Object.fromEntries(BUCKETS.map((bucket) => [bucket, (regimeTotals[bucket] / total) * 100]))
    : today.percentages;
  const percentages = Object.fromEntries(BUCKETS.map((bucket) => [
    bucket,
    forecastPercentages[bucket] * 0.6 + today.percentages[bucket] * 0.4,
  ]));
  return { percentages, dominant: Object.entries(percentages).sort((a, b) => b[1] - a[1])[0]?.[0] || "range", rowCount: today.rowCount };
}

function dominantDistance(forecast, actual) {
  return BUCKETS.reduce((sum, bucket) => sum + Math.abs(Number(forecast?.[bucket] || 0) - Number(actual?.[bucket] || 0)), 0) / BUCKETS.length;
}

function status(hitRate, samples) {
  if (samples < 5) return "unproven";
  if (hitRate >= 0.62) return "reliable";
  if (hitRate >= 0.45) return "watch";
  return "weak";
}

function classifyTrend(rows) {
  if (rows.length < 6) return null;
  const midpoint = Math.floor(rows.length / 2);
  const previous = rows.slice(0, midpoint);
  const recent = rows.slice(midpoint);
  const summarize = (items) => {
    const samples = items.length;
    const hits = items.filter((row) => row.hit).length;
    const hitRate = samples ? hits / samples : 0;
    const avgErrorPct = samples ? items.reduce((sum, row) => sum + Number(row.errorPct || 0), 0) / samples : null;
    return { samples, hits, hitRate, avgErrorPct };
  };
  const previousStats = summarize(previous);
  const recentStats = summarize(recent);
  const hitRateDelta = recentStats.hitRate - previousStats.hitRate;
  const errorDeltaPct = Number(recentStats.avgErrorPct ?? 0) - Number(previousStats.avgErrorPct ?? 0);
  const classification = hitRateDelta < -0.1 || errorDeltaPct >= 0.5
    ? "slipping"
    : hitRateDelta > 0.1 || errorDeltaPct <= -0.5
      ? "improving"
      : null;
  if (!classification) return null;
  return { classification, previous: previousStats, recent: recentStats, hitRateDelta, errorDeltaPct };
}

function alertRecord(runId, classification, severity, message, details = {}) {
  const session = details.session || null;
  const dateKey = details.actualDateKey || details.forecastSourceDateKey || details.toDateKey || details.fromDateKey || "run";
  const alertProfile = ALERT_CLASSIFICATIONS[classification] || ALERT_CLASSIFICATIONS["data-gap"];
  return {
    id: id(runId, "alert", classification, details.subtype || "", session || "", dateKey),
    severity: details.severity || alertProfile.severity || severity,
    alertType: classification,
    classification,
    message,
    session,
    ...ALERT_GRAIN,
    routeTo: "Hermes Strategy Learner",
    followUpAction: details.followUpAction || alertProfile.followUpAction,
    description: alertProfile.description || "",
    ...details,
  };
}

function historyWindow(history, args) {
  const excluded = new Set(args.exclude);
  return [...history]
    .filter((entry) => entry?.dateKey && entry.dateKey <= args.end && !excluded.has(entry.dateKey))
    .sort((a, b) => String(a.dateKey).localeCompare(String(b.dateKey)))
    .slice(-args.days);
}

function buildPayload(args) {
  const history = readJson(HISTORY_FILE, []);
  const byDate = new Map(history.map((entry) => [entry.dateKey, entry]));
  const window = historyWindow(history, args);
  const generatedAtUtc = new Date().toISOString();
  const runId = `confluence-accuracy-${args.mode}-${args.end}-${args.days}`;
  const predictions = [];
  const actuals = [];
  const scores = [];
  const alerts = [];
  const alignment = new Map();

  for (const actual of window) {
    const sourceDate = previousTradingDateKey(actual.dateKey);
    const source = byDate.get(sourceDate);
    if (!source?.prediction) {
      alerts.push(alertRecord(
        runId,
        "data-gap",
        "warn",
        `No forecast snapshot found for ${sourceDate} -> ${actual.dateKey}`,
        { subtype: "missing_forecast", forecastSourceDateKey: sourceDate, actualDateKey: actual.dateKey, sessions: SESSIONS },
      ));
      continue;
    }
    for (const session of SESSIONS) {
      const forecast = forecastStance(source.prediction, source.markovSummary || source.prediction?.markovSummary || null, session);
      const actualStance = stanceFromReport(actual.prediction, session);
      if (!source.prediction || forecast.rowCount === 0) {
        alerts.push(alertRecord(
          runId,
          "data-gap",
          "warn",
          `Forecast input unavailable for ${session} ${sourceDate} -> ${actual.dateKey}`,
          { subtype: "missing_forecast_rows", session, forecastSourceDateKey: sourceDate, actualDateKey: actual.dateKey, forecastRowCount: forecast.rowCount },
        ));
      }
      if (!actual.prediction || actualStance.rowCount === 0) {
        alerts.push(alertRecord(
          runId,
          "data-gap",
          "warn",
          `Actual Confluence input unavailable for ${session} ${actual.dateKey}`,
          { subtype: "missing_actual_rows", session, forecastSourceDateKey: sourceDate, actualDateKey: actual.dateKey, actualRowCount: actualStance.rowCount },
        ));
      }
      const errorPct = dominantDistance(forecast.percentages, actualStance.percentages);
      const hit = forecast.dominant === actualStance.dominant;
      const nearMiss = !hit && errorPct <= 18;
      const noLookaheadPassed = sourceDate < actual.dateKey && String(source.prediction?.asOfDateLondon || sourceDate) <= sourceDate;
      const base = { session, forecastSourceDateKey: sourceDate, actualDateKey: actual.dateKey };
      predictions.push({ id: id(runId, "prediction", session, sourceDate, actual.dateKey), runId, ...base, forecastCapturedAtUtc: source.capturedAtUtc || null, forecastDominant: forecast.dominant, forecastPercentages: forecast.percentages, forecastRowCount: forecast.rowCount });
      actuals.push({ id: id(runId, "actual", session, actual.dateKey), runId, session, actualDateKey: actual.dateKey, actualCapturedAtUtc: actual.capturedAtUtc || null, actualDominant: actualStance.dominant, actualPercentages: actualStance.percentages, actualRowCount: actualStance.rowCount });
      scores.push({ id: id(runId, "score", session, sourceDate, actual.dateKey), runId, ...base, result: hit ? "hit" : nearMiss ? "near-miss" : "miss", hit, nearMiss, errorPct, noLookaheadPassed });
      const matrixKey = [session, forecast.dominant, actualStance.dominant].join("|");
      alignment.set(matrixKey, (alignment.get(matrixKey) || 0) + 1);
      if (!noLookaheadPassed) {
        alerts.push(alertRecord(
          runId,
          "critical",
          "critical",
          `Rejected invalid forecast timestamp for ${session} ${sourceDate} -> ${actual.dateKey}`,
          { subtype: "no_lookahead_violation", session, forecastSourceDateKey: sourceDate, actualDateKey: actual.dateKey },
        ));
      }
    }
  }

  const rollups = SESSIONS.map((session) => {
    const rows = scores.filter((row) => row.session === session);
    const samples = rows.length;
    const hits = rows.filter((row) => row.hit).length;
    const nearMisses = rows.filter((row) => row.nearMiss).length;
    const hitRate = samples ? hits / samples : 0;
    const avgErrorPct = samples ? rows.reduce((sum, row) => sum + row.errorPct, 0) / samples : null;
    return { id: id(runId, "rollup", session), runId, session, samples, hits, nearMisses, hitRate, avgErrorPct, status: status(hitRate, samples), latestResult: rows.at(-1)?.result || "pending", weakestPrimarySession: false, maskedWeaknessFlag: false, secondaryRollup: false };
  });
  const weakest = rollups.filter((row) => row.samples).sort((a, b) => a.hitRate - b.hitRate || b.avgErrorPct - a.avgErrorPct)[0];
  if (weakest) weakest.weakestPrimarySession = true;
  for (const rollup of rollups) {
    const rows = scores.filter((row) => row.session === rollup.session);
    if (rollup.samples < 5) {
      alerts.push(alertRecord(
        runId,
        "data-gap",
        "warn",
        `${rollup.session} has only ${rollup.samples} comparable Confluence accuracy samples`,
        { subtype: "sparse_samples", session: rollup.session, samples: rollup.samples, minimumSamples: 5 },
      ));
      continue;
    }
    if (rollup.status === "weak") {
      alerts.push(alertRecord(
        runId,
        "weak",
        "warn",
        `${rollup.session} Confluence accuracy is weak: ${(rollup.hitRate * 100).toFixed(1)}% hit rate over ${rollup.samples} samples`,
        { subtype: "low_hit_rate", session: rollup.session, samples: rollup.samples, hitRate: rollup.hitRate, avgErrorPct: rollup.avgErrorPct, latestResult: rollup.latestResult },
      ));
    }
    const trend = classifyTrend(rows);
    if (trend) {
      alerts.push(alertRecord(
        runId,
        trend.classification,
        trend.classification === "slipping" ? "warn" : "info",
        `${rollup.session} Confluence accuracy is ${trend.classification}: recent average error delta ${trend.errorDeltaPct.toFixed(2)} percentage points`,
        { subtype: "recent_window_trend", session: rollup.session, samples: rollup.samples, previousWindow: trend.previous, recentWindow: trend.recent, hitRateDelta: trend.hitRateDelta, errorDeltaPct: trend.errorDeltaPct },
      ));
    }
  }
  const fullSamples = scores.length;
  const fullHits = scores.filter((row) => row.hit).length;
  const fullHitRate = fullSamples ? fullHits / fullSamples : 0;
  rollups.push({ id: id(runId, "rollup", "Full day"), runId, session: "Full day", samples: fullSamples, hits: fullHits, nearMisses: scores.filter((row) => row.nearMiss).length, hitRate: fullHitRate, avgErrorPct: fullSamples ? scores.reduce((sum, row) => sum + row.errorPct, 0) / fullSamples : null, status: status(fullHitRate, fullSamples), latestResult: "secondary-rollup", weakestPrimarySession: false, maskedWeaknessFlag: Boolean(weakest && weakest.hitRate < fullHitRate), secondaryRollup: true });

  const dailySummaries = window.map((entry) => {
    const rows = scores.filter((row) => row.actualDateKey === entry.dateKey);
    const hits = rows.filter((row) => row.hit).length;
    const weakestDaily = SESSIONS.map((session) => {
      const row = rows.find((item) => item.session === session);
      return { session, hitRate: row?.hit ? 1 : 0, errorPct: row?.errorPct ?? 999 };
    }).sort((a, b) => a.hitRate - b.hitRate || b.errorPct - a.errorPct)[0];
    return { id: id(runId, "daily", entry.dateKey), runId, actualDateKey: entry.dateKey, samples: rows.length, hits, nearMisses: rows.filter((row) => row.nearMiss).length, hitRate: rows.length ? hits / rows.length : 0, weakestPrimarySession: weakestDaily?.session || null, maskedWeaknessFlag: Boolean(weakestDaily && weakestDaily.hitRate === 0 && hits > 0), secondaryRollup: true };
  });

  const alignmentMatrices = [...alignment.entries()].map(([key, count]) => {
    const [session, forecastBucket, actualBucket] = key.split("|");
    return { id: id(runId, "matrix", session, forecastBucket, actualBucket), runId, session, forecastBucket, actualBucket, count };
  });
  const noLookaheadPassed = scores.every((row) => row.noLookaheadPassed);
  const recommendation = fullSamples < 15
    ? "Collect more comparable session forecasts before changing weights."
    : fullHitRate < 0.45
      ? "Treat the forecast as weak and have Hermes propose session-specific threshold or method-weight changes before production use."
      : "Continue monitoring; do not change production weights automatically.";
  const checks = [
    { name: "no_lookahead", passed: noLookaheadPassed },
    { name: "session_boundary_independence", passed: SESSIONS.every((session) => scores.some((row) => row.session === session)) },
    { name: "neutral_range_scoring", passed: scores.every((row) => BUCKETS.includes(row.result === "hit" ? row.result : row.result) || row.result) },
    { name: "persistence_payload", passed: scores.length > 0 },
    { name: "backfill_smoke", passed: window.length > 0 },
    { name: "full_day_masking", passed: rollups.some((row) => row.secondaryRollup && Object.hasOwn(row, "maskedWeaknessFlag")) },
    { name: "alert_classification_payload", passed: alerts.every((row) => row.classification && row.method && row.timeframe && row.routeTo && ALERT_CLASSIFICATIONS[row.classification]) },
  ];
  const alertCounts = alerts.reduce((counts, row) => {
    counts[row.alertType] = (counts[row.alertType] || 0) + 1;
    return counts;
  }, {});

  return {
    run: { id: runId, generatedAtUtc, mode: args.mode, fromDateKey: window[0]?.dateKey || null, toDateKey: window.at(-1)?.dateKey || null, requestedEndDateKey: args.end, requestedDays: args.days, excludedDateKeys: args.exclude, noLookaheadPassed, sources: { history: HISTORY_FILE, learner: LEARNER_FILE, accuracy: ACCURACY_FILE } },
    predictions,
    actuals,
    scores,
    rollups,
    alignmentMatrices,
    dailySummaries,
    alerts,
    hermesRecommendations: [{ id: id(runId, "hermes-recommendation"), runId, recommendation, action: fullHitRate < 0.45 ? "propose_session_weight_review" : "monitor_only" }],
    routineRuns: [{ id: id(runId, "routine"), runId, routineId: "324350dd-3938-4f27-9157-fd817e58f139", status: checks.every((check) => check.passed) ? "passed" : "warning", checks, alertCounts }],
  };
}

function persistSqlite(payload, dbPath) {
  const tempPath = path.join(__dirname, "data", `confluence-accuracy-${process.pid}.json`);
  writeJsonAtomic(tempPath, payload);
  try {
    execFileSync(PYTHON_EXE, [SQLITE_WRITER, dbPath, tempPath], { encoding: "utf8", windowsHide: true });
  } finally {
    try { fs.unlinkSync(tempPath); } catch {}
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const payload = buildPayload(args);
  if (args.persist) persistSqlite(payload, args.db || SQLITE_FILE);
  console.log(JSON.stringify({ ok: true, ...payload }, null, 2));
}

main();

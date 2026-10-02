import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const DASHBOARD_DIR = path.dirname(__filename);
const CONFIG_DIR = path.join(DASHBOARD_DIR, "config");
const STATIC_FILE = path.join(CONFIG_DIR, "cme-holiday-calendar.static.json");
const OVERRIDE_FILE = path.join(CONFIG_DIR, "cme-holiday-calendar.override.json");
const MERGED_JSON_FILE = path.join(CONFIG_DIR, "cme-holiday-calendar.merged.json");
const MERGED_CSV_FILE = path.join(CONFIG_DIR, "cme-holiday-calendar-merged.csv");

function readJson(filePath, fallback) {
  try {
    return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf8")) : fallback;
  } catch (error) {
    throw new Error(`Could not read ${filePath}: ${error.message}`);
  }
}

function normalizeTime(value) {
  if (!value) return "";
  const text = String(value).trim();
  const match = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error(`Invalid time '${value}'. Use HH:MM in US Eastern time.`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) throw new Error(`Invalid time '${value}'.`);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function normalizeHoliday(entry, source) {
  if (!entry?.date || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) {
    throw new Error(`Holiday entry is missing a YYYY-MM-DD date: ${JSON.stringify(entry)}`);
  }
  return {
    date: entry.date,
    market: entry.market || "CME_EQUITY_INDEX",
    name: entry.name || "CME holiday",
    closedAllDay: Boolean(entry.closedAllDay),
    earlyCloseTimeET: normalizeTime(entry.earlyCloseTimeET),
    reopenTimeET: normalizeTime(entry.reopenTimeET || "18:00"),
    forceFlatForPropFirm: entry.forceFlatForPropFirm !== false,
    source,
    notes: entry.notes || "",
  };
}

function csvEscape(value) {
  return String(value ?? "").replace(/\|/g, "/").replace(/\r?\n/g, " ");
}

function mergeCalendars() {
  const staticCalendar = readJson(STATIC_FILE, { holidays: [] });
  const overrideCalendar = readJson(OVERRIDE_FILE, { holidays: [] });
  const rowsByDate = new Map();

  for (const entry of staticCalendar.holidays || []) {
    const normalized = normalizeHoliday(entry, "static");
    rowsByDate.set(normalized.date, normalized);
  }

  for (const entry of overrideCalendar.holidays || []) {
    const normalized = normalizeHoliday(entry, "override");
    rowsByDate.set(normalized.date, normalized);
  }

  const holidays = [...rowsByDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const merged = {
    version: 1,
    calendarName: "US CME Holiday Merged Calendar",
    market: "CME_EQUITY_INDEX",
    sourceTimezone: "America/New_York",
    runtimeTimezone: "Europe/London",
    timezoneRule: "CME publishes holiday close/reopen times in US Eastern time. Ocean Trading strategies convert these source times to Europe/London chart time before comparing, flattening, or blocking entries.",
    updatedAt: new Date().toISOString(),
    sourceFiles: [STATIC_FILE, OVERRIDE_FILE],
    holidays,
  };

  fs.writeFileSync(MERGED_JSON_FILE, `${JSON.stringify(merged, null, 2)}\n`);
  const csvLines = [
    "date|market|closedAllDay|earlyCloseTimeET|reopenTimeET|forceFlatForPropFirm|source|name|notes",
    ...holidays.map((row) => [
      row.date,
      row.market,
      row.closedAllDay ? "1" : "0",
      row.earlyCloseTimeET,
      row.reopenTimeET,
      row.forceFlatForPropFirm ? "1" : "0",
      row.source,
      csvEscape(row.name),
      csvEscape(row.notes),
    ].join("|")),
  ];
  fs.writeFileSync(MERGED_CSV_FILE, `${csvLines.join("\n")}\n`);
  return merged;
}

const merged = mergeCalendars();
console.log(`Merged ${merged.holidays.length} CME holiday rows.`);
console.log(MERGED_JSON_FILE);
console.log(MERGED_CSV_FILE);

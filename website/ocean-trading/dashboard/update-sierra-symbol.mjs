import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DASHBOARD_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DASHBOARD_DIR, "..");
const STRATEGIES_DIR = path.join(ROOT, "strategies");
const CONFIG_FILE = path.join(DASHBOARD_DIR, "config", "sierra-symbols.json");
const BUILD_MANIFEST = path.join(DASHBOARD_DIR, "build-manifest.mjs");
const HANDOFF_FILE = path.join(STRATEGIES_DIR, "paper_trading_handoff_2026-05-14.md");
const STATUS_FILE = path.join(STRATEGIES_DIR, "paper_trading_status_2026-05-14.md");
const DEFAULT_PAPER_ROOT = "D:\\Trading\\SierraChart-PaperTrading";
const SIERRA_TRANSLATE_SYMBOLS_COMMAND = 57099;
const SIERRA_SAVE_ALL_COMMAND = 57021;

function parseArgs(argv) {
  const args = {
    instance: "paper",
    translateSierra: false,
    rebuild: true,
    verify: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--no-rebuild") args.rebuild = false;
    else if (arg === "--no-verify") args.verify = false;
    else if (arg === "--translate-sierra") args.translateSierra = true;
    else if (arg.startsWith("--")) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      args[key] = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

function usage() {
  console.log(`Usage:
node dashboard/update-sierra-symbol.mjs --symbol MNQM26_FUT_CME --display-symbol "MNQM26_FUT_CME[M]" --service "Teton CME Routing" [--translate-sierra]

Required:
  --symbol           Sierra data symbol without chart suffix, e.g. MNQM26_FUT_CME

Optional:
  --display-symbol   Chart display symbol, e.g. MNQM26_FUT_CME[M]. Defaults to --symbol.
  --service          Feed/routing service name for the audit note.
  --root             Sierra instance root. Defaults to D:\\Trading\\SierraChart-PaperTrading.
  --chartbook        Chartbook path. Defaults to Data\\OceanTrading-PaperTrading.cht under --root.
  --translate-sierra Also ask the running Sierra paper instance to translate symbols and save all.
  --no-rebuild       Do not rebuild dashboard-data.json after updating metadata.
  --no-verify        Skip listing matching Sierra chart windows after update.
`);
}

function readJson(filePath, fallback) {
  try {
    return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf8")) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function replaceOrInsertLine(text, pattern, replacement, anchorPattern) {
  if (pattern.test(text)) return text.replace(pattern, replacement);
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => anchorPattern.test(line));
  if (index >= 0) {
    lines.splice(index + 1, 0, replacement);
    return lines.join("\n");
  }
  return `${text.trimEnd()}\n${replacement}\n`;
}

function updatePaperMarkdown(filePath, config, today) {
  if (!fs.existsSync(filePath)) return false;
  let text = fs.readFileSync(filePath, "utf8");
  const dataFile = config.dataFile || path.join(config.dataFolder, `${config.symbol}.scid`);
  const note = `- Symbol translation note: updated on ${today} for ${config.service || "current Sierra service"}; run \`node dashboard/update-sierra-symbol.mjs --symbol ${config.symbol} --display-symbol "${config.displaySymbol}" --translate-sierra\` after future feed/account symbol changes.`;

  text = replaceOrInsertLine(text, /^- Active Sierra symbol: `[^`]+`$/m, `- Active Sierra symbol: \`${config.displaySymbol}\``, /^## Active Paper-Trading Instrument|^## Current Instrument Override/);
  text = replaceOrInsertLine(text, /^- Current data file: `[^`]+`$/m, `- Current data file: \`${dataFile}\``, /^- Active Sierra symbol:/);
  text = replaceOrInsertLine(text, /^- Symbol translation note: .*$/m, note, /^- Current data file:/);
  text = text.replace(/- Active execution instrument override: `[^`]+` on the paper Sierra instance\./g, `- Active execution instrument override: \`${config.displaySymbol}\` on the paper Sierra instance.`);
  text = text.replace(/Sierra Chart symbol\/chart used, which should be `[^`]+`/g, `Sierra Chart symbol/chart used, which should be \`${config.displaySymbol}\``);
  text = text.replace(/active `MNQM6\.CME` charts/g, `active \`${config.displaySymbol}\` charts`);
  text = text.replace(/daily and 4-hour `MNQM6\.CME`/g, `daily and 4-hour \`${config.displaySymbol}\``);

  fs.writeFileSync(filePath, text, "utf8");
  return true;
}

function writeAudit(config, today) {
  const safeSymbol = config.symbol.replace(/[^A-Za-z0-9_.-]/g, "_");
  const filePath = path.join(STRATEGIES_DIR, `paper_symbol_translation_${today}_${safeSymbol}.md`);
  const body = `# Paper Symbol Translation - ${today}

## Summary

The dedicated Sierra Chart paper-trading symbol mapping was updated for the current feed/provider.

- Active paper symbol: \`${config.displaySymbol}\`
- Data/import symbol: \`${config.symbol}\`
- Current data file: \`${config.dataFile}\`
- Sierra instance: \`${config.root}\\SierraChart_64.exe\`
- Chartbook: \`${config.chartbook}\`
- Sierra service: \`${config.service || "unknown"}\`
- Paper account: \`${config.account || "Sim1"}\`

## Standard Change Process

1. Open the dedicated paper Sierra instance.
2. Change or confirm the feed/account provider.
3. Run Sierra Chart \`Edit > Translate Symbols To Current Service\`.
4. Save the chartbook.
5. Run:

\`\`\`sh
node dashboard/update-sierra-symbol.mjs --symbol ${config.symbol} --display-symbol "${config.displaySymbol}" --service "${config.service || ""}" --translate-sierra
\`\`\`

## Notes

- Use \`${config.symbol}.scid\` for new paper-feed historical imports.
- Leave older symbol names in old backtest artifacts as historical provenance unless those artifacts are being regenerated.
`;
  fs.writeFileSync(filePath, body, "utf8");
  return filePath;
}

function runPowerShell(script) {
  return execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function translateRunningSierra(config) {
  const escapedRoot = config.root.replace(/'/g, "''");
  const script = `
$process = Get-Process SierraChart_64 | Where-Object { $_.Path -like '${escapedRoot}*' } | Select-Object -First 1
if (-not $process) { throw 'Running SierraChart_64 process not found for ${escapedRoot}' }
$code = @'
using System;
using System.Runtime.InteropServices;
public class SierraSymbolTools {
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, UInt32 msg, IntPtr wParam, IntPtr lParam);
}
'@
Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue | Out-Null
$WM_COMMAND = 0x0111
[void][SierraSymbolTools]::SendMessage($process.MainWindowHandle, $WM_COMMAND, [IntPtr]${SIERRA_TRANSLATE_SYMBOLS_COMMAND}, [IntPtr]::Zero)
Start-Sleep -Milliseconds 750
[void][SierraSymbolTools]::SendMessage($process.MainWindowHandle, $WM_COMMAND, [IntPtr]${SIERRA_SAVE_ALL_COMMAND}, [IntPtr]::Zero)
Start-Sleep -Milliseconds 750
Write-Output $process.MainWindowTitle
`;
  return runPowerShell(script).trim();
}

function verifyRunningSierra(config) {
  const escapedRoot = config.root.replace(/'/g, "''");
  const needle = config.symbol.replace(/'/g, "''");
  const script = `
$process = Get-Process SierraChart_64 | Where-Object { $_.Path -like '${escapedRoot}*' } | Select-Object -First 1
if (-not $process) { Write-Output 'No running SierraChart_64 process found for ${escapedRoot}'; exit 0 }
$code = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class SierraWindowTools {
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
}
'@
Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue | Out-Null
$titles = New-Object System.Collections.Generic.List[string]
[SierraWindowTools]::EnumChildWindows($process.MainWindowHandle, { param($child,$lp)
  $len = [SierraWindowTools]::GetWindowTextLength($child)
  if ($len -gt 0) {
    $sb = New-Object System.Text.StringBuilder ($len + 1)
    [void][SierraWindowTools]::GetWindowText($child, $sb, $sb.Capacity)
    $title = $sb.ToString()
    if ($title -match '${needle}') { $titles.Add($title) }
  }
  $true
}, [IntPtr]::Zero) | Out-Null
$titles | Sort-Object -Unique
`;
  return runPowerShell(script).trim();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.symbol) {
    usage();
    process.exitCode = 1;
    return;
  }
  if (args.instance !== "paper") {
    throw new Error("Only --instance paper is automated right now. Live symbols should be changed with explicit review.");
  }

  const today = new Date().toISOString().slice(0, 10);
  const existing = readJson(CONFIG_FILE, {});
  const root = args.root || existing.paper?.root || DEFAULT_PAPER_ROOT;
  const dataFolder = args.dataFolder || existing.paper?.dataFolder || path.join(root, "Data");
  const chartbook = args.chartbook || existing.paper?.chartbook || path.join(dataFolder, "OceanTrading-PaperTrading.cht");
  const displaySymbol = args.displaySymbol || args.symbol;
  const dataFile = args.dataFile || path.join(dataFolder, `${args.symbol}.scid`);
  const paper = {
    ...(existing.paper || {}),
    root,
    chartbook,
    dataFolder,
    symbol: args.symbol,
    displaySymbol,
    dataFile,
    account: args.account || existing.paper?.account || "Sim1",
    dataPort: Number(args.dataPort || existing.paper?.dataPort || 11298),
    tradingPort: Number(args.tradingPort || existing.paper?.tradingPort || 11299),
    service: args.service || existing.paper?.service || "",
    updatedAt: today,
    note: args.note || `Updated by update-sierra-symbol.mjs on ${today}.`,
  };

  const next = { ...existing, paper };
  writeJson(CONFIG_FILE, next);
  const handoffUpdated = updatePaperMarkdown(HANDOFF_FILE, paper, today);
  const statusUpdated = updatePaperMarkdown(STATUS_FILE, paper, today);
  const auditFile = writeAudit(paper, today);

  let translateResult = null;
  if (args.translateSierra) {
    translateResult = translateRunningSierra(paper);
  }

  if (args.rebuild) {
    execFileSync("node", [BUILD_MANIFEST], { cwd: DASHBOARD_DIR, stdio: "inherit" });
  }

  let verifyResult = null;
  if (args.verify) {
    verifyResult = verifyRunningSierra(paper);
  }

  console.log(JSON.stringify({
    updatedConfig: CONFIG_FILE,
    activeSymbol: paper.displaySymbol,
    dataSymbol: paper.symbol,
    dataFile: paper.dataFile,
    handoffUpdated,
    statusUpdated,
    auditFile,
    translateResult,
    verifyResult: verifyResult || "No matching running chart windows reported.",
  }, null, 2));
}

main();

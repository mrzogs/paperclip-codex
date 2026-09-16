const currencyFormatter = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const currencyCentsFormatter = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const percentFormatter = new Intl.NumberFormat("en-GB", {
  style: "percent",
  maximumFractionDigits: 1,
});

function formatMaybeNull(value) {
  return value === null || value === undefined || value === "" ? "n/a" : value;
}

function formatCurrency(value) {
  if (value === null || value === undefined || value === "") return formatMaybeNull(value);
  const number = Number(value);
  if (!Number.isFinite(number)) return formatMaybeNull(value);
  return Math.abs(number % 1) > 0.0001 ? currencyCentsFormatter.format(number) : currencyFormatter.format(number);
}

function formatPercent(value) {
  if (value === null || value === undefined || value === "") return formatMaybeNull(value);
  const number = Number(value);
  return Number.isFinite(number) ? percentFormatter.format(number) : formatMaybeNull(value);
}

function isDateOnlyTimestamp(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function parseTradeTimestamp(value) {
  if (!value) return null;
  const text = String(value);
  const date = isDateOnlyTimestamp(text) ? new Date(`${text}T00:00:00Z`) : new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatTradeTimestamp(value) {
  if (!value) return "n/a";
  if (isDateOnlyTimestamp(value)) return `${value} (date only)`;
  const date = parseTradeTimestamp(value);
  if (!date) return value;
  return `${date.toLocaleDateString("en-GB")} ${date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}

function formatChatTime(value) {
  const date = parseTradeTimestamp(value);
  if (!date) return "n/a";
  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDurationMinutes(minutes) {
  const number = Number(minutes);
  if (!Number.isFinite(number) || number < 0) return "n/a";
  if (number < 60) return `${Math.max(1, Math.round(number))} min`;
  const hours = Math.floor(number / 60);
  const mins = Math.round(number % 60);
  if (hours < 24) return mins ? `${hours}h ${mins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days}d ${remHours}h` : `${days}d`;
}

function durationBetween(start, end) {
  if (!start || !end || isDateOnlyTimestamp(start) || isDateOnlyTimestamp(end)) return "n/a";
  const startDate = parseTradeTimestamp(start);
  const endDate = parseTradeTimestamp(end);
  if (!startDate || !endDate || endDate < startDate) return "n/a";
  return formatDurationMinutes((endDate - startDate) / 60000);
}

function runningDuration(start) {
  if (!start) return "n/a";
  const startDate = parseTradeTimestamp(start);
  if (!startDate) return "n/a";
  const minutes = (Date.now() - startDate.getTime()) / 60000;
  const suffix = isDateOnlyTimestamp(start) ? " +" : "";
  return `${formatDurationMinutes(minutes)}${suffix}`;
}

function humanizeStatus(value) {
  if (!value) return "n/a";
  return String(value)
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function escapeHtml(value) {
  return String(formatMaybeNull(value))
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function basename(filePath) {
  return String(filePath || "unknown").split(/[\\/]/).pop();
}

function markdownish(value) {
  return escapeHtml(value).replace(/`([^`]+)`/g, "<code>$1</code>");
}

function summaryTile(label, value, tone = "neutral") {
  return `
    <div class="tile ${tone}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function formatTradeExitDisplay(trade) {
  const legs = Array.isArray(trade?.exitLegs) ? trade.exitLegs : [];
  if (legs.length <= 1) return trade?.exitPrice ?? "n/a";
  const distinct = [...new Set(legs.map((leg) => leg.exitPrice).filter((value) => value !== null && value !== undefined).map(String))];
  return distinct.length <= 3 ? distinct.join(", ") : `${distinct.length} exits`;
}

function formatTradeStatusDisplay(trade) {
  const legs = Array.isArray(trade?.exitLegs) ? trade.exitLegs.length : Number(trade?.exitLegCount) || 0;
  if (legs > 1) return /exit legs/i.test(trade?.status || "") ? trade.status : `${trade?.status || "Closed / reduced"}; ${legs} exit legs`;
  return trade?.status || "Closed";
}

function moneyValue(value) {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const number = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function currentStrategyPerformanceRows(manifest) {
  const paperRows = (manifest.performance?.paperTrading?.rows || []).map((row) => ({
    strategy: row.strategy || "Paper strategy",
    source: "paper",
    netProfitDollars: null,
    maxDrawdownDollars: moneyValue(row.maxDrawdownDollars),
    winRate: row.winRate,
    trades: Number(row.trades ?? row.tradesObserved) || 0,
    longTrades: Number(row.longTrades) || 0,
    shortTrades: Number(row.shortTrades) || 0,
  }));
  const liveRows = (manifest.performance?.liveTrading?.rows || [])
    .filter((row) => row.source === "strategy")
    .map((row) => ({
      strategy: row.strategy || "Live strategy",
      source: "live",
      netProfitDollars: moneyValue(row.netProfitDollars),
      maxDrawdownDollars: moneyValue(row.maxDrawdownDollars),
      winRate: row.winRate,
      trades: Number(row.trades ?? row.tradesObserved) || 0,
      longTrades: Number(row.longTrades) || 0,
      shortTrades: Number(row.shortTrades) || 0,
    }));
  return [...paperRows, ...liveRows];
}

function dataSourceBadge(sourceSystem, detail = "") {
  const source = String(sourceSystem || "derived");
  const labelMap = {
    paperclip: "Paperclip",
    sierra: "Sierra",
    paperclip_artifact: "Paperclip artifact",
    sierra_strategy_artifact: "Sierra code",
    local_artifact: "Local artifact",
    derived: "Derived",
    unknown: "Unknown",
  };
  return `<span class="source-badge ${escapeHtml(source)}" title="${escapeHtml(detail || labelMap[source] || source)}">${escapeHtml(labelMap[source] || humanizeStatus(source))}</span>`;
}

function keyValueTable(rows) {
  return `
    <table class="kv-table">
      <tbody>
        ${rows
          .map(
            ([label, value]) => `
              <tr>
                <th>${escapeHtml(label)}</th>
                <td>${markdownish(value)}</td>
              </tr>
            `,
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function createTable(headers, rows) {
  if (!rows?.length) return '<p class="empty">No rows found.</p>';
  return `
    <table data-filter-table>
      <thead>
        <tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (row) => `
              <tr data-filter-row>
                ${row.map((cell) => `<td>${String(cell ?? "n/a")}</td>`).join("")}
              </tr>
            `,
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function renderGenericTable(rows) {
  if (!Array.isArray(rows) || !rows.length) return '<p class="empty">No rows found.</p>';
  const headers = Object.keys(rows[0] || {});
  if (!headers.length) return '<p class="empty">No rows found.</p>';
  return createTable(
    headers,
    rows.map((row) => headers.map((header) => escapeHtml(row?.[header]))),
  );
}

function extractBullets(text, heading, limit = 8) {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start === -1) return [];
  const bullets = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    const match = line.match(/^\s*-\s+(.+)/);
    if (match) bullets.push(match[1]);
    if (bullets.length >= limit) break;
  }
  return bullets;
}

function bulletList(items) {
  if (!items.length) return '<p class="empty">No summary lines found in this artifact yet.</p>';
  return `<ul class="summary-list">${items.map((item) => `<li>${markdownish(item)}</li>`).join("")}</ul>`;
}

function formatMonitorTimestamp(value) {
  const date = parseTradeTimestamp(value);
  if (!date) return "n/a";
  return date.toLocaleString("en-GB", {
    timeZone: "Europe/London",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function monitorEventTitle(event) {
  const level = humanizeStatus(event?.level || "info");
  const action = humanizeStatus(event?.action || "event");
  const title = [level, action].filter(Boolean).join(" / ");
  return title || "Monitor event";
}

function monitorEventMeta(event) {
  const parts = [];
  if (event?.reason) parts.push(`reason: ${event.reason}`);
  if (event?.scanCount !== undefined && event?.scanCount !== null) parts.push(`scan #${event.scanCount}`);
  if (event?.importCount !== undefined && event?.importCount !== null) parts.push(`import #${event.importCount}`);
  if (event?.error) parts.push(`error: ${event.error}`);
  return parts.length ? parts.join(" | ") : "No extra details";
}

function renderMonitorActivity(state = {}) {
  const events = Array.isArray(state.recentEvents) ? state.recentEvents.slice(-6).reverse() : [];
  const status = humanizeStatus(state.status || "unknown");
  const running = state.running ? "On" : "Off";
  return `
    <div class="section-head">
      <div>
        <h2>Monitor activity</h2>
        <p>Recent worker updates and errors.</p>
      </div>
    </div>
    <div class="journal-toolbar">
      <span>Status: ${escapeHtml(status)}</span>
      <span>Running: ${escapeHtml(running)}</span>
      <span>Updated: ${escapeHtml(formatMonitorTimestamp(state.updatedAtUtc))}</span>
    </div>
    ${
      events.length
        ? `<ul class="summary-list monitor-event-list">${events.map((event) => `
          <li>
            <strong>${escapeHtml(`${formatMonitorTimestamp(event.atUtc)} - ${monitorEventTitle(event)}`)}</strong>
            <span class="monitor-event-meta">${escapeHtml(monitorEventMeta(event))}</span>
            <span>${escapeHtml(event.message || "Monitor event")}</span>
          </li>
        `).join("")}</ul>`
        : '<p class="empty">No monitor events recorded yet.</p>'
    }
  `;
}

function replayTone(status) {
  const value = String(status || "").toLowerCase();
  if (value.includes("align") || value.includes("exact")) return "good";
  if (value.includes("mismatch") || value.includes("partial")) return "warn";
  return "neutral";
}

function formatCount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : "n/a";
}

function replayArtifactScope(artifact) {
  return artifact?.sessionOrPurpose || artifact?.strategy || artifact?.title || "n/a";
}

const REPLAY_ACCOUNT_STORAGE_KEY = "oceanTradingReplayAccountId";
const REPLAY_ACCOUNT_MANUAL_SESSION_KEY = `${REPLAY_ACCOUNT_STORAGE_KEY}:manual`;
const REPLAY_DEFAULT_ACCOUNTS = ["Sim1", "Sim2", "Sim3", "Sim4", "Sim5"].map((accountId) => ({
  accountId,
  label: accountId.replace(/^Sim(\d+)$/i, "SIM $1"),
}));

function replayAccountDisplayLabel(accountId) {
  const text = String(accountId || "Sim1").trim();
  const match = text.match(/^Sim(\d+)$/i);
  return match ? `SIM ${match[1]}` : text || "Sim1";
}

function replayAccountSortValue(accountId) {
  const match = String(accountId || "").trim().match(/^Sim(\d+)$/i);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

function isReplayAccountId(accountId) {
  const text = String(accountId || "").trim();
  return Boolean(text && text !== "None" && /^[A-Za-z0-9_-]+$/.test(text));
}

function replayAccounts(session) {
  const merged = new Map();
  const add = (account) => {
    const accountId = String(account?.accountId || account?.replayAccountId || "").trim();
    if (!isReplayAccountId(accountId)) return;
    const key = accountId.toLowerCase();
    const existing = merged.get(key) || {
      accountId,
      label: replayAccountDisplayLabel(accountId),
      tradeLogCount: 0,
      groupedTradesVisibleCount: 0,
    };
    if (account.label) existing.label = account.label;
    existing.tradeLogCount = Math.max(existing.tradeLogCount, Number(account.tradeLogCount) || 0);
    existing.groupedTradesVisibleCount = Math.max(existing.groupedTradesVisibleCount, Number(account.groupedTradesVisibleCount) || 0);
    existing.realizedTrades = Math.max(Number(existing.realizedTrades) || 0, Number(account.realizedTrades) || 0);
    existing.netPnlDollars = Number.isFinite(Number(account.netPnlDollars))
      ? Number(account.netPnlDollars)
      : existing.netPnlDollars;
    merged.set(key, existing);
  };

  for (const account of Array.isArray(session?.replayAccounts) ? session.replayAccounts : []) add(account);
  for (const account of Array.isArray(session?.replayAccountSummaries) ? session.replayAccountSummaries : []) add(account);
  for (const trade of Array.isArray(session?.groupedTrades) ? session.groupedTrades : []) {
    add({
      accountId: trade?.replayAccountId || trade?.sourceTradeLogAccount,
      label: trade?.replayAccountLabel,
    });
  }
  for (const trade of Array.isArray(session?.groupedTradesVisible) ? session.groupedTradesVisible : []) {
    add({
      accountId: trade?.replayAccountId || trade?.sourceTradeLogAccount,
      label: trade?.replayAccountLabel,
    });
  }
  if (!merged.size) {
    for (const account of REPLAY_DEFAULT_ACCOUNTS) add(account);
  }

  return [...merged.values()].sort((a, b) => replayAccountSortValue(a.accountId) - replayAccountSortValue(b.accountId) || a.accountId.localeCompare(b.accountId));
}

function selectedReplayAccountId(session) {
  const accounts = replayAccounts(session);
  const allowed = new Set(accounts.map((account) => account.accountId));
  let stored = "";
  let manualSelection = false;
  try {
    stored = window.localStorage.getItem(REPLAY_ACCOUNT_STORAGE_KEY) || "";
    manualSelection = window.sessionStorage.getItem(REPLAY_ACCOUNT_MANUAL_SESSION_KEY) === "true";
  } catch {
    stored = "";
    manualSelection = false;
  }
  if (manualSelection && allowed.has(stored)) return stored;
  if (allowed.has(session?.activeReplayAccountId)) return session.activeReplayAccountId;
  return allowed.has(session?.defaultReplayAccountId) ? session.defaultReplayAccountId : accounts[0]?.accountId || "Sim1";
}

function setSelectedReplayAccountId(accountId) {
  try {
    window.localStorage.setItem(REPLAY_ACCOUNT_STORAGE_KEY, accountId);
    window.sessionStorage.setItem(REPLAY_ACCOUNT_MANUAL_SESSION_KEY, "true");
  } catch {
    // The selector still works for the current render even if persistence is blocked.
  }
}

function replayAccountLabel(session, accountId) {
  return replayAccounts(session).find((account) => account.accountId === accountId)?.label || replayAccountDisplayLabel(accountId);
}

function replaySessionForSelectedAccount(session, accountId = selectedReplayAccountId(session)) {
  const matchesAccount = (trade) => String(trade?.replayAccountId || "Sim1") === accountId;
  const groupedTrades = Array.isArray(session?.groupedTrades) ? session.groupedTrades.filter(matchesAccount) : [];
  const groupedTradesVisible = Array.isArray(session?.groupedTradesVisible) ? session.groupedTradesVisible.filter(matchesAccount) : [];
  const openPositions = Array.isArray(session?.openPositions)
    ? session.openPositions.filter((position) => String(position?.account || "Sim1") === accountId)
    : [];
  const openNet = openPositions.reduce((sum, position) => sum + (Number(position?.unrealizedPnlDollars) || 0), 0);
  const visibleNet = groupedTradesVisible.reduce((sum, trade) => sum + (Number(trade?.realizedPnlDollars) || 0), 0) + openNet;
  const allNet = groupedTrades.reduce((sum, trade) => sum + (Number(trade?.realizedPnlDollars) || 0), 0) + openNet;
  const accountSummary = (session?.replayAccountSummaries || []).find((account) => account.accountId === accountId) || {};
  const sierraWindowNet = Number(accountSummary.sierraWindowNetPnlDollars ?? session?.sierraWindowNetPnlDollars);
  return {
    ...session,
    selectedReplayAccountId: accountId,
    selectedReplayAccountLabel: replayAccountLabel(session, accountId),
    groupedTrades,
    groupedTradesVisible,
    groupedTradesCount: groupedTrades.length,
    groupedTradesVisibleCount: groupedTradesVisible.length,
    groupedTradesNetPnlDollars: Number(visibleNet.toFixed(2)),
    sierraWindowNetPnlDollars: Number.isFinite(sierraWindowNet) ? Number(sierraWindowNet.toFixed(2)) : session?.sierraWindowNetPnlDollars,
    openPositions,
    openPositionsNetPnlDollars: Number(openNet.toFixed(2)),
    audit: {
      ...(session?.audit || {}),
      groupedTradesFound: groupedTrades.length,
      groupedTradesVisible: groupedTradesVisible.length,
      groupedTradesNetPnlDollars: Number(allNet.toFixed(2)),
      visibleNetPnlDollars: Number(visibleNet.toFixed(2)),
      openNetPnlDollars: Number(openNet.toFixed(2)),
      sierraWindowNetPnlDollars: Number.isFinite(sierraWindowNet) ? Number(sierraWindowNet.toFixed(2)) : session?.audit?.sierraWindowNetPnlDollars,
      selectedReplayAccountId: accountId,
      selectedReplayAccountLabel: replayAccountLabel(session, accountId),
      selectedAccountTradeLogCount: Number(accountSummary.tradeLogCount) || 0,
    },
  };
}

function renderReplayAccountSelector(session) {
  const selectedAccountId = session?.selectedReplayAccountId || selectedReplayAccountId(session);
  const options = replayAccounts(session).map((account) => {
    const suffix = account.tradeLogCount ? ` (${account.tradeLogCount} logs)` : "";
    return `<option value="${escapeHtml(account.accountId)}"${account.accountId === selectedAccountId ? " selected" : ""}>${escapeHtml(account.label + suffix)}</option>`;
  }).join("");
  return `
    <label class="mode-select replay-account-select">
      <span>Replay Account</span>
      <select data-replay-account-select aria-label="Replay account">
        ${options}
      </select>
    </label>
  `;
}

function renderReplayAccountPanel(session) {
  const selectedAccountId = session?.selectedReplayAccountId || selectedReplayAccountId(session);
  const summaries = Array.isArray(session?.replayAccountSummaries) ? session.replayAccountSummaries : [];
  const summaryFor = (accountId) => summaries.find((summary) => summary.accountId === accountId) || {};
  const accounts = replayAccounts(session).map((account) => {
    const summary = summaryFor(account.accountId);
    const trades = Number(summary.realizedTrades ?? account.groupedTradesVisibleCount) || 0;
    const logs = Number(summary.tradeLogCount ?? account.tradeLogCount) || 0;
    const pnl = Number(summary.netPnlDollars) || 0;
    const selected = account.accountId === selectedAccountId;
    return `
      <button class="replay-account-card${selected ? " selected" : ""}" type="button" data-replay-account-option="${escapeHtml(account.accountId)}" aria-pressed="${selected ? "true" : "false"}">
        <span class="replay-account-card-title">${escapeHtml(account.label)}</span>
        <span class="replay-account-card-pnl ${pnl < 0 ? "negative" : pnl > 0 ? "positive" : ""}">${escapeHtml(formatCurrency(pnl))}</span>
        <span class="replay-account-card-meta">${escapeHtml(formatCount(trades))} trades</span>
        <span class="replay-account-card-meta">${escapeHtml(formatCount(logs))} logs</span>
      </button>
    `;
  }).join("");
  return `
    <aside class="replay-account-panel" data-replay-account-panel>
      <div class="mini-card-head">
        <div>
          <h3>Replay Accounts</h3>
          <p>Select the Sierra SIM account to review.</p>
        </div>
      </div>
      <div class="replay-account-list">
        ${accounts}
      </div>
    </aside>
  `;
}

function renderReplayArtifactTable(artifacts) {
  if (!artifacts?.length) return '<p class="empty">No replay validation artifacts are available yet.</p>';
  return createTable(
    ["Artifact", "Status", "Generated", "Scope", "Replay", "Backtest", "Exact", "Mismatches"],
    artifacts.map((artifact) => [
      escapeHtml(artifact.title || "Replay artifact"),
      escapeHtml(humanizeStatus(artifact.status || "observed")),
      escapeHtml(formatTradeTimestamp(artifact.generatedAtUtc)),
      escapeHtml(replayArtifactScope(artifact)),
      escapeHtml(formatCount(artifact.replayCount)),
      escapeHtml(formatCount(artifact.backtestCount)),
      escapeHtml(formatCount(artifact.exactCount)),
      escapeHtml(formatCount(artifact.mismatchCount)),
    ]),
  );
}

function renderReplaySessionTradesTable(session) {
  const rows = session?.groupedTradesVisible || [];
  if (!rows.length) {
    return `<p class="empty">No grouped replay trades are available for ${escapeHtml(session?.selectedReplayAccountLabel || "the selected SIM account")}.</p>`;
  }
  const replayCompletionLabel = (trade) => {
    const status = String(trade?.completionStatus || "").trim().toLowerCase();
    if (status === "partial") return "Partial exit";
    if (status === "completed") return "Completed";
    if (status === "open") return "Open";
    if (String(trade?.exitReason || "").trim().toLowerCase() === "mixed") return "Partial exit";
    return "Open";
  };
  const price = (value) => value === null || value === undefined ? "n/a" : String(value);
  const shortTradeId = (value) => String(value || "n/a").replace(/^replay-session-[^:]+:/, "");
  const cells = rows.map((trade) => {
    const pnl = Number(trade.realizedPnlDollars);
    return `
      <tr data-filter-row>
        <td>${escapeHtml(trade.replayAccountLabel || replayAccountDisplayLabel(trade.replayAccountId || "Sim1"))}</td>
        <td>${escapeHtml(trade.lucidSessionDay || replayTradeSessionDay(trade) || "n/a")}</td>
        <td>${escapeHtml(trade.entryKey || "n/a")}</td>
        <td>${escapeHtml(humanizeStatus(trade.direction || "n/a"))}</td>
        <td class="numeric">${escapeHtml(price(trade.entry))}</td>
        <td class="numeric">${escapeHtml(price(trade.initialStop))}</td>
        <td>${escapeHtml(trade.targetPlanLabel || "n/a")}</td>
        <td>${escapeHtml(trade.hermesProfile || "n/a")}</td>
        <td>${escapeHtml(trade.hermesAction || "n/a")}</td>
        <td>${escapeHtml(replayCompletionLabel(trade))}</td>
        <td>${escapeHtml(humanizeStatus(trade.exitReason || "n/a"))}</td>
        <td class="numeric pnl ${pnl < 0 ? "loss" : pnl > 0 ? "gain" : ""}">${escapeHtml(formatCurrency(trade.realizedPnlDollars))}</td>
        <td>${escapeHtml(trade.sourceTradeLogAccount || trade.replayAccountId || "Sim1")}</td>
        <td>${escapeHtml(humanizeStatus(trade.source || "sierra_replay_connector"))}</td>
        <td>${escapeHtml(shortTradeId(trade.tradeId))}</td>
      </tr>
    `;
  }).join("");
  return `
    <div class="replay-trade-table-shell table-scroll">
      <table class="replay-trade-table" data-filter-table>
        <thead>
          <tr>
            ${["Account", "Session Day", "Entry Time", "Side", "Entry", "Stop", "Targets", "Profile", "Action", "Status", "Exit", "P/L", "Log Account", "Source", "Trade ID"]
              .map((header) => `<th>${escapeHtml(header)}</th>`)
              .join("")}
          </tr>
        </thead>
        <tbody>${cells}</tbody>
      </table>
    </div>
  `;
}

function renderReplayAccountDropdown(session) {
  const selectedAccountId = session?.selectedReplayAccountId || selectedReplayAccountId(session);
  const options = replayAccounts(session).map((account) => {
    const selected = account.accountId === selectedAccountId ? " selected" : "";
    return `<option value="${escapeHtml(account.accountId)}"${selected}>${escapeHtml(replayAccountChoiceLabel(session, account))}</option>`;
  }).join("");
  return `
    <label class="replay-dashboard-account-select">
      <span>Replay Account</span>
      <select data-replay-account-select aria-label="Replay account">${options}</select>
    </label>
  `;
}

function replayAccountTradeCount(account) {
  return Number(account?.realizedTrades ?? account?.groupedTradesVisibleCount ?? account?.tradeCount) || 0;
}

function replayAccountTradeSummary(account, emptyText = "no data yet") {
  const trades = replayAccountTradeCount(account);
  return trades > 0 ? `${formatCount(trades)} trades` : emptyText;
}

function replayAccountChoiceLabel(session, account) {
  const isActive = String(session?.activeReplayAccountId || "").toLowerCase() === String(account.accountId || "").toLowerCase();
  const summary = replayAccountTradeSummary(account);
  return isActive ? `${account.label} - active replay (${summary})` : `${account.label} - ${summary}`;
}

function renderReplaySparkline(values, type = "line") {
  const cleaned = values.map((value) => Number(value) || 0);
  const max = Math.max(1, ...cleaned.map((value) => Math.abs(value)));
  const bars = cleaned.slice(-14).map((value) => {
    const height = Math.max(12, Math.round((Math.abs(value) / max) * 34));
    return `<span style="height:${height}px"></span>`;
  }).join("");
  return `<div class="replay-sparkline ${type}">${bars}</div>`;
}

function renderReplayMetricCard(label, value, tone = "neutral", sparkline = "") {
  return `
    <article class="replay-metric-card ${tone}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      ${sparkline}
    </article>
  `;
}

function renderReplayAccountClearToolbar(session, stats) {
  const accountId = session?.selectedReplayAccountId || selectedReplayAccountId(session);
  const accountLabel = session?.selectedReplayAccountLabel || replayAccountLabel(session, accountId);
  const trades = Number(stats?.tradeCount) || 0;
  const days = Array.isArray(stats?.dailyRows) ? stats.dailyRows.length : 0;
  const sourceRows = Number(session?.audit?.selectedAccountTradeLogCount) || 0;
  const confirmPhrase = `CLEAR ${accountLabel}`;
  const activeAccountId = String(session?.activeReplayAccountId || "").toLowerCase();
  const accountChips = replayAccounts(session).map((account) => {
    const selected = account.accountId === accountId;
    const active = String(account.accountId || "").toLowerCase() === activeAccountId;
    const classes = ["replay-account-chip"];
    if (selected) classes.push("selected");
    if (active) classes.push("active-source");
    const label = selected
      ? `Selected: ${account.label}`
      : `${account.label}: ${replayAccountTradeSummary(account, "no data")}`;
    return `
      <button
        class="${classes.join(" ")}"
        type="button"
        data-replay-account-option="${escapeHtml(account.accountId)}"
        aria-pressed="${selected ? "true" : "false"}"
      >${escapeHtml(label)}</button>
    `;
  }).join("");
  return `
    <div class="replay-account-clear-toolbar">
      <div class="replay-account-clear-chips">
        ${accountChips}
        <span class="replay-account-chip replay-account-note">Active replay account is selected automatically unless changed here</span>
      </div>
      <button
        class="dashboard-button danger replay-account-clear-button"
        type="button"
        data-replay-clear
        data-replay-clear-account-id="${escapeHtml(accountId)}"
        data-replay-clear-account-label="${escapeHtml(accountLabel)}"
        data-replay-clear-trades="${escapeHtml(String(trades))}"
        data-replay-clear-days="${escapeHtml(String(days))}"
        data-replay-clear-source-rows="${escapeHtml(String(sourceRows))}"
        data-replay-clear-confirm="${escapeHtml(confirmPhrase)}"
      >Clear ${escapeHtml(accountLabel)} data</button>
    </div>
    <p class="replay-action-status" data-replay-status>${escapeHtml(replayActionStatus())}</p>
  `;
}

function renderReplayCalendarLegend() {
  return `
    <div class="replay-calendar-legend">
      <span><i class="gain"></i>Positive P&amp;L</span>
      <span><i class="loss"></i>Negative P&amp;L</span>
      <span><i></i>No trades</span>
    </div>
  `;
}

function replayWeekStartKey(dateKey) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return dateKey;
  const day = date.getUTCDay();
  const offset = (day + 6) % 7;
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
}

function replayRealizedTrades(session) {
  const trades = Array.isArray(session?.groupedTradesVisible) ? session.groupedTradesVisible : [];
  return trades.filter((trade) =>
    Number.isFinite(Number(trade?.realizedPnlDollars)) &&
    String(trade?.completionStatus || "").toLowerCase() !== "open"
  );
}

function latestReplayDayKey(dailyRows, selectedMonth) {
  const monthRows = dailyRows.filter((row) => monthKeyFromPeriod(row.period) === selectedMonth);
  const rows = monthRows.length ? monthRows : dailyRows;
  return rows.length ? rows[rows.length - 1].period : null;
}

function offsetReplayDayKey(dailyRows, currentDayKey, offset) {
  const days = dailyRows.map((row) => row.period).filter((period) => /^\d{4}-\d{2}-\d{2}$/.test(period)).sort();
  if (!days.length) return null;
  const currentIndex = days.includes(currentDayKey) ? days.indexOf(currentDayKey) : days.length - 1;
  const nextIndex = Math.max(0, Math.min(days.length - 1, currentIndex + offset));
  return days[nextIndex];
}

function replayTradeHour(trade) {
  const entryKey = String(trade?.entryKey || "");
  const match = entryKey.match(/T(\d{2})/);
  if (match) return Number(match[1]);
  const observedAt = Date.parse(trade?.observedAtUtc || "");
  if (!Number.isFinite(observedAt)) return null;
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hour12: false }).format(new Date(observedAt)));
}

function renderReplayTodayView(session, dailyRows, selectedMonth) {
  const dayKey = selectedReplayCalendarDay(dailyRows, selectedMonth);
  if (!dayKey) return `<p class="empty">No replay trades are available for the selected account.</p>`;
  const byHour = new Map(Array.from({ length: 24 }, (_, hour) => [hour, { trades: 0, netPnl: 0 }]));
  for (const trade of replayRealizedTrades(session).filter((item) => replayTradeSessionDay(item) === dayKey)) {
    const hour = replayTradeHour(trade);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
    const row = byHour.get(hour);
    row.trades += 1;
    row.netPnl += Number(trade.realizedPnlDollars) || 0;
  }
  const dayTotal = [...byHour.values()].reduce((sum, row) => sum + row.netPnl, 0);
  return `
    <div class="dashboard-calendar-banner replay-period-nav">
      <div class="dashboard-calendar-nav">
        <button type="button" aria-label="Previous replay day" data-replay-day-previous>&lsaquo;</button>
        <button type="button" aria-label="Next replay day" data-replay-day-next>&rsaquo;</button>
      </div>
      <div class="replay-period-summary">
        <strong>Daily view: ${escapeHtml(dayKey)} by hour</strong>
        <span class="replay-period-total ${dayTotal < 0 ? "loss" : dayTotal > 0 ? "gain" : ""}">Total: ${escapeHtml(formatCurrency(dayTotal))}</span>
      </div>
      <button type="button" aria-label="Show latest replay day" data-replay-day-latest>&#8635;</button>
    </div>
    <div class="replay-hour-grid">
      ${[...byHour.entries()].map(([hour, row]) => `
        <div class="calendar-day ${row.trades ? row.netPnl < 0 ? "loss" : "gain" : ""}">
          <span>${escapeHtml(String(hour).padStart(2, "0"))}:00</span>
          ${row.trades ? `<strong>${escapeHtml(formatCurrency(row.netPnl))}</strong><small>${escapeHtml(row.trades)} trades</small>` : ""}
        </div>
      `).join("")}
    </div>
  `;
}

function renderReplayWeekView(dailyRows, selectedMonth) {
  const selectedDay = selectedReplayCalendarDay(dailyRows, selectedMonth);
  if (!selectedDay) return `<p class="empty">No replay trades are available for ${escapeHtml(selectedMonth)}.</p>`;
  const weekStart = replayWeekStartKey(selectedDay);
  const rowsByDay = new Map(dailyRows.map((row) => [row.period, row]));
  const days = Array.from({ length: 7 }, (_, offset) => {
    const date = new Date(`${weekStart}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + offset);
    const period = date.toISOString().slice(0, 10);
    return { period, row: rowsByDay.get(period) || { period, trades: 0, netPnl: 0 } };
  });
  const weekTotal = days.reduce((sum, entry) => sum + (Number(entry.row?.netPnl) || 0), 0);
  return `
    <div class="replay-period-heading">
      <span>Weekly view: week of ${escapeHtml(weekStart)}</span>
      <span class="replay-period-total ${weekTotal < 0 ? "loss" : weekTotal > 0 ? "gain" : ""}">Total: ${escapeHtml(formatCurrency(weekTotal))}</span>
    </div>
    <div class="replay-week-grid">
      ${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => `<span class="calendar-weekday">${day}</span>`).join("")}
      ${days.map(({ period, row }) => `
        <div class="calendar-day ${row.trades ? row.netPnl < 0 ? "loss" : "gain" : ""}">
          <span>${escapeHtml(row.period)}</span>
          ${row.trades ? `<strong>${escapeHtml(formatCurrency(row.netPnl))}</strong><small>${escapeHtml(row.trades)} trades</small>` : ""}
        </div>
      `).join("")}
    </div>
  `;
}

function renderReplayCalendarBody(session, dailyRows, selectedMonth, viewMode) {
  if (viewMode === "today") return renderReplayTodayView(session, dailyRows, selectedMonth);
  if (viewMode === "week") return renderReplayWeekView(dailyRows, selectedMonth);
  const periodRows = dailyRows.filter((item) => monthKeyFromPeriod(item.period) === selectedMonth);
  const periodTotal = periodRows.reduce((sum, row) => sum + (Number(row.netPnl) || 0), 0);
  return renderDashboardCalendarGrid(dailyRows, selectedMonth, {
    summaryLabel: monthName(monthDateFromKey(selectedMonth)),
    summaryTotalLabel: "Month subtotal",
    summaryTotal: periodTotal,
    summaryTone: periodTotal < 0 ? "loss" : periodTotal > 0 ? "gain" : "neutral",
  });
}

function renderReplayTradesCompactTable(session) {
  const trades = [...(session?.groupedTradesVisible || [])].sort((a, b) => String(b.entryKey || "").localeCompare(String(a.entryKey || "")));
  if (!trades.length) {
    return `<p class="empty">No grouped replay trades are available for ${escapeHtml(session?.selectedReplayAccountLabel || "the selected SIM account")}.</p>`;
  }
  const accountId = session?.selectedReplayAccountId || selectedReplayAccountId(session);
  const pageSize = replayTradePageSize(accountId);
  const pageCount = Math.max(1, Math.ceil(trades.length / pageSize));
  const page = Math.min(replayTradePage(accountId), pageCount);
  if (page !== replayTradePage(accountId)) setReplayTradePage(accountId, page);
  const start = (page - 1) * pageSize;
  const visible = trades.slice(start, start + pageSize);
  const strategyLabel = (trade) => {
    const label = trade.hermesProfile || trade.hermesAction || trade.targetPlanLabel || "Replay Trade";
    return String(label).replaceAll("_", " ");
  };
  const rows = visible.map((trade) => {
    const pnl = Number(trade.realizedPnlDollars) || 0;
    return `
      <tr>
        <td>${escapeHtml(trade.replayAccountLabel || trade.replayAccountId || "SIM 1")}</td>
        <td>${escapeHtml(trade.entryKey || "n/a")}</td>
        <td>${escapeHtml(strategyLabel(trade))}</td>
        <td class="${String(trade.direction || "").toLowerCase() === "short" ? "short" : "long"}">${escapeHtml(humanizeStatus(trade.direction || "n/a"))}</td>
        <td>${escapeHtml(trade.entry ?? "n/a")}</td>
        <td>${escapeHtml(humanizeStatus(trade.exitReason || "n/a"))}</td>
        <td><span class="status-badge good">${escapeHtml(humanizeStatus(trade.completionStatus || "completed"))}</span></td>
        <td class="pnl ${pnl < 0 ? "loss" : pnl > 0 ? "gain" : ""}">${escapeHtml(formatCurrency(pnl))}</td>
      </tr>
    `;
  }).join("");
  return `
    <div class="replay-trade-filter-panel ${replayTradeFiltersOpen() ? "open" : ""}" data-replay-filter-panel>
      <label>Search trades <input type="search" data-replay-trade-search placeholder="Strategy, status, P/L, time" /></label>
    </div>
    <div class="replay-dashboard-table-wrap">
      <table class="replay-dashboard-trades">
        <thead>
          <tr>
            <th>Account</th>
            <th>Time (UK)</th>
            <th>Strategy</th>
            <th>Direction</th>
            <th>Entry</th>
            <th>Exit</th>
            <th>Status</th>
            <th>P/L</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="replay-table-footer">
      <span>Showing ${escapeHtml(String(start + 1))} to ${escapeHtml(String(start + visible.length))} of ${escapeHtml(String(trades.length))} trades</span>
      <span class="replay-pagination">
        <button type="button" data-replay-page="${escapeHtml(String(Math.max(1, page - 1)))}" ${page <= 1 ? "disabled" : ""}>&lsaquo;</button>
        ${Array.from({ length: Math.min(pageCount, 5) }, (_, index) => {
          const candidate = Math.min(pageCount, Math.max(1, page - 2) + index);
          return `<button type="button" class="${candidate === page ? "active" : ""}" data-replay-page="${escapeHtml(String(candidate))}">${escapeHtml(String(candidate))}</button>`;
        }).filter((value, index, values) => values.indexOf(value) === index).join("")}
        <button type="button" data-replay-page="${escapeHtml(String(Math.min(pageCount, page + 1)))}" ${page >= pageCount ? "disabled" : ""}>&rsaquo;</button>
        <select aria-label="Rows per page" data-replay-page-size>
          ${[8, 16, 32].map((size) => `<option value="${size}"${size === pageSize ? " selected" : ""}>${size} / page</option>`).join("")}
        </select>
      </span>
    </div>
  `;
}

function renderReplayAuditStrip(session) {
  const audit = session?.audit || {};
  return `
    <section class="replay-dashboard-audit">
      <h2>Replay Audit</h2>
      <div class="replay-audit-grid">
        <div>
          <span>Source logs</span>
          <strong>${escapeHtml(audit.latestTradeLog ? basename(audit.latestTradeLog) : "TradeActivityLog_*_UTC.Sim*.simulated.data")}</strong>
        </div>
        <div>
          <span>Account filter</span>
          <strong>${escapeHtml(session.selectedReplayAccountLabel || "SIM 1")}</strong>
        </div>
        <div>
          <span>Replay engine</span>
          <strong>${escapeHtml(humanizeStatus(session.source || "sierra_replay_connector"))}</strong>
        </div>
      </div>
    </section>
  `;
}

function renderReplaySessionAudit(session) {
  const audit = session?.audit || {};
  const hiddenAfterClear = Number(audit.groupedTradesHiddenAfterClear) || 0;
  return `
    <section class="panel">
      <h2>Replay Display Audit</h2>
      <p class="section-note">${escapeHtml(hiddenAfterClear > 0
        ? "The replay connector found grouped trades, but the current session was cleared so the calendar and trade table are intentionally blank."
        : "This compares the grouped replay trades displayed on the page with the latest connector rebuild from Sierra replay logs.")}</p>
      ${keyValueTable([
        ["Rebuilt", formatTradeTimestamp(audit.generatedAtUtc)],
        ["Grouped trades found", formatCount(audit.groupedTradesFound)],
        ["Grouped trades visible", formatCount(audit.groupedTradesVisible)],
        ["Account filter", audit.selectedReplayAccountLabel || "SIM 1"],
        ["Account logs scanned", formatCount(audit.selectedAccountTradeLogCount)],
        ["Hidden after clear", formatCount(audit.groupedTradesHiddenAfterClear)],
        ["All grouped net", formatCurrency(audit.groupedTradesNetPnlDollars)],
        ["Visible net", formatCurrency(audit.visibleNetPnlDollars)],
        ["Replay fills parsed", formatCount(audit.replayFillCount)],
        ["Replay exit fills parsed", formatCount(audit.replayExitFillCount)],
        ["Trade logs scanned", formatCount(audit.readableTradeLogCount ?? audit.sourceTradeLogCount)],
        ["Artifact replay count", formatCount(audit.artifactReplayCount)],
        ["Latest trade log", audit.latestTradeLog ? basename(audit.latestTradeLog) : "n/a"],
        ["Latest message log", audit.latestMessageLog ? basename(audit.latestMessageLog) : "n/a"],
        ["Connector recommendation", audit.connectorRecommendation || "n/a"],
      ])}
    </section>
  `;
}

function renderReplayMonitorPage(manifest) {
  const replay = manifest.replayMonitor || {};
  const monitor = replay.monitorState || {};
  const rawSession = replay.currentSession || {};
  const session = replaySessionForSelectedAccount(rawSession);
  return `
    <div class="replay-dashboard-title">
      <div>
        <h1>Replay Monitor</h1>
        <p>Monitor replay performance and simulated trading activity across accounts.</p>
      </div>
      <div class="replay-title-actions">
        <span>Last updated: ${escapeHtml(formatTradeTimestamp(monitor.lastScanAtUtc || manifest.generatedAtUtc))} UK</span>
        <button class="dashboard-button" type="button" data-replay-reconcile>Refresh</button>
      </div>
    </div>
    ${renderReplayMonitorDashboard(session)}
  `;
}

function startOfWeek(date) {
  const copy = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = copy.getUTCDay() || 7;
  copy.setUTCDate(copy.getUTCDate() - day + 1);
  return copy.toISOString().slice(0, 10);
}

function periodLabel(dateValue, period) {
  const dateText = String(dateValue || "").slice(0, 10);
  const date = new Date(`${dateText}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return "Unknown";
  if (period === "weekly") return `Week of ${startOfWeek(date)}`;
  if (period === "monthly") return dateText.slice(0, 7);
  return dateText;
}

function summarizePeriodRows(trades, period, mode, actualRows = []) {
  const grouped = new Map();
  for (const trade of trades || []) {
    const pnl = Number(trade.realizedPnlDollars);
    const closedAtUtc = trade.exitAtUtc || trade.tradeDateUtc;
    if (!closedAtUtc || !Number.isFinite(pnl)) continue;
    const bucket = periodLabel(closedAtUtc, period);
    const accountType = mode === "live" ? trade.accountType || "Unclassified" : "Paper Simulation";
    const account = trade.account || "n/a";
    const owner = trade.strategyName || (trade.tradeSource === "manual" ? "Manual Trade" : "Strategy");
    const key = [bucket, accountType, account, owner].join("|");
    const row = grouped.get(key) || {
      period: bucket,
      accountType,
      account,
      owner,
      trades: 0,
      wins: 0,
      losses: 0,
      netPnl: 0,
    };
    row.trades += 1;
    row.netPnl += pnl;
    if (pnl > 0) row.wins += 1;
    if (pnl < 0) row.losses += 1;
    grouped.set(key, row);
  }
  if (mode === "live" || mode === "paper") {
    for (const actual of actualRows || []) {
      if (!actual?.account || !Number.isFinite(Number(actual.trueProfitDollars))) continue;
      const actualDate = String(actual.balanceAsOfUtc || new Date().toISOString()).slice(0, 10);
      const bucket = periodLabel(actualDate, period);
      const matchingRows = [...grouped.values()].filter((row) => row.period === bucket && row.account === actual.account);
      if (matchingRows.length === 1) {
        for (const row of matchingRows) {
          row.grossFillPnl = Number(row.netPnl.toFixed(2));
          row.netPnl = Number(actual.trueProfitDollars);
          row.pnlSource = actual.trueProfitSource;
        }
      } else if (matchingRows.length === 0) {
        const accountType = mode === "paper" ? "Paper Simulation" : "Live Account";
        const key = [bucket, accountType, actual.account, "Account snapshot"].join("|");
        grouped.set(key, {
          period: bucket,
          accountType,
          account: actual.account,
          owner: "Account snapshot",
          trades: 0,
          wins: 0,
          losses: 0,
          netPnl: Number(actual.trueProfitDollars),
          pnlSource: actual.trueProfitSource,
        });
      }
    }
  }
  return [...grouped.values()]
    .map((row) => ({
      ...row,
      netPnl: Number(row.netPnl.toFixed(2)),
      successRate: row.trades ? row.wins / row.trades : null,
    }))
    .sort((a, b) => b.period.localeCompare(a.period) || b.netPnl - a.netPnl);
}

function renderPerformanceCalendar(id, trades, mode = "live", actualRows = []) {
  const dailyRows = summarizePeriodRows(trades, "daily", mode, actualRows);
  const total = dailyRows.reduce((sum, row) => sum + row.netPnl, 0);
  const tradeCount = dailyRows.reduce((sum, row) => sum + row.trades, 0);
  const pnlLabel = mode === "paper" ? "Paper realised P&L" : "Calendar P&L";
  const tradeLabel = mode === "paper" ? "Closed paper trades" : "Calendar trades";
  const calendarNote = mode === "paper"
    ? "Closed paper telemetry SQLite trades are grouped by trade close date. This view does not fall back to Sierra paper TradeActivityLogs."
    : "Select daily, weekly, or monthly performance split by account, account type, and strategy owner.";
  return `
    <section class="performance-calendar" data-performance-calendar="${escapeHtml(id)}" data-mode="${escapeHtml(mode)}">
      <div class="section-head">
        <div>
          <h2>Performance Calendar</h2>
          <p>${escapeHtml(calendarNote)}</p>
        </div>
        <div class="segmented-control" role="group" aria-label="Performance period">
          <button type="button" class="active" data-period="daily">Daily</button>
          <button type="button" data-period="weekly">Weekly</button>
          <button type="button" data-period="monthly">Monthly</button>
        </div>
      </div>
      <div class="tile-grid">
        ${summaryTile(pnlLabel, formatCurrency(total), total < 0 ? "warn" : "good")}
        ${summaryTile(tradeLabel, tradeCount)}
      </div>
      <div data-calendar-table>${renderPerformanceCalendarTable(dailyRows, mode)}</div>
    </section>
  `;
}

function renderPerformanceCalendarTable(rows, mode = "live") {
  if (!rows.length) return '<p class="empty">No closed trades have been reconciled for this calendar yet.</p>';
  const includeSource = mode === "live";
  const includePnl = true;
  return `
    <table data-filter-table>
      <thead>
        ${renderFilterRow(rows, [
          { key: "period", label: "Period", type: "select" },
          { key: "accountType", label: "Account Type", type: "select" },
          { key: "account", label: "Account", type: "select" },
          { key: "owner", label: "Strategy / Owner", type: "select" },
          null,
          null,
          null,
          ...(includeSource ? [null] : []),
        ])}
        <tr>
          <th>Period</th>
          <th>Account Type</th>
          <th>Account</th>
          <th>Strategy / Owner</th>
          <th>Trades</th>
          <th>Success Rate</th>
          ${includePnl ? "<th>Total P&L</th>" : ""}
          ${includeSource ? "<th>Source</th>" : ""}
        </tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (row) => `
              <tr data-filter-row>
                <td>${escapeHtml(row.period)}</td>
                <td>${escapeHtml(row.accountType)}</td>
                <td>${escapeHtml(row.account)}</td>
                <td>${escapeHtml(row.owner)}</td>
                <td>${escapeHtml(row.trades)}</td>
                <td>${escapeHtml(formatPercent(row.successRate))}</td>
                ${includePnl ? `<td>${escapeHtml(formatCurrency(row.netPnl))}</td>` : ""}
                ${includeSource ? `<td>${escapeHtml(trueProfitSourceLabel(row.pnlSource || "closed_fill_pnl"))}</td>` : ""}
              </tr>
            `,
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function dashboardPerformanceMode() {
  return window.localStorage.getItem("oceanTradingDashboardPerformanceMode") === "live" ? "live" : "paper";
}

function latestDashboardTradeTime(trades) {
  return Math.max(
    0,
    ...(trades || [])
      .map((trade) => parseTradeTimestamp(dashboardTradeTimestamp(trade))?.getTime() || 0)
      .filter(Boolean),
  );
}

function defaultDashboardPerformanceMode(manifest) {
  if (window.localStorage.getItem("oceanTradingDashboardPerformanceMode")) return dashboardPerformanceMode();
  return "paper";
}

function visibleDashboardPerformanceMode(root = document) {
  return root.querySelector("[data-dashboard-performance-mode]")?.value === "live" ? "live" : "paper";
}

function setDashboardPerformanceMode(mode) {
  window.localStorage.setItem("oceanTradingDashboardPerformanceMode", mode === "live" ? "live" : "paper");
}

function monthName(date) {
  return date.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}

function monthKeyFromPeriod(period) {
  const match = String(period || "").match(/^(\d{4})-(\d{2})-\d{2}$/);
  return match ? `${match[1]}-${match[2]}` : null;
}

function monthDateFromKey(key) {
  const match = String(key || "").match(/^(\d{4})-(\d{2})$/);
  return match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)) : new Date();
}

function monthKeyFromDate(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function offsetMonthKey(key, offset) {
  const date = monthDateFromKey(key);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return monthKeyFromDate(date);
}

function latestCalendarMonthKey(dailyRows) {
  return dailyRows.map((row) => monthKeyFromPeriod(row.period)).filter(Boolean).sort().at(-1) || monthKeyFromDate(new Date());
}

function dashboardCalendarMonthStorageKey(mode) {
  return `oceanTradingDashboardCalendarMonth:${mode === "live" ? "live" : "paper"}`;
}

function selectedDashboardCalendarMonth(mode, dailyRows) {
  const stored = window.localStorage.getItem(dashboardCalendarMonthStorageKey(mode));
  return /^\d{4}-\d{2}$/.test(stored || "") ? stored : latestCalendarMonthKey(dailyRows);
}

function setSelectedDashboardCalendarMonth(mode, monthKey) {
  window.localStorage.setItem(dashboardCalendarMonthStorageKey(mode), monthKey);
}

function resetSelectedDashboardCalendarMonth(mode) {
  window.localStorage.removeItem(dashboardCalendarMonthStorageKey(mode));
}

function resetAllDashboardCalendarMonths() {
  resetSelectedDashboardCalendarMonth("paper");
  resetSelectedDashboardCalendarMonth("live");
}

function dashboardPerformanceAccountStorageKey(mode) {
  return `oceanTradingDashboardPerformanceAccount:${mode === "live" ? "live" : "paper"}`;
}

function dashboardPerformanceAccountScope(mode) {
  return window.localStorage.getItem(dashboardPerformanceAccountStorageKey(mode)) || "all";
}

function setDashboardPerformanceAccountScope(mode, accountScope) {
  window.localStorage.setItem(dashboardPerformanceAccountStorageKey(mode), accountScope || "all");
}

function dashboardCalendarDayStorageKey(mode) {
  return `oceanTradingDashboardCalendarDay:${mode === "live" ? "live" : "paper"}`;
}

function latestDashboardDayKey(dailyRows, selectedMonth) {
  const monthRows = dailyRows.filter((row) => monthKeyFromPeriod(row.period) === selectedMonth);
  const rows = monthRows.length ? monthRows : dailyRows;
  return rows.length ? rows[rows.length - 1].period : null;
}

function selectedDashboardCalendarDay(mode, dailyRows, selectedMonth) {
  const stored = window.localStorage.getItem(dashboardCalendarDayStorageKey(mode));
  if (/^\d{4}-\d{2}-\d{2}$/.test(stored || "")) return stored;
  return latestDashboardDayKey(dailyRows, selectedMonth) || `${selectedMonth || currentMonthKey()}-01`;
}

function setSelectedDashboardCalendarDay(mode, dayKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey || "")) return;
  window.localStorage.setItem(dashboardCalendarDayStorageKey(mode), dayKey);
  const month = monthKeyFromPeriod(dayKey);
  if (month) setSelectedDashboardCalendarMonth(mode, month);
}

function resetSelectedDashboardCalendarDay(mode) {
  window.localStorage.removeItem(dashboardCalendarDayStorageKey(mode));
}

function dashboardCalendarViewModeStorageKey(mode) {
  return `oceanTradingDashboardCalendarView:${mode === "live" ? "live" : "paper"}`;
}

function dashboardCalendarViewMode(mode) {
  const stored = window.localStorage.getItem(dashboardCalendarViewModeStorageKey(mode));
  return ["today", "week", "month"].includes(stored) ? stored : "month";
}

function setDashboardCalendarViewMode(mode, viewMode) {
  window.localStorage.setItem(
    dashboardCalendarViewModeStorageKey(mode),
    ["today", "week", "month"].includes(viewMode) ? viewMode : "month",
  );
}

function dashboardTradePageStorageKey(mode, accountScope) {
  return `oceanTradingDashboardTradePage:${mode === "live" ? "live" : "paper"}:${accountScope || "all"}`;
}

function dashboardTradePage(mode, accountScope) {
  return Math.max(1, Number(window.localStorage.getItem(dashboardTradePageStorageKey(mode, accountScope))) || 1);
}

function setDashboardTradePage(mode, accountScope, page) {
  window.localStorage.setItem(dashboardTradePageStorageKey(mode, accountScope), String(Math.max(1, Number(page) || 1)));
}

function dashboardTradePageSizeStorageKey(mode, accountScope) {
  return `oceanTradingDashboardTradePageSize:${mode === "live" ? "live" : "paper"}:${accountScope || "all"}`;
}

function dashboardTradePageSize(mode, accountScope) {
  const stored = Number(window.localStorage.getItem(dashboardTradePageSizeStorageKey(mode, accountScope))) || 8;
  return [8, 16, 32].includes(stored) ? stored : 8;
}

function setDashboardTradePageSize(mode, accountScope, pageSize) {
  const size = [8, 16, 32].includes(Number(pageSize)) ? Number(pageSize) : 8;
  window.localStorage.setItem(dashboardTradePageSizeStorageKey(mode, accountScope), String(size));
  setDashboardTradePage(mode, accountScope, 1);
}

function dashboardTradeFiltersOpenStorageKey(mode, accountScope) {
  return `oceanTradingDashboardTradeFiltersOpen:${mode === "live" ? "live" : "paper"}:${accountScope || "all"}`;
}

function dashboardTradeFiltersOpen(mode, accountScope) {
  return window.localStorage.getItem(dashboardTradeFiltersOpenStorageKey(mode, accountScope)) === "true";
}

function setDashboardTradeFiltersOpen(mode, accountScope, open) {
  window.localStorage.setItem(dashboardTradeFiltersOpenStorageKey(mode, accountScope), open ? "true" : "false");
}

function dashboardTradeSearchStorageKey(mode, accountScope) {
  return `oceanTradingDashboardTradeSearch:${mode === "live" ? "live" : "paper"}:${accountScope || "all"}`;
}

function dashboardTradeSearch(mode, accountScope) {
  return window.localStorage.getItem(dashboardTradeSearchStorageKey(mode, accountScope)) || "";
}

function setDashboardTradeSearch(mode, accountScope, value) {
  window.localStorage.setItem(dashboardTradeSearchStorageKey(mode, accountScope), value || "");
}

function replayCalendarMonthStorageKey() {
  return "oceanTradingReplayCalendarMonth";
}

function selectedReplayCalendarMonth(dailyRows) {
  const stored = window.localStorage.getItem(replayCalendarMonthStorageKey());
  return /^\d{4}-\d{2}$/.test(stored || "") ? stored : latestCalendarMonthKey(dailyRows);
}

function setSelectedReplayCalendarMonth(monthKey) {
  window.localStorage.setItem(replayCalendarMonthStorageKey(), monthKey);
}

function resetSelectedReplayCalendarMonth() {
  window.localStorage.removeItem(replayCalendarMonthStorageKey());
}

function replayCalendarDayStorageKey() {
  return "oceanTradingReplayCalendarDay";
}

function selectedReplayCalendarDay(dailyRows, selectedMonth) {
  const stored = window.localStorage.getItem(replayCalendarDayStorageKey());
  const dayRows = dailyRows.map((row) => row.period);
  if (dayRows.includes(stored)) return stored;
  return latestReplayDayKey(dailyRows, selectedMonth);
}

function setSelectedReplayCalendarDay(dayKey) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(dayKey || "")) {
    window.localStorage.setItem(replayCalendarDayStorageKey(), dayKey);
    const month = monthKeyFromPeriod(dayKey);
    if (month) setSelectedReplayCalendarMonth(month);
  }
}

function resetSelectedReplayCalendarDay() {
  window.localStorage.removeItem(replayCalendarDayStorageKey());
}

function currentMonthKey() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function replayCalendarViewModeStorageKey() {
  return "oceanTradingReplayCalendarViewMode";
}

function replayCalendarViewMode() {
  const stored = window.localStorage.getItem(replayCalendarViewModeStorageKey());
  return ["today", "week", "month"].includes(stored) ? stored : "month";
}

function setReplayCalendarViewMode(mode) {
  window.localStorage.setItem(replayCalendarViewModeStorageKey(), ["today", "week", "month"].includes(mode) ? mode : "month");
}

function replayTradePageStorageKey(accountId) {
  return `oceanTradingReplayTradePage:${accountId || "Sim1"}`;
}

function replayTradePageSizeStorageKey(accountId) {
  return `oceanTradingReplayTradePageSize:${accountId || "Sim1"}`;
}

function replayTradePage(accountId) {
  return Math.max(1, Number(window.localStorage.getItem(replayTradePageStorageKey(accountId))) || 1);
}

function setReplayTradePage(accountId, page) {
  window.localStorage.setItem(replayTradePageStorageKey(accountId), String(Math.max(1, Number(page) || 1)));
}

function replayTradePageSize(accountId) {
  const stored = Number(window.localStorage.getItem(replayTradePageSizeStorageKey(accountId))) || 8;
  return [8, 16, 32].includes(stored) ? stored : 8;
}

function setReplayTradePageSize(accountId, pageSize) {
  const size = [8, 16, 32].includes(Number(pageSize)) ? Number(pageSize) : 8;
  window.localStorage.setItem(replayTradePageSizeStorageKey(accountId), String(size));
  setReplayTradePage(accountId, 1);
}

function replayTradeFiltersOpenStorageKey() {
  return "oceanTradingReplayTradeFiltersOpen";
}

function replayTradeFiltersOpen() {
  return window.localStorage.getItem(replayTradeFiltersOpenStorageKey()) === "true";
}

function setReplayTradeFiltersOpen(open) {
  window.localStorage.setItem(replayTradeFiltersOpenStorageKey(), open ? "true" : "false");
}

function compactMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "n/a";
  const sign = number < 0 ? "-" : "";
  const abs = Math.abs(number);
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(abs >= 10000 ? 0 : 1)}K`;
  return formatCurrency(number);
}

function abbreviateStrategyName(value) {
  const text = String(value || "Unknown").replace(/^Ocean Trading\s+/i, "").replace(/\bNQ\b|\bMNQ\b/gi, "").replace(/\s+/g, " ").trim();
  const rules = [
    [/vwap.*reclaim/i, "VWAP Reclaim"],
    [/opening range|orb/i, "ORB"],
    [/lunchy|ifvg/i, "Lunchy IFVG"],
    [/rubberband/i, "RubberBand"],
    [/manual/i, "Manual"],
  ];
  for (const [pattern, label] of rules) {
    if (pattern.test(text)) return label;
  }
  return text.split(" ").filter(Boolean).slice(0, 3).join(" ") || "Unknown";
}

function selectedModeTrades(manifest, mode) {
  if (mode === "paper") {
    return paperClosedTrades(manifest);
  }
  return liveClosedTrades(manifest);
}

function latestTradeTimestampMs(trades) {
  let latest = 0;
  for (const trade of trades || []) {
    for (const candidate of [trade?.exitAtUtc, trade?.tradeDateUtc, trade?.entryAtUtc]) {
      if (!candidate) continue;
      const parsed = Date.parse(String(candidate));
      if (Number.isFinite(parsed)) latest = Math.max(latest, parsed);
    }
  }
  return latest;
}

function pickMoreCompleteTradeSet(primary, fallback) {
  const primaryRows = Array.isArray(primary) ? primary : [];
  const fallbackRows = Array.isArray(fallback) ? fallback : [];
  if (!primaryRows.length) return fallbackRows;
  if (!fallbackRows.length) return primaryRows;
  const primaryLatest = latestTradeTimestampMs(primaryRows);
  const fallbackLatest = latestTradeTimestampMs(fallbackRows);
  if (fallbackRows.length > primaryRows.length) return fallbackRows;
  if (fallbackLatest > primaryLatest) return fallbackRows;
  return primaryRows;
}

function liveClosedTrades(manifest) {
  const live = manifest.tradingModes?.live || {};
  return pickMoreCompleteTradeSet(live.performanceClosedTrades, live.closedTrades);
}

function performanceModulePnl(manifest, mode, dailyRows) {
  if (mode === "paper") {
    return paperRealizedPnlSummary(manifest.tradingModes?.paper || {}).net;
  }
  return dailyRows.reduce((sum, row) => sum + row.netPnl, 0);
}

function performanceModuleReturns(manifest, mode, pnl) {
  const denominator = mode === "paper"
    ? paperAccountSizeSummary(manifest.tradingModes?.paper || {}).accountSizeDollars
    : manifest.riskProfiles?.lucidFlex50k?.evaluation?.accountSizeDollars;
  const number = Number(denominator);
  return Number.isFinite(number) && number > 0 ? pnl / number : null;
}

function performanceModuleStats(manifest, mode) {
  const trades = selectedModeTrades(manifest, mode);
  const actualRows = [];
  const dailyRows = summarizePeriodRows(trades, "daily", mode, actualRows);
  const pnl = performanceModulePnl(manifest, mode, dailyRows);
  const tradeCount = trades.length;
  const wins = trades.filter((trade) => Number(trade.realizedPnlDollars) > 0).length;
  const grossWins = trades.reduce((sum, trade) => sum + Math.max(0, Number(trade.realizedPnlDollars) || 0), 0);
  const grossLosses = Math.abs(trades.reduce((sum, trade) => sum + Math.min(0, Number(trade.realizedPnlDollars) || 0), 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : null;
  const paper = manifest.tradingModes?.paper || {};
  const paperActivityRows = mode === "paper"
    ? [
        ...(paper.separation?.otherStrategies?.rows || []).map((row) => ({
          strategyName: row.strategy,
          realizedPnlDollars: row.realizedPnlDollars || 0,
          tradesObserved: row.tradesObserved || 0,
          fillsObserved: row.fillsObserved || 0,
          active: true,
        })),
        ...(paper.openPositions || []).map((position) => ({
          strategyName: position.strategyName || position.owner || "Open Paper Position",
          realizedPnlDollars: 0,
          openQuantity: position.quantity,
          active: true,
        })),
      ]
    : [];
  return {
    trades,
    dailyRows,
    pnl,
    tradeCount,
    winRate: tradeCount ? wins / tradeCount : null,
    returns: performanceModuleReturns(manifest, mode, pnl),
    profitFactor,
    strategyProfitRows: buildStrategyProfitRows(trades, paperActivityRows),
  };
}

function buildStrategyProfitRows(trades, activityRows = []) {
  const grouped = new Map();
  for (const trade of trades || []) {
    const key = abbreviateStrategyName(trade.strategyName || trade.owner || "Unknown");
    const existing = grouped.get(key) || { label: key, pnl: 0, trades: 0 };
    existing.pnl += Number(trade.realizedPnlDollars) || 0;
    existing.trades += 1;
    grouped.set(key, existing);
  }
  for (const row of activityRows || []) {
    const key = abbreviateStrategyName(row.strategyName || row.strategy || row.owner || "Unknown");
    const existing = grouped.get(key) || { label: key, pnl: 0, trades: 0, fills: 0, active: false };
    existing.pnl += Number(row.realizedPnlDollars ?? row.netProfitDollars ?? 0) || 0;
    existing.trades += Number(row.tradesObserved ?? row.trades ?? 0) || 0;
    existing.fills += Number(row.fillsObserved ?? row.openQuantity ?? 0) || 0;
    existing.active = Boolean(existing.active || row.active || row.openQuantity);
    grouped.set(key, existing);
  }
  const rows = [...grouped.values()].sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl)).slice(0, 6);
  return rows;
}

function renderStrategyProfitBars(tradesOrRows) {
  const rows = (tradesOrRows || []).every((row) => Object.prototype.hasOwnProperty.call(row, "label"))
    ? tradesOrRows || []
    : buildStrategyProfitRows(tradesOrRows || []);
  if (!rows.length) return '<p class="empty">No strategy profit rows are available for this mode yet.</p>';
  const max = Math.max(...rows.map((row) => Math.abs(row.pnl)), 1);
  return `
    <div class="strategy-profit-bars">
      ${rows.map((row) => {
        const width = Math.max(6, Math.round((Math.abs(row.pnl) / max) * 100));
        const tone = row.pnl < 0 ? "loss" : "gain";
        const activity = row.trades ? `${row.trades} closed` : row.active ? "open" : "no closed trades";
        const label = row.active && !row.trades ? `${row.label} (open)` : row.label;
        return `
          <div class="strategy-profit-row">
            <span class="strategy-profit-label" title="${escapeHtml(`${row.label} - ${activity}`)}">${escapeHtml(label)}</span>
            <div class="strategy-profit-track">
              <span class="strategy-profit-bar ${tone}" style="width: ${width}%"></span>
            </div>
            <strong>${escapeHtml(compactMoney(row.pnl))}</strong>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function renderDashboardCalendarGrid(dailyRows, monthKey, options = {}) {
  const selectedMonth = /^\d{4}-\d{2}$/.test(monthKey || "") ? monthKey : latestCalendarMonthKey(dailyRows);
  const monthDate = monthDateFromKey(selectedMonth);
  const year = monthDate.getUTCFullYear();
  const month = monthDate.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const firstDay = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const startOffset = (firstDay + 6) % 7;
  const byDay = new Map();
  for (const row of dailyRows.filter((item) => monthKeyFromPeriod(item.period) === selectedMonth)) {
    const existing = byDay.get(row.period) || { period: row.period, trades: 0, wins: 0, losses: 0, netPnl: 0 };
    existing.trades += Number(row.trades) || 0;
    existing.wins += Number(row.wins) || 0;
    existing.losses += Number(row.losses) || 0;
    existing.netPnl += Number(row.netPnl) || 0;
    byDay.set(row.period, existing);
  }
  const cells = [];
  for (let i = 0; i < startOffset; i += 1) cells.push({ blank: true });
  for (let day = 1; day <= daysInMonth; day += 1) {
    const period = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    cells.push({ day, row: byDay.get(period) || null });
  }
  while (cells.length % 7 !== 0) cells.push({ blank: true });
  return `
    <div class="dashboard-calendar-banner">
      <div class="dashboard-calendar-nav">
        <button type="button" aria-label="Previous month" data-calendar-previous-month>&lsaquo;</button>
        <button type="button" aria-label="Next month" data-calendar-next-month>&rsaquo;</button>
      </div>
      <div class="replay-period-summary">
        <strong>${escapeHtml(options.summaryLabel || monthName(monthDate))}</strong>
        ${options.summaryTotal === undefined || options.summaryTotal === null ? "" : `<span class="replay-period-total ${options.summaryTone || ""}">${escapeHtml(options.summaryTotalLabel || "Total")}: ${escapeHtml(formatCurrency(options.summaryTotal))}</span>`}
      </div>
      <button type="button" aria-label="Show latest month" data-calendar-refresh>&#8635;</button>
    </div>
    <div class="dashboard-calendar-grid" role="grid" aria-label="Performance calendar">
      ${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => `<span class="calendar-weekday">${day}</span>`).join("")}
      ${cells.map((cell) => {
        if (cell.blank) return '<div class="calendar-day muted"></div>';
        const pnl = Number(cell.row?.netPnl || 0);
        const tone = cell.row ? (pnl < 0 ? "loss" : "gain") : "";
        return `
          <div class="calendar-day ${tone}">
            <span>${cell.day}</span>
            ${cell.row ? `<strong>${escapeHtml(compactMoney(pnl))}</strong><small>${escapeHtml(cell.row.trades)} trades</small>` : ""}
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function dashboardTradeTimestamp(trade) {
  return trade?.exitAtUtc || trade?.tradeDateUtc || trade?.entryAtUtc || trade?.entryKey || "";
}

function dashboardTradeDay(trade) {
  const explicit = String(dashboardTradeTimestamp(trade) || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(explicit) ? explicit : null;
}

function dashboardTradeAccountKey(trade) {
  return `${trade?.accountType || "Account"}::${trade?.account || "n/a"}`;
}

function dashboardShortAccountLabel(trade, mode) {
  if (mode === "paper") return trade?.account || "Sim1";
  const type = String(trade?.accountType || "Live Account").replace(/\s+Evaluation$/i, " Eval");
  const account = String(trade?.account || "").trim();
  if (!account) return type;
  const compact = account.length > 16 ? account.replace(/^([A-Z]+)\d+[-_]?/i, "$1-").slice(0, 18) : account;
  return `${type} / ${compact}`;
}

function dashboardFullAccountLabel(account) {
  if (!account || account.key === "all") return account?.label || "All accounts";
  return account.accountType && account.account
    ? `${account.accountType} - ${account.account}`
    : account.account || account.accountType || account.label;
}

function dashboardModeAccountOptions(trades, mode) {
  const grouped = new Map();
  for (const trade of trades || []) {
    const key = dashboardTradeAccountKey(trade);
    const existing = grouped.get(key) || {
      key,
      accountType: trade?.accountType || (mode === "paper" ? "Paper Simulation" : "Live Account"),
      account: trade?.account || (mode === "paper" ? "Sim1" : "n/a"),
      trades: 0,
      pnl: 0,
    };
    existing.trades += 1;
    existing.pnl += Number(trade?.realizedPnlDollars) || 0;
    grouped.set(key, existing);
  }
  const accounts = [...grouped.values()].sort((a, b) =>
    String(a.accountType).localeCompare(String(b.accountType)) ||
    String(a.account).localeCompare(String(b.account))
  );
  const allLabel = mode === "paper" ? "All paper accounts" : "All live accounts";
  return [
    {
      key: "all",
      label: allLabel,
      accountType: mode === "paper" ? "Paper" : "Live",
      account: "all",
      trades: trades.length,
      pnl: trades.reduce((sum, trade) => sum + (Number(trade?.realizedPnlDollars) || 0), 0),
    },
    ...accounts.map((account) => ({
      ...account,
      label: dashboardFullAccountLabel(account),
    })),
  ];
}

function selectedDashboardAccountOption(mode, trades) {
  const options = dashboardModeAccountOptions(trades, mode);
  const selected = dashboardPerformanceAccountScope(mode);
  return options.find((account) => account.key === selected) || options[0];
}

function dashboardTradesForAccountScope(trades, accountScope) {
  if (!accountScope || accountScope === "all") return trades || [];
  return (trades || []).filter((trade) => dashboardTradeAccountKey(trade) === accountScope);
}

function dashboardDailyRowsFromTrades(trades) {
  const grouped = new Map();
  for (const trade of trades || []) {
    const period = dashboardTradeDay(trade);
    const pnl = Number(trade?.realizedPnlDollars);
    if (!period || !Number.isFinite(pnl)) continue;
    const row = grouped.get(period) || { period, trades: 0, wins: 0, losses: 0, netPnl: 0 };
    row.trades += 1;
    row.netPnl += pnl;
    if (pnl > 0) row.wins += 1;
    if (pnl < 0) row.losses += 1;
    grouped.set(period, row);
  }
  return [...grouped.values()]
    .map((row) => ({
      ...row,
      netPnl: Number(row.netPnl.toFixed(2)),
      successRate: row.trades ? row.wins / row.trades : null,
    }))
    .sort((a, b) => a.period.localeCompare(b.period));
}

function liveActualPnlRows(manifest, accountScope, trades = []) {
  const live = manifest.tradingModes?.live || {};
  const rows = live.profitReconciliation?.rows || [];
  const scoped = accountScope === "all"
    ? rows
    : rows.filter((row) => dashboardTradeAccountKey({ account: row.account, accountType: "Prop Evaluation" }) === accountScope);
  const grouped = new Map();
  for (const row of scoped) {
    const accountTrades = (trades || [])
      .filter((trade) => String(trade?.account || "") === String(row.account || ""))
      .filter((trade) => Number.isFinite(Number(trade?.realizedPnlDollars)));
    const closedByPeriod = new Map();
    for (const trade of accountTrades) {
      const period = dashboardTradeDay(trade);
      if (!period) continue;
      closedByPeriod.set(period, (closedByPeriod.get(period) || 0) + (Number(trade.realizedPnlDollars) || 0));
    }
    const periods = [...closedByPeriod.keys()].sort();
    const latestAccountTradeDate = periods.at(-1);
    const parsed = parseTradeTimestamp(row.balanceAsOfUtc || latestAccountTradeDate || live.profitReconciliation?.generatedAtUtc || manifest.generatedAtUtc);
    const fallbackPeriod = parsed ? parsed.toISOString().slice(0, 10) : null;
    const totalPnl = Number(row.trueProfitDollars);
    if (!Number.isFinite(totalPnl)) continue;

    const monitorDaily = Number(row.monitorDailyProfitLossDollars);
    const monitorPeriod = parseTradeTimestamp(row.monitorDailyProfitLossDateUtc || row.balanceAsOfUtc);
    const monitorDay = monitorPeriod ? monitorPeriod.toISOString().slice(0, 10) : fallbackPeriod;
    const hasUsableDailyMonitor = Number.isFinite(monitorDaily)
      && monitorDay
      && (!latestAccountTradeDate || monitorDay === latestAccountTradeDate);

    const addAdjustment = (period, adjustment, source) => {
      if (!period || !Number.isFinite(adjustment)) return;
      const rounded = Number(adjustment.toFixed(2));
      const existing = grouped.get(period) || {
        period,
        netPnl: 0,
        adjustmentDollars: 0,
        source,
        sourceFile: row.sourceFile || null,
      };
      existing.netPnl += rounded;
      existing.adjustmentDollars += rounded;
      if (existing.source !== source) existing.source = "mixed_reconciliation";
      grouped.set(period, existing);
    };

    if (hasUsableDailyMonitor) {
      const latestClosed = Number((closedByPeriod.get(monitorDay) || 0).toFixed(2));
      addAdjustment(monitorDay, monitorDaily - latestClosed, "trade_account_monitor_daily");
      if (row.trueProfitSource === "trade_account_monitor") continue;

      const priorPeriods = periods.filter((period) => period !== monitorDay);
      const priorClosed = Number(priorPeriods.reduce((sum, period) => sum + (closedByPeriod.get(period) || 0), 0).toFixed(2));
      const priorTarget = Number((totalPnl - monitorDaily).toFixed(2));
      const targetPeriod = priorPeriods.at(-1);
      if (targetPeriod) {
        addAdjustment(targetPeriod, priorTarget - priorClosed, row.trueProfitSource || "account_balance_delta");
      } else if (Math.abs(priorTarget) >= 0.005) {
        addAdjustment(monitorDay, priorTarget, row.trueProfitSource || "account_balance_delta");
      }
      continue;
    }

    const closedTotal = Number([...closedByPeriod.values()].reduce((sum, value) => sum + value, 0).toFixed(2));
    addAdjustment(latestAccountTradeDate || fallbackPeriod, totalPnl - closedTotal, row.trueProfitSource || "account_balance_delta");
  }
  return [...grouped.values()].map((row) => ({ ...row, netPnl: Number(row.netPnl.toFixed(2)) }));
}

function applyLiveActualPnlRows(dailyRows, actualRows) {
  if (!actualRows.length) return dailyRows;
  const byPeriod = new Map((dailyRows || []).map((row) => [row.period, { ...row }]));
  for (const actual of actualRows) {
    const row = byPeriod.get(actual.period) || { period: actual.period, trades: 0, wins: 0, losses: 0, netPnl: 0, successRate: null };
    row.tradeNetPnl = row.netPnl;
    if (Number.isFinite(Number(actual.adjustmentDollars))) {
      row.netPnl = Number((row.netPnl + Number(actual.adjustmentDollars)).toFixed(2));
      row.reconciliationAdjustmentDollars = Number(((row.reconciliationAdjustmentDollars || 0) + Number(actual.adjustmentDollars)).toFixed(2));
    } else {
      row.netPnl = actual.netPnl;
    }
    row.actualPnlSource = actual.source;
    row.actualPnlSourceFile = actual.sourceFile;
    byPeriod.set(actual.period, row);
  }
  return [...byPeriod.values()].sort((a, b) => a.period.localeCompare(b.period));
}

function paperActualPnlRows(manifest, accountScope) {
  const paper = manifest.tradingModes?.paper || {};
  const rows = paper.accountMonitor?.rows || [];
  const scoped = accountScope === "all"
    ? rows
    : rows.filter((row) => dashboardTradeAccountKey({ account: row.account, accountType: "Paper Simulation" }) === accountScope);
  const grouped = new Map();
  for (const row of scoped) {
    const parsed = parseTradeTimestamp(row.updatedAtUtc || paper.dailyNetProfitLossDateUtc || paper.generatedAtUtc);
    const period = parsed ? parsed.toISOString().slice(0, 10) : null;
    const pnl = Number(row.dailyNetProfitLossDollars ?? row.dailyProfitLossDollars);
    if (!period || !Number.isFinite(pnl)) continue;
    const existing = grouped.get(period) || { period, netPnl: 0, source: "paper_account_snapshot", sourceFile: row.sourceFile || null };
    existing.netPnl += pnl;
    grouped.set(period, existing);
  }
  return [...grouped.values()].map((row) => ({ ...row, netPnl: Number(row.netPnl.toFixed(2)) }));
}

function dashboardScopedPerformanceStats(manifest, mode) {
  const allTrades = selectedModeTrades(manifest, mode).filter((trade) => Number.isFinite(Number(trade?.realizedPnlDollars)));
  const accountOptions = dashboardModeAccountOptions(allTrades, mode);
  if (mode === "paper") {
    for (const row of manifest.tradingModes?.paper?.accountMonitor?.rows || []) {
      const key = dashboardTradeAccountKey({ account: row.account, accountType: "Paper Simulation" });
      if (!accountOptions.some((account) => account.key === key)) {
        accountOptions.push({
          key,
          accountType: "Paper Simulation",
          account: row.account || "Sim1",
          trades: 0,
          pnl: Number(row.dailyNetProfitLossDollars ?? row.dailyProfitLossDollars) || 0,
          label: dashboardFullAccountLabel({ accountType: "Paper Simulation", account: row.account || "Sim1" }),
        });
      }
    }
    accountOptions[0].trades = allTrades.length;
    accountOptions[0].pnl = accountOptions.slice(1).reduce((sum, account) => sum + (Number(account.pnl) || 0), accountOptions[0].pnl || 0);
  }
  const selectedScope = dashboardPerformanceAccountScope(mode);
  const selectedAccount = accountOptions.find((account) => account.key === selectedScope) || accountOptions[0];
  const accountScope = selectedAccount?.key || "all";
  const trades = dashboardTradesForAccountScope(allTrades, accountScope);
  const tradeDailyRows = dashboardDailyRowsFromTrades(trades);
  const actualPnlRows = mode === "live"
    ? liveActualPnlRows(manifest, accountScope, allTrades)
    : mode === "paper"
      ? (tradeDailyRows.length ? [] : paperActualPnlRows(manifest, accountScope))
      : [];
  const dailyRows = mode === "live" || mode === "paper" ? applyLiveActualPnlRows(tradeDailyRows, actualPnlRows) : tradeDailyRows;
  const pnl = dailyRows.reduce((sum, row) => sum + (Number(row?.netPnl) || 0), 0);
  const tradeCount = trades.length;
  const wins = trades.filter((trade) => Number(trade?.realizedPnlDollars) > 0).length;
  const grossWins = trades.reduce((sum, trade) => sum + Math.max(0, Number(trade?.realizedPnlDollars) || 0), 0);
  const grossLosses = Math.abs(trades.reduce((sum, trade) => sum + Math.min(0, Number(trade?.realizedPnlDollars) || 0), 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : null;
  return {
    mode,
    allTrades,
    trades,
    dailyRows,
    tradeDailyRows,
    actualPnlRows,
    pnl: Number(pnl.toFixed(2)),
    pnlSource: actualPnlRows.length
      ? (mode === "paper"
        ? "paper_account_snapshot"
        : actualPnlRows.every((row) => row.source === "trade_account_monitor")
          ? "trade_account_monitor"
          : "live_reconciled_total")
      : "sqlite_closed_trades",
    tradeCount,
    winRate: tradeCount ? wins / tradeCount : null,
    profitFactor,
    accountOptions,
    selectedAccount,
    accountScope,
    selectedAccountCount: accountScope === "all" ? Math.max(0, accountOptions.length - 1) : 1,
  };
}

function dashboardBrokerAccountBalance(manifest, stats, mode) {
  if (mode !== "live") return null;
  const snapshots = Array.isArray(manifest.tradingModes?.live?.accountSnapshots)
    ? manifest.tradingModes.live.accountSnapshots
    : [];
  const selectedAccounts = stats.accountScope === "all"
    ? stats.accountOptions.filter((account) => account.key !== "all").map((account) => account.account)
    : [stats.selectedAccount?.account].filter(Boolean);
  const resolved = window.OceanBrokerAccountBalance?.resolve({
    snapshots,
    selectedAccounts,
    openPositions: manifest.tradingModes?.live?.openPositions || [],
    closedTrades: stats.allTrades || [],
  });
  return resolved || { value: null, rows: [], source: "unavailable" };
}

function dashboardPeriodDayKey(mode, stats) {
  const selectedMonth = selectedDashboardCalendarMonth(mode, stats.dailyRows);
  return selectedDashboardCalendarDay(mode, stats.dailyRows, selectedMonth);
}

function offsetDateKey(dayKey, offsetDays) {
  const date = new Date(`${dayKey}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return dayKey;
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function dashboardTradeHour(trade) {
  const timestamp = dashboardTradeTimestamp(trade);
  const date = parseTradeTimestamp(timestamp);
  if (!date) return null;
  const hour = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    hour12: false,
  }).format(date);
  return Number(hour);
}

function renderDashboardTodayCalendar(stats, mode) {
  const dayKey = dashboardPeriodDayKey(mode, stats);
  const byHour = new Map(Array.from({ length: 24 }, (_unused, hour) => [hour, { trades: 0, netPnl: 0 }]));
  for (const trade of stats.trades.filter((item) => dashboardTradeDay(item) === dayKey)) {
    const hour = dashboardTradeHour(trade);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
    const row = byHour.get(hour);
    row.trades += 1;
    row.netPnl += Number(trade.realizedPnlDollars) || 0;
  }
  return `
    <div class="dashboard-calendar-banner replay-period-nav">
      <div class="dashboard-calendar-nav">
        <button type="button" aria-label="Previous day" data-dashboard-period-previous>&lsaquo;</button>
        <button type="button" aria-label="Next day" data-dashboard-period-next>&rsaquo;</button>
      </div>
      <strong>Daily view: ${escapeHtml(dayKey)} by hour</strong>
      <button type="button" aria-label="Show latest day" data-dashboard-period-latest>&#8635;</button>
    </div>
    <div class="replay-hour-grid">
      ${[...byHour.entries()].map(([hour, row]) => `
        <div class="calendar-day ${row.trades ? row.netPnl < 0 ? "loss" : "gain" : ""}">
          <span>${escapeHtml(String(hour).padStart(2, "0"))}:00</span>
          ${row.trades ? `<strong>${escapeHtml(formatCurrency(row.netPnl))}</strong><small>${escapeHtml(row.trades)} trades</small>` : ""}
        </div>
      `).join("")}
    </div>
  `;
}

function renderDashboardWeekCalendar(stats, mode) {
  const dayKey = dashboardPeriodDayKey(mode, stats);
  const weekStart = replayWeekStartKey(dayKey);
  const rowsByDay = new Map(stats.dailyRows.map((row) => [row.period, row]));
  const days = Array.from({ length: 7 }, (_unused, offset) => {
    const date = new Date(`${weekStart}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + offset);
    const period = date.toISOString().slice(0, 10);
    return { period, row: rowsByDay.get(period) || { period, trades: 0, netPnl: 0 } };
  });
  return `
    <div class="dashboard-calendar-banner replay-period-nav">
      <div class="dashboard-calendar-nav">
        <button type="button" aria-label="Previous week" data-dashboard-period-previous>&lsaquo;</button>
        <button type="button" aria-label="Next week" data-dashboard-period-next>&rsaquo;</button>
      </div>
      <strong>Weekly view: week of ${escapeHtml(weekStart)}</strong>
      <button type="button" aria-label="Show latest week" data-dashboard-period-latest>&#8635;</button>
    </div>
    <div class="replay-week-grid">
      ${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => `<span class="calendar-weekday">${day}</span>`).join("")}
      ${days.map(({ period, row }) => `
        <div class="calendar-day ${row.trades ? row.netPnl < 0 ? "loss" : "gain" : ""}">
          <span>${escapeHtml(period)}</span>
          ${row.trades ? `<strong>${escapeHtml(formatCurrency(row.netPnl))}</strong><small>${escapeHtml(row.trades)} trades</small>` : ""}
        </div>
      `).join("")}
    </div>
  `;
}

function renderDashboardMonthCalendar(stats, mode) {
  const selectedMonth = selectedDashboardCalendarMonth(mode, stats.dailyRows);
  const selectedMonthSafe = /^\d{4}-\d{2}$/.test(selectedMonth || "") ? selectedMonth : latestCalendarMonthKey(stats.dailyRows);
  const monthDate = monthDateFromKey(selectedMonthSafe);
  const year = monthDate.getUTCFullYear();
  const month = monthDate.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const firstDay = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const startOffset = (firstDay + 6) % 7;
  const byDay = new Map(stats.dailyRows.filter((item) => monthKeyFromPeriod(item.period) === selectedMonthSafe).map((row) => [row.period, row]));
  const cells = [];
  const previousMonth = monthDateFromKey(offsetMonthKey(selectedMonthSafe, -1));
  const previousMonthDays = new Date(Date.UTC(previousMonth.getUTCFullYear(), previousMonth.getUTCMonth() + 1, 0)).getUTCDate();
  for (let i = 0; i < startOffset; i += 1) cells.push({ day: previousMonthDays - startOffset + i + 1, muted: true });
  for (let day = 1; day <= daysInMonth; day += 1) {
    const period = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    cells.push({ day, period, row: byDay.get(period) || null });
  }
  let nextDay = 1;
  while (cells.length % 7 !== 0 || cells.length < 42) cells.push({ day: nextDay++, muted: true });
  return `
    <div class="dashboard-calendar-banner replay-period-nav">
      <div class="dashboard-calendar-nav">
        <button type="button" aria-label="Previous month" data-dashboard-period-previous>&lsaquo;</button>
        <button type="button" aria-label="Next month" data-dashboard-period-next>&rsaquo;</button>
      </div>
      <strong>${escapeHtml(monthName(monthDate))} - ${escapeHtml(stats.selectedAccount?.label || "All accounts")}</strong>
      <button type="button" aria-label="Show latest month" data-dashboard-period-latest>&#8635;</button>
    </div>
    <div class="dashboard-calendar-grid" role="grid" aria-label="Trading performance calendar">
      ${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => `<span class="calendar-weekday">${day}</span>`).join("")}
      ${cells.map((cell) => {
        const pnl = Number(cell.row?.netPnl || 0);
        const tone = cell.row ? (pnl < 0 ? "loss" : "gain") : "";
        return `
          <div class="calendar-day ${cell.muted ? "muted" : tone}">
            <span>${escapeHtml(cell.day)}</span>
            ${cell.row ? `<strong>${escapeHtml(formatCurrency(pnl))}</strong><small>${escapeHtml(cell.row.trades)} trades</small>` : ""}
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function renderDashboardCalendarBody(stats, mode) {
  const viewMode = dashboardCalendarViewMode(mode);
  if (viewMode === "today") return renderDashboardTodayCalendar(stats, mode);
  if (viewMode === "week") return renderDashboardWeekCalendar(stats, mode);
  return renderDashboardMonthCalendar(stats, mode);
}

function dashboardTradeSearchText(trade, mode) {
  return [
    dashboardShortAccountLabel(trade, mode),
    trade?.account,
    trade?.accountType,
    trade?.strategyName,
    trade?.tradeSource,
    trade?.side,
    trade?.status,
    formatCurrency(trade?.realizedPnlDollars),
    formatTradeTimestamp(dashboardTradeTimestamp(trade)),
  ].filter(Boolean).join(" ").toLowerCase();
}

function dashboardFilteredTrades(stats, mode) {
  const query = dashboardTradeSearch(mode, stats.accountScope).trim().toLowerCase();
  const sorted = [...stats.trades].sort((a, b) => String(dashboardTradeTimestamp(b)).localeCompare(String(dashboardTradeTimestamp(a))));
  return query ? sorted.filter((trade) => dashboardTradeSearchText(trade, mode).includes(query)) : sorted;
}

function renderDashboardTradesTable(stats, mode) {
  const accountScope = stats.accountScope;
  const query = dashboardTradeSearch(mode, accountScope);
  const trades = dashboardFilteredTrades(stats, mode);
  if (!trades.length) {
    return `
      <div class="replay-trade-filter-panel ${dashboardTradeFiltersOpen(mode, accountScope) ? "open" : ""}" data-dashboard-filter-panel>
        <label>Search trades <input type="search" data-dashboard-trade-search value="${escapeHtml(query)}" placeholder="Account, strategy, status, P/L, time" /></label>
      </div>
      <p class="empty">${mode === "paper" ? "No trades are present in the paper telemetry SQLite ledger for the selected scope." : "No trades match the selected dashboard scope."}</p>
    `;
  }
  const pageSize = dashboardTradePageSize(mode, accountScope);
  const pageCount = Math.max(1, Math.ceil(trades.length / pageSize));
  const page = Math.min(dashboardTradePage(mode, accountScope), pageCount);
  if (page !== dashboardTradePage(mode, accountScope)) setDashboardTradePage(mode, accountScope, page);
  const start = (page - 1) * pageSize;
  const visible = trades.slice(start, start + pageSize);
  return `
    <div class="replay-trade-filter-panel ${dashboardTradeFiltersOpen(mode, accountScope) ? "open" : ""}" data-dashboard-filter-panel>
      <label>Search trades <input type="search" data-dashboard-trade-search value="${escapeHtml(query)}" placeholder="Account, strategy, status, P/L, time" /></label>
    </div>
    <div class="replay-dashboard-table-wrap dashboard-trade-table-wrap">
      <table class="replay-dashboard-trades dashboard-trades-table">
        <thead>
          <tr>
            <th>Account</th>
            <th>Time (UK)</th>
            <th>Strategy</th>
            <th>Direction</th>
            <th>Status</th>
            <th>P/L</th>
          </tr>
        </thead>
        <tbody>
          ${visible.map((trade) => {
            const pnl = Number(trade.realizedPnlDollars) || 0;
            const sideClass = String(trade.side || "").toLowerCase() === "short" ? "short" : "long";
            return `
              <tr>
                <td title="${escapeHtml(dashboardFullAccountLabel({
                  accountType: trade.accountType,
                  account: trade.account,
                }))}">${escapeHtml(dashboardShortAccountLabel(trade, mode))}</td>
                <td>${escapeHtml(formatTradeTimestamp(dashboardTradeTimestamp(trade)))}</td>
                <td>${escapeHtml(trade.strategyName || (trade.tradeSource === "manual" ? "Manual Trade" : "Strategy"))}</td>
                <td class="${sideClass}">${escapeHtml(humanizeStatus(trade.side || "n/a"))}</td>
                <td>${escapeHtml(formatTradeStatusDisplay(trade))}</td>
                <td class="pnl ${pnl < 0 ? "loss" : pnl > 0 ? "gain" : ""}">${escapeHtml(formatCurrency(pnl))}</td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>
    <div class="replay-table-footer">
      <span>Showing ${escapeHtml(String(start + 1))} to ${escapeHtml(String(start + visible.length))} of ${escapeHtml(String(trades.length))} trades<br />selected scope - ${escapeHtml(stats.selectedAccount?.label || "All accounts")}</span>
      <span class="replay-pagination">
        <button type="button" data-dashboard-page="${escapeHtml(String(Math.max(1, page - 1)))}" ${page <= 1 ? "disabled" : ""}>&lsaquo;</button>
        ${Array.from({ length: Math.min(pageCount, 5) }, (_unused, index) => {
          const candidate = Math.min(pageCount, Math.max(1, page - 2) + index);
          return `<button type="button" class="${candidate === page ? "active" : ""}" data-dashboard-page="${escapeHtml(String(candidate))}">${escapeHtml(String(candidate))}</button>`;
        }).filter((value, index, values) => values.indexOf(value) === index).join("")}
        <button type="button" data-dashboard-page="${escapeHtml(String(Math.min(pageCount, page + 1)))}" ${page >= pageCount ? "disabled" : ""}>&rsaquo;</button>
        <select aria-label="Rows per page" data-dashboard-page-size>
          ${[8, 16, 32].map((size) => `<option value="${size}"${size === pageSize ? " selected" : ""}>${size} / page</option>`).join("")}
        </select>
      </span>
    </div>
  `;
}

function renderDashboardAccountSelector(stats, mode) {
  return `
    <label class="dashboard-account-scope-select">
      <span>Account scope</span>
      <select data-dashboard-account-scope aria-label="Account scope">
        ${stats.accountOptions.map((account) => `<option value="${escapeHtml(account.key)}"${account.key === stats.accountScope ? " selected" : ""}>${escapeHtml(account.label)}</option>`).join("")}
      </select>
    </label>
  `;
}

function renderDashboardScopeCard(stats, mode) {
  const modeLabel = mode === "paper" ? "Paper" : "Live";
  const scopeLabel = stats.accountScope === "all" ? `All ${mode} accounts` : stats.selectedAccount?.label || "Selected account";
  const summary = stats.accountScope === "all"
    ? `Summed from ${formatCount(stats.selectedAccountCount)} active accounts`
    : `${formatCount(stats.tradeCount)} trades in selected account`;
  return `
    <article class="dashboard-scope-card">
      <span>Selected scope</span>
      <strong>${escapeHtml(`${modeLabel} - ${scopeLabel}`)}</strong>
      <small>${escapeHtml(summary)}</small>
    </article>
  `;
}

function renderDashboardScopeChips(stats) {
  const allSelected = stats.accountScope === "all";
  const accountChips = stats.accountOptions.filter((account) => account.key !== "all").slice(0, 4);
  return `
    <div class="dashboard-scope-chips">
      <button type="button" class="${allSelected ? "selected" : ""}" data-dashboard-account-chip="all">${escapeHtml(allSelected ? "All accounts selected" : "All accounts")}</button>
      ${accountChips.map((account) => `<button type="button" class="${account.key === stats.accountScope ? "selected" : ""}" data-dashboard-account-chip="${escapeHtml(account.key)}">${escapeHtml(account.label)}</button>`).join("")}
    </div>
  `;
}

function renderDashboardSourceHealth(manifest, mode) {
  if (mode !== "live") return "";
  const health = manifest.tradingModes?.live?.sourceHealth
    || manifest.tradingModes?.live?.importSummary?.sourceHealth
    || manifest.tradingModes?.live?.summary?.sourceHealth
    || null;
  if (!health?.warning) return "";
  const latest = health.latestClosedTradeUtc || health.latestFillUtc || health.latestHealthUtc || "n/a";
  return `
    <div class="dashboard-source-health warn">
      <strong>Live telemetry stale</strong>
      <span>${escapeHtml(health.warning)}</span>
      <small>Latest row: ${escapeHtml(String(latest))}</small>
    </div>
  `;
}

function renderDashboardPerformanceCalendar(manifest, mode = defaultDashboardPerformanceMode(manifest)) {
  const stats = dashboardScopedPerformanceStats(manifest, mode);
  const brokerBalance = dashboardBrokerAccountBalance(manifest, stats, mode);
  const modeLabel = mode === "paper" ? "Paper" : "Live";
  const pnlLabel = stats.pnlSource === "trade_account_monitor"
    ? "Account monitor P&L"
    : stats.pnlSource === "live_reconciled_total"
      ? "Reconciled total P&L"
    : stats.pnlSource === "paper_account_snapshot"
      ? "Account snapshot P&L"
      : "Total P&L";
  const summationLabel = stats.pnlSource === "trade_account_monitor"
    ? "Calendar P&L uses Trade Account Monitor; table uses SQLite trades"
    : stats.pnlSource === "live_reconciled_total"
      ? "Calendar P&L sums each live account's best available reconciliation; table uses SQLite trades"
    : stats.pnlSource === "paper_account_snapshot"
      ? "Calendar P&L uses paper telemetry account_snapshot; table uses SQLite trades"
      : "Calendar and table use selected scope";
  const viewMode = dashboardCalendarViewMode(mode);
  const pnlTrend = stats.dailyRows.map((row) => row.netPnl);
  const tradeTrend = stats.dailyRows.map((row) => row.trades);
  const winTrend = stats.dailyRows.map((row) => row.wins / Math.max(1, row.trades));
  const profitFactorTrend = stats.dailyRows.map((row) => row.netPnl);
  return `
    <section class="panel dashboard-performance-panel dashboard-trading-calendar" data-dashboard-performance-calendar data-dashboard-mode="${escapeHtml(mode)}" data-dashboard-account-scope="${escapeHtml(stats.accountScope)}">
      <div class="section-head dashboard-performance-head">
        <div>
          <h2>Trading Performance Calendar</h2>
          <p>Paper and live results use the same calendar plus trade-table layout, with account-level filtering and summed all-account totals.</p>
        </div>
        <div class="dashboard-performance-controls">
          <div class="dashboard-mode-toggle" role="group" aria-label="Trading mode">
            <button type="button" class="${mode === "paper" ? "active" : ""}" data-dashboard-mode-option="paper" aria-pressed="${mode === "paper" ? "true" : "false"}">Paper</button>
            <button type="button" class="${mode === "live" ? "active" : ""}" data-dashboard-mode-option="live" aria-pressed="${mode === "live" ? "true" : "false"}">Live</button>
          </div>
          ${renderDashboardAccountSelector(stats, mode)}
        </div>
      </div>
      <div class="replay-dashboard-stats dashboard-performance-stats">
        ${renderDashboardScopeCard(stats, mode)}
        ${mode === "live" ? renderReplayMetricCard(
          "Broker account balance",
          brokerBalance?.value === null || brokerBalance?.value === undefined ? "n/a" : formatCurrency(brokerBalance.value),
          brokerBalance?.value === null || brokerBalance?.value === undefined ? "neutral" : "gain",
          "",
        ) : ""}
        ${renderReplayMetricCard(pnlLabel, formatCurrency(stats.pnl), stats.pnl < 0 ? "loss" : "gain", renderReplaySparkline(pnlTrend, "line"))}
        ${renderReplayMetricCard("Trades", formatCount(stats.tradeCount), "neutral", renderReplaySparkline(tradeTrend, "bars"))}
        ${renderReplayMetricCard("Win Rate", formatPercent(stats.winRate), "neutral", renderReplaySparkline(winTrend, "line"))}
        ${renderReplayMetricCard("Profit Factor", stats.profitFactor === Infinity ? "Inf" : stats.profitFactor === null ? "n/a" : stats.profitFactor.toFixed(2), "neutral", renderReplaySparkline(profitFactorTrend, "line"))}
      </div>
      ${renderDashboardScopeChips(stats)}
      ${renderDashboardSourceHealth(manifest, mode)}
      <div class="replay-dashboard-main dashboard-performance-main">
        <article class="replay-dashboard-card dashboard-calendar-card">
          <header>
            <h2>Performance Calendar</h2>
            <div class="replay-card-actions">
              <button type="button" class="${viewMode === "today" ? "active" : ""}" data-dashboard-calendar-view="today">Today</button>
              <button type="button" aria-label="Refresh calendar data" data-dashboard-calendar-rebuild>&#9635;</button>
              <div class="replay-view-toggle">
                <button type="button" class="${viewMode === "month" ? "active" : ""}" data-dashboard-calendar-view="month">This month</button>
                <button type="button" class="${viewMode === "week" ? "active" : ""}" data-dashboard-calendar-view="week">This week</button>
              </div>
            </div>
          </header>
          <div class="replay-calendar-frame dashboard-calendar-frame">
            ${renderDashboardCalendarBody(stats, mode)}
          </div>
          ${renderReplayCalendarLegend()}
        </article>
        <article class="replay-dashboard-card dashboard-trades-card">
          <header>
            <h2>Trades (${escapeHtml(modeLabel)} - ${escapeHtml(stats.selectedAccount?.label || "All accounts")})</h2>
            <div class="replay-card-actions">
              <button type="button" data-dashboard-filter-toggle>Filters</button>
              <button type="button" data-dashboard-export>Export</button>
            </div>
          </header>
          ${renderDashboardTradesTable(stats, mode)}
        </article>
      </div>
      <section class="replay-dashboard-audit dashboard-performance-audit">
        <div class="replay-audit-grid">
          <div>
            <span>Mode filter</span>
            <strong>${escapeHtml(modeLabel)}</strong>
          </div>
          <div>
            <span>Account filter</span>
            <strong>${escapeHtml(stats.selectedAccount?.label || "All accounts")}</strong>
          </div>
          <div>
            <span>Source logs</span>
            <strong>${escapeHtml(mode === "paper" ? "PATrading paper telemetry SQLite trades table" : "PATrading live SQLite trades table")}</strong>
          </div>
          <div>
            <span>Summation</span>
            <strong>${escapeHtml(summationLabel)}</strong>
          </div>
        </div>
      </section>
    </section>
  `;
}

function replayTradeStrategyLabel(trade) {
  return trade.hermesProfile || trade.hermesAction || trade.targetPlanLabel || "Replay Trade";
}

const REPLAY_ACTION_STATUS_KEY = "oceanTradingReplayActionStatus";

function replayActionStatus() {
  try {
    const raw = window.sessionStorage.getItem(REPLAY_ACTION_STATUS_KEY);
    if (!raw) return "Idle";
    const parsed = JSON.parse(raw);
    return typeof parsed?.message === "string" && parsed.message.trim() ? parsed.message : "Idle";
  } catch {
    return "Idle";
  }
}

function setReplayActionStatus(message) {
  try {
    window.sessionStorage.setItem(
      REPLAY_ACTION_STATUS_KEY,
      JSON.stringify({ message, updatedAtUtc: new Date().toISOString() }),
    );
  } catch {
    // Status feedback is helpful but not required for the rebuild itself.
  }
  document.querySelectorAll("[data-replay-status]").forEach((target) => {
    target.textContent = message || "Idle";
  });
}

function replayTradeSessionDay(trade) {
  const explicit = String(trade?.lucidSessionDay || trade?.sessionDay || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(explicit)) return explicit;
  const entryKey = String(trade?.entryKey || "");
  return /^\d{4}-\d{2}-\d{2}/.test(entryKey) ? entryKey.slice(0, 10) : null;
}

function replayPerformanceStats(session) {
  const trades = Array.isArray(session?.groupedTradesVisible)
    ? session.groupedTradesVisible
    : Array.isArray(session?.groupedTrades)
      ? session.groupedTrades
      : [];
  const realizedTrades = trades.filter((trade) =>
    Number.isFinite(Number(trade?.realizedPnlDollars)) &&
    String(trade?.completionStatus || "").toLowerCase() !== "open"
  );
  const grouped = new Map();
  for (const trade of realizedTrades) {
    const pnl = Number(trade?.realizedPnlDollars);
    const period = replayTradeSessionDay(trade);
    if (!period) continue;
    const row = grouped.get(period) || { period, trades: 0, wins: 0, losses: 0, netPnl: 0 };
    row.trades += 1;
    row.netPnl += pnl;
    if (pnl > 0) row.wins += 1;
    if (pnl < 0) row.losses += 1;
    grouped.set(period, row);
  }
  const openPositions = Array.isArray(session?.openPositions) ? session.openPositions : [];
  for (const position of openPositions) {
    const pnl = Number(position?.unrealizedPnlDollars);
    const period = String(position?.lastUpdatedUtc || position?.openedAtUtc || "").slice(0, 10);
    if (!period || !Number.isFinite(pnl) || pnl === 0) continue;
    const row = grouped.get(period) || { period, trades: 0, wins: 0, losses: 0, netPnl: 0 };
    row.netPnl += pnl;
    grouped.set(period, row);
  }
  const dailyRows = [...grouped.values()].sort((a, b) => a.period.localeCompare(b.period));
  const logPnl = realizedTrades.reduce((sum, trade) => sum + (Number(trade?.realizedPnlDollars) || 0), 0)
    + openPositions.reduce((sum, position) => sum + (Number(position?.unrealizedPnlDollars) || 0), 0);
  const pnl = logPnl;
  const tradeCount = realizedTrades.length;
  const wins = realizedTrades.filter((trade) => Number(trade?.realizedPnlDollars) > 0).length;
  const grossWins = realizedTrades.reduce((sum, trade) => sum + Math.max(0, Number(trade?.realizedPnlDollars) || 0), 0);
  const grossLosses = Math.abs(realizedTrades.reduce((sum, trade) => sum + Math.min(0, Number(trade?.realizedPnlDollars) || 0), 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : null;
  return {
    trades: realizedTrades.map((trade) => ({
      ...trade,
      strategyName: replayTradeStrategyLabel(trade),
    })),
    dailyRows,
    pnl,
    logPnl,
    pnlSource: "trade_activity_logs",
    tradeCount,
    winRate: tradeCount ? wins / tradeCount : null,
    profitFactor,
  };
}

function renderReplayPerformanceCalendar(session) {
  const stats = replayPerformanceStats(session);
  const selectedMonth = selectedReplayCalendarMonth(stats.dailyRows);
  const viewMode = replayCalendarViewMode();
  const pnlTrend = stats.dailyRows.map((row) => row.netPnl);
  const tradeTrend = stats.dailyRows.map((row) => row.trades);
  const winTrend = stats.dailyRows.map((row) => row.wins / Math.max(1, row.trades));
  const profitFactorTrend = stats.dailyRows.map((row) => row.netPnl);
  return `
    <section class="replay-dashboard-shell" data-replay-performance-calendar>
      <div class="replay-dashboard-stats">
        ${renderReplayAccountDropdown(session)}
        ${renderReplayMetricCard(stats.pnlSource === "sierra_window_npl" ? "Sierra NPL" : "Total P&L", formatCurrency(stats.pnl), stats.pnl < 0 ? "loss" : "gain", renderReplaySparkline(pnlTrend, "line"))}
        ${renderReplayMetricCard("Replay Trades", formatCount(stats.tradeCount), "neutral", renderReplaySparkline(tradeTrend, "bars"))}
        ${renderReplayMetricCard("Win Rate", formatPercent(stats.winRate), "neutral", renderReplaySparkline(winTrend, "line"))}
        ${renderReplayMetricCard("Profit Factor", stats.profitFactor === Infinity ? "Inf" : stats.profitFactor === null ? "n/a" : stats.profitFactor.toFixed(2), "neutral", renderReplaySparkline(profitFactorTrend, "line"))}
      </div>
      ${renderReplayAccountClearToolbar(session, stats)}
      <div class="replay-dashboard-main">
        <article class="replay-dashboard-card replay-calendar-card">
          <header>
            <div>
              <h2>Replay Performance Calendar</h2>
            </div>
            <div class="replay-card-actions">
              <button type="button" aria-label="Today" data-calendar-refresh>Today</button>
              <button type="button" aria-label="Calendar">▣</button>
              <div class="replay-view-toggle"><button class="active">Month</button><button>Week</button><button>List</button></div>
            </div>
          </header>
          <div class="replay-calendar-frame">
            ${renderDashboardCalendarGrid(stats.dailyRows, selectedMonth)}
          </div>
          ${renderReplayCalendarLegend()}
        </article>
        <article class="replay-dashboard-card replay-trades-card">
          <header>
            <h2>Replay Trades (${escapeHtml(session.selectedReplayAccountLabel || "SIM 1")})</h2>
            <div class="replay-card-actions">
              <button type="button">Filters</button>
              <button type="button">Export</button>
            </div>
          </header>
          ${renderReplayTradesCompactTable(session)}
        </article>
      </div>
      ${renderReplayAuditStrip(session)}
    </section>
  `;
}

function renderReplayMonitorDashboard(session) {
  const stats = replayPerformanceStats(session);
  const selectedMonth = selectedReplayCalendarMonth(stats.dailyRows);
  const viewMode = replayCalendarViewMode();
  const pnlTrend = stats.dailyRows.map((row) => row.netPnl);
  const tradeTrend = stats.dailyRows.map((row) => row.trades);
  const winTrend = stats.dailyRows.map((row) => row.wins / Math.max(1, row.trades));
  const profitFactorTrend = stats.dailyRows.map((row) => row.netPnl);
  return `
    <section class="replay-dashboard-shell" data-replay-performance-calendar>
      <div class="replay-dashboard-stats">
        ${renderReplayAccountDropdown(session)}
        ${renderReplayMetricCard(stats.pnlSource === "sierra_window_npl" ? "Sierra NPL" : "Total P&L", formatCurrency(stats.pnl), stats.pnl < 0 ? "loss" : "gain", renderReplaySparkline(pnlTrend, "line"))}
        ${renderReplayMetricCard("Replay Trades", formatCount(stats.tradeCount), "neutral", renderReplaySparkline(tradeTrend, "bars"))}
        ${renderReplayMetricCard("Win Rate", formatPercent(stats.winRate), "neutral", renderReplaySparkline(winTrend, "line"))}
        ${renderReplayMetricCard("Profit Factor", stats.profitFactor === Infinity ? "Inf" : stats.profitFactor === null ? "n/a" : stats.profitFactor.toFixed(2), "neutral", renderReplaySparkline(profitFactorTrend, "line"))}
      </div>
      ${renderReplayAccountClearToolbar(session, stats)}
      <div class="replay-dashboard-main">
        <article class="replay-dashboard-card replay-calendar-card">
          <header>
            <div>
              <h2>Replay Performance Calendar</h2>
            </div>
            <div class="replay-card-actions">
              <button type="button" class="${viewMode === "today" ? "active" : ""}" aria-label="Today" data-replay-calendar-today>Today</button>
              <button type="button" aria-label="Refresh replay data" data-replay-calendar-rebuild>&#9635;</button>
              <div class="replay-view-toggle">
                ${["month", "week"].map((mode) => `<button type="button" class="${viewMode === mode ? "active" : ""}" data-replay-calendar-view="${mode}">${escapeHtml(humanizeStatus(mode))}</button>`).join("")}
              </div>
            </div>
          </header>
          <div class="replay-calendar-frame">
            ${renderReplayCalendarBody(session, stats.dailyRows, selectedMonth, viewMode)}
          </div>
          ${renderReplayCalendarLegend()}
        </article>
        <article class="replay-dashboard-card replay-trades-card">
          <header>
            <h2>Replay Trades (${escapeHtml(session.selectedReplayAccountLabel || "SIM 1")})</h2>
            <div class="replay-card-actions">
              <button type="button" data-replay-filter-toggle>Filters</button>
              <button type="button" data-replay-export>Export</button>
            </div>
          </header>
          ${renderReplayTradesCompactTable(session)}
        </article>
      </div>
      ${renderReplayAuditStrip(session)}
    </section>
  `;
}

function rerenderDashboardPerformanceCalendar(target, manifest, mode = dashboardPerformanceMode()) {
  target.innerHTML = renderDashboardPerformanceCalendar(manifest, mode);
  bindDashboardPerformanceCalendar(manifest);
}

function dashboardTradeCsv(stats, mode) {
  const headers = ["Mode", "Account Type", "Account", "Time UK", "Strategy", "Direction", "Status", "P/L", "Source"];
  const rows = dashboardFilteredTrades(stats, mode).map((trade) => [
    mode,
    trade.accountType || "",
    trade.account || "",
    formatTradeTimestamp(dashboardTradeTimestamp(trade)),
    trade.strategyName || (trade.tradeSource === "manual" ? "Manual Trade" : "Strategy"),
    trade.side || "",
    formatTradeStatusDisplay(trade),
    trade.realizedPnlDollars ?? "",
    trade.sourceFile || "",
  ]);
  return [headers, ...rows]
    .map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(","))
    .join("\n");
}

function downloadDashboardTradesCsv(stats, mode) {
  const safeScope = String(stats.accountScope || "all").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-|-$/g, "") || "all";
  const blob = new Blob([dashboardTradeCsv(stats, mode)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `ocean-dashboard-${mode}-trades-${safeScope}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function bindDashboardPerformanceCalendar(manifest) {
  const target = document.getElementById("dashboard-performance-calendar");
  if (!target) return;
  const mode = target.querySelector("[data-dashboard-mode-option].active")?.dataset.dashboardModeOption || dashboardPerformanceMode();
  const stats = dashboardScopedPerformanceStats(manifest, mode);

  target.querySelectorAll("[data-dashboard-mode-option]").forEach((button) => {
    button.addEventListener("click", () => {
      const nextMode = button.dataset.dashboardModeOption === "live" ? "live" : "paper";
      setDashboardPerformanceMode(nextMode);
      rerenderDashboardPerformanceCalendar(target, manifest, nextMode);
    });
  });

  const selectAccountScope = (accountScope) => {
    const nextAccountScope = accountScope || "all";
    setDashboardPerformanceAccountScope(mode, nextAccountScope);
    setDashboardTradePage(mode, nextAccountScope, 1);
    rerenderDashboardPerformanceCalendar(target, manifest, mode);
  };

  const accountSelect = target.querySelector("[data-dashboard-account-scope]");
  accountSelect?.addEventListener("change", (event) => {
    selectAccountScope(event.currentTarget.value);
  });
  accountSelect?.addEventListener("input", (event) => {
    selectAccountScope(event.currentTarget.value);
  });
  target.querySelectorAll("[data-dashboard-account-chip]").forEach((button) => {
    button.addEventListener("click", () => {
      selectAccountScope(button.dataset.dashboardAccountChip || "all");
    });
  });

  target.querySelectorAll("[data-dashboard-calendar-view]").forEach((button) => {
    button.addEventListener("click", () => {
      const viewMode = button.dataset.dashboardCalendarView || "month";
      setDashboardCalendarViewMode(mode, viewMode);
      if (viewMode === "today" || viewMode === "week") {
        const latestDay = latestDashboardDayKey(stats.dailyRows, selectedDashboardCalendarMonth(mode, stats.dailyRows));
        if (latestDay && !/^\d{4}-\d{2}-\d{2}$/.test(window.localStorage.getItem(dashboardCalendarDayStorageKey(mode)) || "")) {
          setSelectedDashboardCalendarDay(mode, latestDay);
        }
      }
      rerenderDashboardPerformanceCalendar(target, manifest, mode);
    });
  });

  target.querySelector("[data-dashboard-period-previous]")?.addEventListener("click", () => {
    const viewMode = dashboardCalendarViewMode(mode);
    if (viewMode === "month") {
      const currentMonth = selectedDashboardCalendarMonth(mode, stats.dailyRows);
      setSelectedDashboardCalendarMonth(mode, offsetMonthKey(currentMonth, -1));
    } else {
      const currentDay = dashboardPeriodDayKey(mode, stats);
      setSelectedDashboardCalendarDay(mode, offsetDateKey(currentDay, viewMode === "week" ? -7 : -1));
    }
    rerenderDashboardPerformanceCalendar(target, manifest, mode);
  });

  target.querySelector("[data-dashboard-period-next]")?.addEventListener("click", () => {
    const viewMode = dashboardCalendarViewMode(mode);
    if (viewMode === "month") {
      const currentMonth = selectedDashboardCalendarMonth(mode, stats.dailyRows);
      setSelectedDashboardCalendarMonth(mode, offsetMonthKey(currentMonth, 1));
    } else {
      const currentDay = dashboardPeriodDayKey(mode, stats);
      setSelectedDashboardCalendarDay(mode, offsetDateKey(currentDay, viewMode === "week" ? 7 : 1));
    }
    rerenderDashboardPerformanceCalendar(target, manifest, mode);
  });

  target.querySelector("[data-dashboard-period-latest]")?.addEventListener("click", () => {
    resetSelectedDashboardCalendarMonth(mode);
    resetSelectedDashboardCalendarDay(mode);
    const latestDay = latestDashboardDayKey(stats.dailyRows, latestCalendarMonthKey(stats.dailyRows));
    if (latestDay) setSelectedDashboardCalendarDay(mode, latestDay);
    rerenderDashboardPerformanceCalendar(target, manifest, mode);
  });

  target.querySelector("[data-dashboard-calendar-rebuild]")?.addEventListener("click", () => {
    resetAllDashboardCalendarMonths();
    resetSelectedDashboardCalendarDay("paper");
    resetSelectedDashboardCalendarDay("live");
    load({ rebuild: true });
  });

  target.querySelector("[data-dashboard-filter-toggle]")?.addEventListener("click", () => {
    setDashboardTradeFiltersOpen(mode, stats.accountScope, !dashboardTradeFiltersOpen(mode, stats.accountScope));
    rerenderDashboardPerformanceCalendar(target, manifest, mode);
  });

  target.querySelector("[data-dashboard-export]")?.addEventListener("click", () => {
    downloadDashboardTradesCsv(stats, mode);
  });

  const updateTradeSearch = (value) => {
    setDashboardTradeSearch(mode, stats.accountScope, value || "");
    setDashboardTradePage(mode, stats.accountScope, 1);
    window.clearTimeout(window.__oceanDashboardTradeSearchTimer);
    window.__oceanDashboardTradeSearchTimer = window.setTimeout(() => {
      rerenderDashboardPerformanceCalendar(target, manifest, mode);
    }, 180);
  };

  const tradeSearch = target.querySelector("[data-dashboard-trade-search]");
  tradeSearch?.addEventListener("input", (event) => {
    updateTradeSearch(event.currentTarget.value);
  });
  tradeSearch?.addEventListener("search", (event) => {
    updateTradeSearch(event.currentTarget.value);
  });
  tradeSearch?.addEventListener("change", (event) => {
    updateTradeSearch(event.currentTarget.value);
  });
  tradeSearch?.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.currentTarget.value = "";
    updateTradeSearch("");
  });

  target.querySelectorAll("[data-dashboard-page]").forEach((button) => {
    button.addEventListener("click", () => {
      setDashboardTradePage(mode, stats.accountScope, button.dataset.dashboardPage);
      rerenderDashboardPerformanceCalendar(target, manifest, mode);
    });
  });

  target.querySelector("[data-dashboard-page-size]")?.addEventListener("change", (event) => {
    setDashboardTradePageSize(mode, stats.accountScope, event.currentTarget.value);
    rerenderDashboardPerformanceCalendar(target, manifest, mode);
  });
}

function rerenderReplayDashboard(target, session) {
  const parent = target.parentElement;
  target.outerHTML = renderReplayMonitorDashboard(session);
  const nextTarget = parent?.querySelector("[data-replay-performance-calendar]");
  if (!nextTarget) return;
  bindReplayMonitorActions(nextTarget, { replayMonitor: { currentSession: session } });
  bindReplayPerformanceCalendar(nextTarget, session);
  enhanceTables(nextTarget);
}

function replayTradeCsv(session) {
  const headers = ["Account", "Time UK", "Strategy", "Direction", "Entry", "Exit", "Status", "P/L", "Trade ID"];
  const rows = (session?.groupedTradesVisible || []).map((trade) => [
    trade.replayAccountLabel || trade.replayAccountId || "SIM 1",
    trade.entryKey || "",
    trade.hermesProfile || trade.hermesAction || trade.targetPlanLabel || "Replay Trade",
    trade.direction || "",
    trade.entry ?? "",
    trade.exitReason || "",
    trade.completionStatus || "",
    trade.realizedPnlDollars ?? "",
    trade.tradeId || "",
  ]);
  return [headers, ...rows]
    .map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(","))
    .join("\n");
}

function downloadReplayTradesCsv(session) {
  const account = session?.selectedReplayAccountId || selectedReplayAccountId(session);
  const blob = new Blob([replayTradeCsv(session)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `ocean-replay-trades-${account}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function bindReplayTradeFilter(target) {
  const input = target.querySelector("[data-replay-trade-search]");
  const table = target.querySelector(".replay-dashboard-trades");
  if (!input || !table) return;
  input.addEventListener("input", () => {
    const value = input.value.trim().toLowerCase();
    table.querySelectorAll("tbody tr").forEach((row) => {
      row.hidden = value && !String(row.textContent || "").toLowerCase().includes(value);
    });
  });
}

function bindReplayPerformanceCalendar(target, session) {
  if (!target) return;
  target.querySelector("[data-calendar-previous-month]")?.addEventListener("click", () => {
    const currentMonth = selectedReplayCalendarMonth(replayPerformanceStats(session).dailyRows);
    setSelectedReplayCalendarMonth(offsetMonthKey(currentMonth, -1));
    rerenderReplayDashboard(target, session);
  });
  target.querySelector("[data-calendar-next-month]")?.addEventListener("click", () => {
    const currentMonth = selectedReplayCalendarMonth(replayPerformanceStats(session).dailyRows);
    setSelectedReplayCalendarMonth(offsetMonthKey(currentMonth, 1));
    rerenderReplayDashboard(target, session);
  });
  target.querySelector("[data-replay-calendar-today]")?.addEventListener("click", () => {
    const stats = replayPerformanceStats(session);
    const latestDay = latestReplayDayKey(stats.dailyRows, selectedReplayCalendarMonth(stats.dailyRows));
    if (latestDay) setSelectedReplayCalendarDay(latestDay);
    const month = monthKeyFromPeriod(latestDay || currentMonthKey());
    if (month) setSelectedReplayCalendarMonth(month);
    setReplayCalendarViewMode("today");
    rerenderReplayDashboard(target, session);
  });
  target.querySelector("[data-replay-day-previous]")?.addEventListener("click", () => {
    const stats = replayPerformanceStats(session);
    const currentDay = selectedReplayCalendarDay(stats.dailyRows, selectedReplayCalendarMonth(stats.dailyRows));
    const nextDay = offsetReplayDayKey(stats.dailyRows, currentDay, -1);
    if (nextDay) setSelectedReplayCalendarDay(nextDay);
    setReplayCalendarViewMode("today");
    rerenderReplayDashboard(target, session);
  });
  target.querySelector("[data-replay-day-next]")?.addEventListener("click", () => {
    const stats = replayPerformanceStats(session);
    const currentDay = selectedReplayCalendarDay(stats.dailyRows, selectedReplayCalendarMonth(stats.dailyRows));
    const nextDay = offsetReplayDayKey(stats.dailyRows, currentDay, 1);
    if (nextDay) setSelectedReplayCalendarDay(nextDay);
    setReplayCalendarViewMode("today");
    rerenderReplayDashboard(target, session);
  });
  target.querySelector("[data-replay-day-latest]")?.addEventListener("click", () => {
    const stats = replayPerformanceStats(session);
    const latestDay = latestReplayDayKey(stats.dailyRows, selectedReplayCalendarMonth(stats.dailyRows));
    if (latestDay) setSelectedReplayCalendarDay(latestDay);
    setReplayCalendarViewMode("today");
    rerenderReplayDashboard(target, session);
  });
  target.querySelector("[data-calendar-refresh]")?.addEventListener("click", () => {
    resetSelectedReplayCalendarMonth();
    rerenderReplayDashboard(target, session);
  });
  target.querySelector("[data-replay-calendar-rebuild]")?.addEventListener("click", (event) => {
    void refreshReplayData(event.currentTarget);
  });
  target.querySelectorAll("[data-replay-calendar-view]").forEach((button) => {
    button.addEventListener("click", () => {
      setReplayCalendarViewMode(button.dataset.replayCalendarView || "month");
      rerenderReplayDashboard(target, session);
    });
  });
  target.querySelector("[data-replay-filter-toggle]")?.addEventListener("click", () => {
    setReplayTradeFiltersOpen(!replayTradeFiltersOpen());
    rerenderReplayDashboard(target, session);
  });
  target.querySelector("[data-replay-export]")?.addEventListener("click", () => {
    downloadReplayTradesCsv(session);
  });
  target.querySelectorAll("[data-replay-page]").forEach((button) => {
    button.addEventListener("click", () => {
      setReplayTradePage(session?.selectedReplayAccountId || selectedReplayAccountId(session), button.dataset.replayPage);
      rerenderReplayDashboard(target, session);
    });
  });
  target.querySelector("[data-replay-page-size]")?.addEventListener("change", (event) => {
    setReplayTradePageSize(session?.selectedReplayAccountId || selectedReplayAccountId(session), event.currentTarget.value);
    rerenderReplayDashboard(target, session);
  });
  bindReplayTradeFilter(target);
}

function rowRecencyValue(row) {
  const candidates = [
    row?.latestTradeDate,
    row?.lastUpdatedUtc,
    row?.exitAtUtc,
    row?.closedAtUtc,
    row?.tradeDateUtc,
    row?.openedAtUtc,
    row?.period,
  ];
  for (const value of candidates) {
    if (!value) continue;
    const timestamp = Date.parse(String(value).length === 10 ? `${value}T00:00:00Z` : String(value));
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

function uniqueValues(rows, key, filter = {}) {
  const values = new Map();
  for (const row of rows || []) {
    const raw = row?.[key];
    if (raw === null || raw === undefined || raw === "") continue;
    const value = String(raw);
    const current = values.get(value) || { value, latest: 0 };
    current.latest = Math.max(current.latest, rowRecencyValue(row));
    values.set(value, current);
  }
  const ordered = [...values.values()];
  if (filter.sort === "recent" || key === "account") {
    return ordered.sort((a, b) => b.latest - a.latest || a.value.localeCompare(b.value)).map((item) => item.value);
  }
  return ordered.map((item) => item.value).sort((a, b) => a.localeCompare(b));
}

function renderFilterRow(rows, filters) {
  return `
    <tr class="filter-row">
      ${filters
        .map((filter, index) => {
          if (!filter) return "<th></th>";
          if (filter.type === "search") {
            return `<th><input data-filter-column="${index}" type="search" placeholder="${escapeHtml(filter.label)}" /></th>`;
          }
          return `
            <th>
              <select data-filter-column="${index}" aria-label="Filter ${escapeHtml(filter.label)}">
                <option value="">All</option>
                ${uniqueValues(rows, filter.key, filter).map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("")}
              </select>
            </th>
          `;
        })
        .join("")}
    </tr>
  `;
}

function bindTableFilters(root = document) {
  root.querySelectorAll("[data-filter-table]").forEach((table) => {
    if (table.dataset.filtersBound === "true") return;
    table.dataset.filtersBound = "true";
    const controls = [...table.querySelectorAll("[data-filter-column]")];
    const apply = () => {
      const active = controls
        .map((control) => ({
          index: Number(control.dataset.filterColumn),
          value: String(control.value || "").trim().toLowerCase(),
        }))
        .filter((filter) => filter.value);
      table.querySelectorAll("tbody tr[data-filter-row]").forEach((row) => {
        const cells = row.querySelectorAll("td");
        const visible = active.every((filter) => String(cells[filter.index]?.textContent || "").toLowerCase().includes(filter.value));
        row.hidden = !visible;
      });
    };
    controls.forEach((control) => control.addEventListener("input", apply));
    controls.forEach((control) => control.addEventListener("change", apply));
  });
}

function tableHeaderCells(table) {
  return [...table.querySelectorAll("thead tr:not(.filter-row) th")];
}

const TABLE_PREFS_PREFIX = "oceanTradingTablePrefs:v1";

function tableHeaderLabel(header, index) {
  return header.textContent.replace(/\s+/g, " ").trim() || `Column ${index + 1}`;
}

function tablePreferenceKey(table) {
  if (table.dataset.tablePrefsKey) return table.dataset.tablePrefsKey;
  const headers = tableHeaderCells(table).map((header, index) => tableHeaderLabel(header, index)).join("|");
  const previousMatchingTables = [...document.querySelectorAll("table")]
    .filter((candidate) => candidate !== table)
    .filter((candidate) => tableHeaderCells(candidate).map((header, index) => tableHeaderLabel(header, index)).join("|") === headers)
    .filter((candidate) => candidate.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING)
    .length;
  const key = [
    TABLE_PREFS_PREFIX,
    window.location.pathname || "/",
    headers || "table",
    previousMatchingTables,
  ].join("::");
  table.dataset.tablePrefsKey = key;
  return key;
}

function readTablePreferences(table) {
  try {
    return JSON.parse(window.localStorage.getItem(tablePreferenceKey(table)) || "{}") || {};
  } catch {
    return {};
  }
}

function writeTablePreferences(table, preferences) {
  window.localStorage.setItem(tablePreferenceKey(table), JSON.stringify(preferences));
}

function updateTablePreferences(table, updater) {
  const current = readTablePreferences(table);
  writeTablePreferences(table, updater(current));
}

function savedColumnVisibility(table, columnIndex) {
  const hidden = readTablePreferences(table).hiddenColumns || {};
  return hidden[String(columnIndex)] !== true;
}

function saveColumnVisibility(table, columnIndex, visible) {
  updateTablePreferences(table, (current) => {
    const hiddenColumns = { ...(current.hiddenColumns || {}) };
    if (visible) {
      delete hiddenColumns[String(columnIndex)];
    } else {
      hiddenColumns[String(columnIndex)] = true;
    }
    return { ...current, hiddenColumns };
  });
}

function saveColumnWidth(table, columnIndex, width) {
  updateTablePreferences(table, (current) => ({
    ...current,
    widths: {
      ...(current.widths || {}),
      [String(columnIndex)]: Math.max(70, Math.round(width)),
    },
  }));
}

function setColumnVisibility(table, columnIndex, visible, options = {}) {
  table.querySelectorAll("tr").forEach((row) => {
    const cell = row.children[columnIndex];
    if (cell) cell.hidden = !visible;
  });
  if (options.persist !== false) saveColumnVisibility(table, columnIndex, visible);
}

function setColumnWidth(table, columnIndex, width) {
  const nextWidth = Math.max(70, Math.round(width));
  table.querySelectorAll("tr").forEach((row) => {
    const cell = row.children[columnIndex];
    if (cell) {
      cell.style.width = `${nextWidth}px`;
      cell.style.minWidth = `${nextWidth}px`;
    }
  });
}

function applyColumnPreferences(table) {
  const preferences = readTablePreferences(table);
  const widths = preferences.widths || {};
  for (const [index, width] of Object.entries(widths)) {
    setColumnWidth(table, Number(index), Number(width));
  }
  const hiddenColumns = preferences.hiddenColumns || {};
  for (const [index, hidden] of Object.entries(hiddenColumns)) {
    if (hidden === true) setColumnVisibility(table, Number(index), false, { persist: false });
  }
}

function addColumnResizers(table) {
  const headers = tableHeaderCells(table);
  headers.forEach((header, index) => {
    if (header.querySelector(".column-resizer")) return;
    const handle = document.createElement("span");
    handle.className = "column-resizer";
    handle.setAttribute("aria-hidden", "true");
    header.appendChild(handle);
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startWidth = header.getBoundingClientRect().width;
      handle.setPointerCapture?.(event.pointerId);
      const move = (moveEvent) => {
        setColumnWidth(table, index, startWidth + moveEvent.clientX - startX);
      };
      const stop = () => {
        saveColumnWidth(table, index, header.getBoundingClientRect().width);
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", stop);
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", stop);
    });
  });
}

function createColumnToolbar(table) {
  const toolbar = document.createElement("div");
  toolbar.className = "table-toolbar";
  const details = document.createElement("details");
  details.className = "column-picker";
  const summary = document.createElement("summary");
  summary.textContent = "Columns";
  details.appendChild(summary);
  const options = document.createElement("div");
  options.className = "column-picker-options";
  tableHeaderCells(table).forEach((header, index) => {
    const labelText = header.textContent.replace(/\s+/g, " ").trim() || `Column ${index + 1}`;
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = savedColumnVisibility(table, index);
    checkbox.addEventListener("change", () => setColumnVisibility(table, index, checkbox.checked));
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(labelText));
    options.appendChild(label);
  });
  details.appendChild(options);
  toolbar.appendChild(details);
  const hint = document.createElement("span");
  hint.className = "table-toolbar-hint";
  hint.textContent = "Column widths and visibility are saved in this browser.";
  toolbar.appendChild(hint);
  return toolbar;
}

function enhanceTables(root = document) {
  root.querySelectorAll("table").forEach((table) => {
    if (table.dataset.enhanced === "true") return;
    table.dataset.enhanced = "true";
    table.classList.add("enhanced-table");
    tablePreferenceKey(table);
    applyColumnPreferences(table);
    addColumnResizers(table);

    const wrapper = document.createElement("div");
    wrapper.className = "table-scroll";
    table.parentNode.insertBefore(wrapper, table);
    wrapper.appendChild(table);

    const toolbar = createColumnToolbar(table);
    wrapper.parentNode.insertBefore(toolbar, wrapper);
  });
}

function bindPerformanceCalendars(manifest) {
  document.querySelectorAll("[data-performance-calendar]").forEach((calendar) => {
    if (calendar.dataset.bound === "true") return;
    calendar.dataset.bound = "true";
    const mode = calendar.dataset.mode;
    const trades = mode === "paper"
      ? manifest.tradingModes?.paper?.performanceClosedTrades || []
      : liveClosedTrades(manifest);
    const actualRows = mode === "live" ? manifest.tradingModes?.live?.profitReconciliation?.rows || [] : [];
    calendar.querySelectorAll("[data-period]").forEach((button) => {
      button.addEventListener("click", () => {
        calendar.querySelectorAll("[data-period]").forEach((item) => item.classList.toggle("active", item === button));
        const rows = summarizePeriodRows(trades, button.dataset.period || "daily", mode, actualRows);
        const target = calendar.querySelector("[data-calendar-table]");
        if (target) {
          target.innerHTML = renderPerformanceCalendarTable(rows, mode);
          bindTableFilters(target);
          enhanceTables(target);
        }
      });
    });
  });
}

function parseAutoTradeRows(text) {
  if (!text) return [];
  const rows = [];
  const pattern =
    /Auto-trade:\s+([^\s]+)\s+([^|]+)\|\s+([^|]+)\|\s+(BuyEntry|SellEntry|BuyExit|SellExit)\s+\|\s+Bar start date-time:\s+([^\n]+)/gi;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    rows.push({
      dateTime: match[5].trim(),
      symbol: match[1].trim(),
      chart: match[2].trim(),
      strategy: match[3].trim(),
      side: /sell/i.test(match[4]) ? "Short" : "Long",
      action: match[4],
      contracts: "n/a",
      entry: "n/a",
      exit: "n/a",
      stop: "n/a",
      target: "n/a",
      rMultiple: "n/a",
      pnl: "n/a",
      status: "Observed signal",
    });
  }
  return rows;
}

function paperClosedTrades(manifest) {
  const paper = manifest.tradingModes?.paper || {};
  const performanceTrades = paper.strategyClosedTrades?.length
    ? paper.strategyClosedTrades
    : paper.performanceClosedTrades || [];
  return performanceTrades.length ? performanceTrades : (paper.closedTrades || []);
}

function paperRealizedPnlSummary(paper) {
  const trades = paperClosedTrades({ tradingModes: { paper } });
  return pnlSummary(trades);
}

function buildLedgerRows(manifest) {
  const paper = manifest.tradingModes?.paper || {};
  const paperTrades = paperClosedTrades(manifest);
  if (paperTrades.length) {
    return paperTrades.map((trade) => ({
      dateTime: formatTradeTimestamp(trade.exitAtUtc || trade.tradeDateUtc),
      symbol: trade.symbol || "n/a",
      chart: "Sierra paper instance",
      strategy: trade.strategyName || "Paper strategy",
      side: trade.side || "n/a",
      action: "Closed paper trade",
      contracts: trade.quantity ?? "n/a",
      entry: trade.entryPrice ?? "n/a",
      exit: trade.exitPrice ?? "n/a",
      stop: "n/a",
      target: "n/a",
      rMultiple: trade.points ?? "n/a",
      pnl: formatCurrency(trade.realizedPnlDollars),
      status: trade.status || "Closed",
    }));
  }
  const latest = manifest.ledger?.latestLedger || manifest.ledger || {};
  const daily = manifest.dailyReport || {};
  const rows = parseAutoTradeRows(daily.textSnippet);
  if (rows.length) return rows;
  return [
    {
      dateTime: "2026-05-15 preflight",
      symbol: "MNQ/NQ",
      chart: "Sierra paper instance",
      strategy: latest.strategy || daily.strategy || "n/a",
      side: "n/a",
      action: latest.paperTradingPerformed === "yes" ? "Forward test" : "Preflight",
      contracts: "n/a",
      entry: "n/a",
      exit: "n/a",
      stop: "n/a",
      target: "n/a",
      rMultiple: latest.pnl || daily.realizedPnL || "n/a",
      pnl: latest.pnl || "n/a",
      status: latest.recommendation || "Awaiting completed trade rows",
    },
  ];
}

function paperLedgerSummary(manifest) {
  const paper = manifest.tradingModes?.paper || {};
  const closedTrades = paperClosedTrades(manifest);
  const importSummary = paper.importSummary || {};
  const importedAccounts = importSummary.accounts?.filter(Boolean) || [];
  const accountParts = [paper.account, ...importedAccounts].filter(Boolean);
  const account = [...new Set(accountParts)].join(" / ") || "Sim1";
  const pnl = paperRealizedPnlSummary(paper);
  const accountSize = paperAccountSizeSummary(paper);
  return {
    active: Boolean(closedTrades.length || importSummary.fillsImported),
    tradesObserved: closedTrades.length || importSummary.closedTrades || 0,
    fillsObserved: importSummary.fillsImported ?? closedTrades.reduce((sum, trade) => sum + (Number(trade.quantity) || 0), 0),
    missedSignals: 0,
    pnl,
    accountSize,
    latestTradeDate: importSummary.lastTradeDateUtc || closedTrades[closedTrades.length - 1]?.tradeDateUtc || null,
    account,
    symbol: paper.symbol || importSummary.symbols?.join(", ") || "n/a",
    sourceFile: paper.fullLedgerFile || "n/a",
  };
}

function renderTradeLogTable(rows) {
  return `
    <table class="trade-log">
      <thead>
        <tr>
          <th>Date / Time</th>
          <th>Symbol</th>
          <th>Strategy</th>
          <th>Side</th>
          <th>Action</th>
          <th>Contracts</th>
          <th>Entry</th>
          <th>Exit</th>
          <th>Stop</th>
          <th>Target</th>
          <th>R</th>
          <th>P&L</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (row) => `
              <tr>
                <td>${escapeHtml(row.dateTime)}</td>
                <td>${escapeHtml(row.symbol)}</td>
                <td>${escapeHtml(row.strategy)}</td>
                <td><span class="pill ${String(row.side).toLowerCase()}">${escapeHtml(row.side)}</span></td>
                <td>${escapeHtml(row.action)}</td>
                <td>${escapeHtml(row.contracts)}</td>
                <td>${escapeHtml(row.entry)}</td>
                <td>${escapeHtml(row.exit)}</td>
                <td>${escapeHtml(row.stop)}</td>
                <td>${escapeHtml(row.target)}</td>
                <td>${escapeHtml(row.rMultiple)}</td>
                <td>${escapeHtml(row.pnl)}</td>
                <td>${escapeHtml(row.status)}</td>
              </tr>
            `,
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function renderModeStrategyTable(strategies) {
  if (!strategies?.length) return '<p class="empty">No strategies assigned to this dashboard yet.</p>';
  return `
    <table data-filter-table>
      <thead>
        ${renderFilterRow(strategies, [
          { key: "name", label: "Strategy", type: "select" },
          { key: "sierraStudy", label: "Sierra Study", type: "select" },
          { key: "instrument", label: "Instrument", type: "select" },
          { key: "status", label: "Status", type: "select" },
          { key: "decision", label: "Decision", type: "select" },
          null,
          null,
          null,
          { key: "reason", label: "Reason", type: "search" },
        ])}
        <tr>
          <th>Strategy</th>
          <th>Sierra Study</th>
          <th>Instrument</th>
          <th>Status</th>
          <th>Decision</th>
          <th>Win rate</th>
          <th>Approval/backtest PnL</th>
          <th>Approval/backtest max DD</th>
          <th>Reason</th>
        </tr>
      </thead>
      <tbody>
        ${strategies
          .map(
            (strategy) => `
              <tr data-filter-row>
                <td>${escapeHtml(strategy.name)}</td>
                <td>${escapeHtml(strategy.sierraStudy || "n/a")}</td>
                <td>${escapeHtml(strategy.instrument || "n/a")}</td>
                <td>${escapeHtml(humanizeStatus(strategy.status))}</td>
                <td>${escapeHtml(humanizeStatus(strategy.decision))}</td>
                <td>${escapeHtml(formatPercent(strategy.winRate))}</td>
                <td>${escapeHtml(formatCurrency(strategy.netProfitDollars))}</td>
                <td>${escapeHtml(formatCurrency(strategy.maxDrawdownDollars))}</td>
                <td>${escapeHtml(strategy.reason || "n/a")}</td>
              </tr>
            `,
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function renderLiveTradeTable(trades) {
  if (!trades?.length) return '<p class="empty">No trade rows have been imported yet.</p>';
  return `
    <table class="trade-log" data-filter-table>
      <thead>
        ${renderFilterRow(trades, [
          { key: "tradeDateUtc", label: "Date", type: "select" },
          { key: "account", label: "Account", type: "select" },
          { key: "accountType", label: "Account Type", type: "select" },
          { key: "symbol", label: "Symbol", type: "select" },
          { key: "tradeSource", label: "Source", type: "select" },
          { key: "strategyName", label: "Strategy", type: "select" },
          { key: "side", label: "Side", type: "select" },
          null,
          null,
          null,
          null,
          null,
          null,
          null,
        ])}
        <tr>
          <th>Date UTC</th>
          <th>Account</th>
          <th>Account Type</th>
          <th>Symbol</th>
          <th>Source</th>
          <th>Strategy / Owner</th>
          <th>Side</th>
          <th>Qty</th>
          <th>Price</th>
          <th>Position Before</th>
          <th>Position After</th>
          <th>Realized P&L</th>
          <th>Order ID</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${trades
          .map(
            (trade) => `
              <tr data-filter-row>
                <td>${escapeHtml(trade.tradeDateUtc || "n/a")}</td>
                <td>${escapeHtml(trade.account || "n/a")}</td>
                <td>${escapeHtml(trade.accountType || "n/a")}</td>
                <td>${escapeHtml(trade.symbol || "n/a")}</td>
                <td><span class="pill ${trade.tradeSource === "manual" ? "warn" : "good"}">${escapeHtml(humanizeStatus(trade.tradeSource || "unknown"))}</span></td>
                <td>${escapeHtml(trade.strategyName || "Manual Trade")}</td>
                <td><span class="pill ${String(trade.side).toLowerCase()}">${escapeHtml(trade.side || "n/a")}</span></td>
                <td>${escapeHtml(trade.quantity || "n/a")}</td>
                <td>${escapeHtml(trade.price || "n/a")}</td>
                <td>${escapeHtml(trade.previousPosition ?? "n/a")}</td>
                <td>${escapeHtml(trade.positionAfter ?? "n/a")}</td>
                <td>${escapeHtml(formatCurrency(trade.realizedPnlDollars))}</td>
                <td>${escapeHtml(trade.internalOrderId || "n/a")}</td>
                <td>${escapeHtml(trade.status || "Imported")}</td>
              </tr>
            `,
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function renderLiveClosedTradeTable(trades) {
  if (!trades?.length) return '<p class="empty">No closed trades have been reconciled yet.</p>';
  return `
    <table class="trade-log" data-filter-table>
      <thead>
        ${renderFilterRow(trades, [
          { key: "tradeDateUtc", label: "Date", type: "select" },
          { key: "account", label: "Account", type: "select" },
          { key: "accountType", label: "Account Type", type: "select" },
          { key: "accountFamily", label: "Family", type: "select" },
          { key: "symbol", label: "Symbol", type: "select" },
          { key: "tradeSource", label: "Source", type: "select" },
          { key: "strategyName", label: "Strategy", type: "select" },
          { key: "side", label: "Side", type: "select" },
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          { key: "profitTreatment", label: "Treatment", type: "select" },
          null,
        ])}
        <tr>
          <th>Date UTC</th>
          <th>Account</th>
          <th>Account Type</th>
          <th>Family</th>
          <th>Symbol</th>
          <th>Source</th>
          <th>Strategy / Owner</th>
          <th>Side</th>
          <th>Qty</th>
          <th>Realized P&L</th>
          <th>Opened</th>
          <th>Closed</th>
          <th>Duration</th>
          <th>Entry</th>
          <th>Exit</th>
          <th>Points</th>
          <th>Treatment</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${trades
          .map(
            (trade) => `
              <tr data-filter-row>
                <td>${escapeHtml(trade.tradeDateUtc || "n/a")}</td>
                <td>${escapeHtml(trade.account || "n/a")}</td>
                <td>${escapeHtml(trade.accountType || "n/a")}</td>
                <td>${escapeHtml(trade.accountFamily || "n/a")}</td>
                <td>${escapeHtml(trade.symbol || "n/a")}</td>
                <td><span class="pill ${trade.tradeSource === "manual" ? "warn" : "good"}">${escapeHtml(humanizeStatus(trade.tradeSource || "unknown"))}</span></td>
                <td>${escapeHtml(trade.strategyName || "Manual Trade")}</td>
                <td><span class="pill ${String(trade.side).toLowerCase()}">${escapeHtml(trade.side || "n/a")}</span></td>
                <td>${escapeHtml(trade.quantity || "n/a")}</td>
                <td>${escapeHtml(formatCurrency(trade.realizedPnlDollars))}</td>
                <td>${escapeHtml(formatTradeTimestamp(trade.entryAtUtc || trade.openedAtUtc || trade.tradeDateUtc))}</td>
                <td>${escapeHtml(formatTradeTimestamp(trade.exitAtUtc || trade.closedAtUtc || trade.tradeDateUtc))}</td>
                <td>${escapeHtml(formatDurationMinutes(trade.durationMinutes) !== "n/a" ? formatDurationMinutes(trade.durationMinutes) : durationBetween(trade.entryAtUtc || trade.openedAtUtc, trade.exitAtUtc || trade.closedAtUtc))}</td>
                <td>${escapeHtml(trade.entryPrice ?? "n/a")}</td>
                <td>${escapeHtml(formatTradeExitDisplay(trade))}</td>
                <td>${escapeHtml(trade.points ?? "n/a")}</td>
                <td>${escapeHtml(humanizeStatus(trade.profitTreatment || "n/a"))}</td>
                <td>${escapeHtml(formatTradeStatusDisplay(trade))}</td>
              </tr>
            `,
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function renderOpenPositionTable(rows) {
  if (!rows?.length) return '<p class="empty">No open positions are currently detected.</p>';
  return `
    <table class="trade-log" data-filter-table>
      <thead>
        ${renderFilterRow(rows, [
          { key: "account", label: "Account", type: "select" },
          { key: "accountType", label: "Account Type", type: "select" },
          { key: "symbol", label: "Symbol", type: "select" },
          { key: "tradeSource", label: "Source", type: "select" },
          { key: "strategyName", label: "Strategy", type: "select" },
          { key: "side", label: "Side", type: "select" },
          null,
          null,
          null,
          null,
          null,
          null,
          null,
        ])}
        <tr>
          <th>Account</th>
          <th>Account Type</th>
          <th>Symbol</th>
          <th>Source</th>
          <th>Strategy / Owner</th>
          <th>Side</th>
          <th>Qty</th>
          <th>Avg Entry</th>
          <th>Latest Price</th>
          <th>Open P&L</th>
          <th>Opened</th>
          <th>Running Duration</th>
          <th>Last Update</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (row) => `
              <tr data-filter-row>
                <td>${escapeHtml(row.account || "n/a")}</td>
                <td>${escapeHtml(row.accountType || "n/a")}</td>
                <td>${escapeHtml(row.symbol || "n/a")}</td>
                <td><span class="pill ${row.tradeSource === "manual" ? "warn" : "good"}">${escapeHtml(humanizeStatus(row.tradeSource || "unknown"))}</span></td>
                <td>${escapeHtml(row.strategyName || "Manual Trade")}</td>
                <td><span class="pill ${String(row.side).toLowerCase()}">${escapeHtml(row.side || "n/a")}</span></td>
                <td>${escapeHtml(row.quantity || "n/a")}</td>
                <td>${escapeHtml(row.averageEntryPrice ?? "n/a")}</td>
                <td>${escapeHtml(row.latestPrice ?? "n/a")}</td>
                <td>${escapeHtml(formatCurrency(row.unrealizedPnlDollars))}</td>
                <td>${escapeHtml(formatTradeTimestamp(row.openedAtUtc))}</td>
                <td>${escapeHtml(runningDuration(row.openedAtUtc))}</td>
                <td>${escapeHtml(formatTradeTimestamp(row.lastUpdatedUtc))}</td>
                <td>${escapeHtml(row.status || "Open")}</td>
              </tr>
            `,
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function openPositionPhaseGroups(rows, data) {
  const context = createRuleContext({ propFirms: data.propFirms || {} });
  const groups = new Map([
    ["brokerage", { key: "brokerage", title: "Brokerage Open Trades", rows: [], pnl: 0 }],
    ["evaluation", { key: "evaluation", title: "Prop Evaluation Open Trades", rows: [], pnl: 0 }],
    ["funded", { key: "funded", title: "Prop Performance / Live Open Trades", rows: [], pnl: 0 }],
    ["practice", { key: "practice", title: "Practice / Excluded Open Trades", rows: [], pnl: 0 }],
    ["unassigned", { key: "unassigned", title: "Unassigned Open Trades", rows: [], pnl: 0 }],
  ]);
  for (const row of rows || []) {
    const classification = classifyTradeProfit(row, context);
    const group = groups.get(classification.key) || groups.get("unassigned");
    group.rows.push(row);
    group.pnl += Number(row.unrealizedPnlDollars) || 0;
  }
  return [...groups.values()].map((group) => ({
    ...group,
    pnl: Number(group.pnl.toFixed(2)),
  }));
}

function renderLiveOpenTradesByPhase(rows, data) {
  const groups = openPositionPhaseGroups(rows, data);
  const activeGroups = groups.filter((group) => group.rows.length);
  return `
    <h2>Live Open Trades by Account Phase</h2>
    <div class="tile-grid">
      ${groups.map((group) => summaryTile(group.title.replace(" Open Trades", ""), `${group.rows.length} / ${formatCurrency(group.pnl)}`, group.key === "unassigned" ? "warn" : "neutral")).join("")}
    </div>
    ${
      activeGroups.length
        ? activeGroups.map((group) => `
          <h3>${escapeHtml(group.title)}</h3>
          ${renderOpenPositionTable(group.rows)}
        `).join("")
        : '<p class="empty">No live open positions are currently detected.</p>'
    }
  `;
}

function renderOpenTradesPage(data) {
  const liveOpen = data.live?.openPositions || [];
  const paperOpen = data.paper?.openPositions || [];
  const liveClosed = data.live?.todayClosedTrades || [];
  const paperClosed = data.paper?.todayClosedTrades || [];
  const openPnl = [...liveOpen, ...paperOpen].reduce((sum, row) => sum + (Number(row.unrealizedPnlDollars) || 0), 0);
  const liveTrue = liveTrueProfitSummary(data.live || {});
  const liveGrossClosedPnl = liveClosed.reduce((sum, row) => sum + (Number(row.realizedPnlDollars) || 0), 0);
  const paperClosedPnl = paperClosed.reduce((sum, row) => sum + (Number(row.realizedPnlDollars) || 0), 0);
  const liveActualClosedPnl = liveTrue.value ?? liveGrossClosedPnl;
  const paperAccount = paperAccountSizeSummary(data.paper || {});
  const paperPnl = paperRealizedPnlSummary(data.paper || {});
  const monitor = data.monitor || {};
  const liveDtc = data.live?.dtcSnapshot;
  const paperDtc = data.paper?.dtcSnapshot;
  const dtcLabel = (snapshot) => {
    const status = humanizeStatus(snapshot?.status || "not_run");
    return snapshot?.available ? status : `${status} - log monitor active`;
  };
  return `
    <div class="journal-toolbar">
      <span>Monitor: ${escapeHtml(humanizeStatus(monitor.status || "unknown"))}</span>
      <span>Last scan: ${escapeHtml(monitor.lastScanAtUtc || "n/a")}</span>
      <span>Last import: ${escapeHtml(monitor.lastImportAtUtc || "n/a")}</span>
      <span>Live DTC snapshot: ${escapeHtml(dtcLabel(liveDtc))}</span>
      <span>Paper DTC snapshot: ${escapeHtml(dtcLabel(paperDtc))}</span>
    </div>
    <section class="panel monitor-activity-panel">
      ${renderMonitorActivity(monitor)}
    </section>
    <div class="tile-grid">
      ${summaryTile("Live open trades", liveOpen.length)}
      ${summaryTile("Paper open trades", paperOpen.length)}
      ${summaryTile("Open P&L", formatCurrency(openPnl), openPnl < 0 ? "warn" : "good")}
      ${summaryTile("Paper account value", paperAccount.accountSizeDollars === null ? "n/a" : formatCurrency(paperAccount.accountSizeDollars), paperAccount.accountSizeDollars < 0 ? "warn" : "good")}
      ${summaryTile("Paper realised P&L", formatCurrency(paperPnl.net), paperPnl.net < 0 ? "warn" : "good")}
      ${summaryTile("Sierra balance P&L", paperAccount.dailyPnlDollars === null ? "n/a" : formatCurrency(paperAccount.dailyPnlDollars), paperAccount.dailyPnlDollars < 0 ? "warn" : "good")}
      ${summaryTile("Today live true P&L", formatCurrency(liveActualClosedPnl), liveActualClosedPnl < 0 ? "warn" : "good")}
      ${summaryTile("Today raw live P&L", formatCurrency(liveGrossClosedPnl), "warn")}
      ${summaryTile("Today paper closed-trade P&L", formatCurrency(paperClosedPnl), paperClosedPnl < 0 ? "warn" : "neutral")}
      ${summaryTile("True Profit source", trueProfitSourceLabel(liveTrue.source), liveTrue.hasActual ? "good" : "warn")}
      ${summaryTile("Today live closed", liveClosed.length)}
      ${summaryTile("Today paper closed", paperClosed.length)}
    </div>
    ${renderLiveOpenTradesByPhase(liveOpen, data)}
    <h2>Paper Open Trades</h2>
    ${renderOpenPositionTable(paperOpen)}
    <h2>Today Live Closed Trades</h2>
    ${renderLiveClosedTradeTable(liveClosed)}
    <h2>Today Paper Closed Trades</h2>
    ${renderLiveClosedTradeTable(paperClosed)}
  `;
}

function ruleSetLabel(ruleSets, id) {
  const rule = (ruleSets || []).find((item) => item.id === id);
  return rule ? rule.label || rule.id : id || "Unassigned";
}

function renderRuleSetTable(ruleSets) {
  if (!ruleSets?.length) return '<p class="empty">No prop firm rule sets have been configured yet.</p>';
  return `
    <table data-filter-table>
      <thead>
        ${renderFilterRow(ruleSets, [
          { key: "provider", label: "Provider", type: "select" },
          { key: "program", label: "Program", type: "select" },
          { key: "phase", label: "Phase", type: "select" },
          null,
          null,
          null,
          null,
          null,
        ])}
        <tr>
          <th>Rule Set</th>
          <th>Provider</th>
          <th>Program</th>
          <th>Phase</th>
          <th>Profit Target</th>
          <th>Daily Loss</th>
          <th>Max Loss</th>
          <th>Consistency</th>
        </tr>
      </thead>
      <tbody>
        ${ruleSets.map((rule) => `
          <tr data-filter-row>
            <td>${escapeHtml(rule.label || rule.id)}</td>
            <td>${escapeHtml(rule.provider || "n/a")}</td>
            <td>${escapeHtml(rule.program || "n/a")}</td>
            <td>${escapeHtml(humanizeStatus(rule.phase || "n/a"))}</td>
            <td>${escapeHtml(formatCurrency(rule.profitTargetDollars))}</td>
            <td>${escapeHtml(rule.dailyLossLimitDollars === null || rule.dailyLossLimitDollars === undefined ? rule.dailyLossLimitDescription || "None" : formatCurrency(rule.dailyLossLimitDollars))}</td>
            <td>${escapeHtml(formatCurrency(rule.maxLossLimitDollars))}</td>
            <td>${escapeHtml(rule.consistency?.enabled ? `${Math.round(Number(rule.consistency.maxPercent || 0) * 100)}% max` : "None")}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function renderPropFirmAccountsTable(accounts, ruleSets) {
  if (!accounts?.length) return '<p class="empty">No trading accounts have been imported yet.</p>';
  return `
    <table data-filter-table>
      <thead>
        ${renderFilterRow(accounts, [
          { key: "account", label: "Account", type: "search" },
          { key: "provider", label: "Provider", type: "select" },
          { key: "phase", label: "Phase", type: "select" },
          { key: "status", label: "Status", type: "select" },
          null,
          null,
          null,
          null,
        ])}
        <tr>
          <th>Account</th>
          <th>Provider</th>
          <th>Phase</th>
          <th>Status</th>
          <th>Rule Set</th>
          <th>Modes</th>
          <th>Imported Rows</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
        ${accounts.map((account) => {
          const canConfirm = account.suggestedRuleSetId && !account.confirmed;
          return `
            <tr data-filter-row>
              <td>${escapeHtml(account.account)}</td>
              <td>${escapeHtml(account.provider || "Unknown")}</td>
              <td>${escapeHtml(humanizeStatus(account.phase || "unassigned"))}</td>
              <td><span class="pill ${account.confirmed ? "good" : "warn"}">${escapeHtml(humanizeStatus(account.status || "unassigned"))}</span></td>
              <td>${escapeHtml(ruleSetLabel(ruleSets, account.ruleSetId))}</td>
              <td>${escapeHtml((account.modes || []).join(", ") || "n/a")}</td>
              <td>${escapeHtml(account.tradeCount || 0)}</td>
              <td>${
                canConfirm
                  ? `<button class="button-link" type="button" data-confirm-rule-account="${escapeHtml(account.account)}" data-rule-set-id="${escapeHtml(account.suggestedRuleSetId)}" data-provider="${escapeHtml(account.provider || "")}" data-phase="${escapeHtml(account.phase || "")}">Confirm</button>`
                  : account.confirmed
                    ? `Confirmed ${escapeHtml(account.confirmedAtUtc || "")}`
                    : "Needs manual assignment"
              }</td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;
}

function renderPropFirmRulesPage(manifest) {
  const propFirms = manifest.propFirms || {};
  const ruleSets = propFirms.ruleSets || [];
  const accounts = propFirms.accounts || [];
  const needsReview = accounts.filter((account) => account.status === "needs_review").length;
  const confirmed = accounts.filter((account) => account.confirmed).length;
  return `
    <div class="tile-grid">
      ${summaryTile("Rule sets", ruleSets.length)}
      ${summaryTile("Accounts detected", accounts.length)}
      ${summaryTile("Needs review", needsReview, needsReview ? "warn" : "good")}
      ${summaryTile("Confirmed", confirmed, confirmed ? "good" : "neutral")}
    </div>
    <h2>Configured Rule Sets</h2>
    ${renderRuleSetTable(ruleSets)}
    <h2>Trading Account Links</h2>
    <p>Suggested matches are detected from account naming patterns. Confirm a match once and future imports will use that rule set automatically.</p>
    ${renderPropFirmAccountsTable(accounts, ruleSets)}
    ${keyValueTable([
      ["Rule-set file", propFirms.files?.ruleSets || "n/a"],
      ["Account assignment file", propFirms.files?.accounts || "n/a"],
    ])}
  `;
}

function bindPropFirmRuleActions() {
  document.querySelectorAll("[data-confirm-rule-account]").forEach((button) => {
    if (button.dataset.bound === "true") return;
    button.dataset.bound = "true";
    button.addEventListener("click", async () => {
      button.disabled = true;
      button.textContent = "Confirming...";
      try {
        const response = await fetch("/api/prop-firm-account-assignment", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            account: button.dataset.confirmRuleAccount,
            ruleSetId: button.dataset.ruleSetId,
            provider: button.dataset.provider,
            phase: button.dataset.phase,
            status: "active",
          }),
        });
        if (!response.ok) throw new Error(await response.text());
        window.location.reload();
      } catch (error) {
        button.disabled = false;
        button.textContent = "Confirm";
        alert(`Could not confirm rule set: ${String(error.message || error)}`);
      }
    });
  });
}

function pnlSummary(trades) {
  const values = (trades || [])
    .map((trade) => Number(trade.realizedPnlDollars))
    .filter((value) => Number.isFinite(value));
  const net = values.reduce((sum, value) => sum + value, 0);
  const wins = values.filter((value) => value > 0).length;
  const losses = values.filter((value) => value < 0).length;
  const average = values.length ? net / values.length : null;
  return { net, wins, losses, average, count: values.length };
}

function trueProfitSourceLabel(source) {
  if (source === "trade_account_monitor") return "Account monitor";
  if (source === "account_balance_delta") return "Account balance";
  if (source === "closed_fill_pnl") return "Closed fills";
  if (source === "mixed") return "Mixed sources";
  if (source === "no_closed_trades") return "No trades";
  return humanizeStatus(source || "n/a");
}

function liveTrueProfitSummary(live) {
  const reconciliation = live?.profitReconciliation || {};
  const sources = [...new Set((reconciliation.rows || []).map((row) => row.trueProfitSource).filter(Boolean))];
  const source = sources.length > 1
    ? "mixed"
    : sources[0] || (reconciliation.hasTradeAccountMonitor
      ? "trade_account_monitor"
      : reconciliation.hasAccountBalanceDelta
        ? "account_balance_delta"
        : "closed_fill_pnl");
  return {
    value: Number.isFinite(Number(reconciliation.totalTrueProfitDollars)) ? Number(reconciliation.totalTrueProfitDollars) : null,
    source,
    hasActual: Boolean(reconciliation.hasTradeAccountMonitor || reconciliation.hasAccountBalanceDelta),
    rows: reconciliation.rows || [],
  };
}

function createRuleContext(manifest) {
  const ruleSets = new Map((manifest.propFirms?.ruleSets || []).map((rule) => [rule.id, rule]));
  const accounts = new Map((manifest.propFirms?.accounts || []).map((account) => [account.account, account]));
  return { ruleSets, accounts };
}

function classifyTradeProfit(trade, context) {
  const account = context?.accounts?.get(trade.account);
  const rule = account?.ruleSetId ? context.ruleSets.get(account.ruleSetId) : null;
  const treatment = trade.profitTreatment || "";
  const accountType = trade.accountType || account?.accountType || "";
  if (treatment === "real_account_pnl" || accountType === "Brokerage") {
    return { key: "brokerage", label: "Brokerage P&L", withdrawable: true, phase: "Brokerage", rule };
  }
  if (treatment === "qualification_cycle" || account?.phase === "evaluation" || accountType.includes("Evaluation")) {
    return { key: "evaluation", label: "Evaluation Progress", withdrawable: false, phase: "Evaluation", rule };
  }
  if (treatment === "funded_cycle" || accountType.includes("Funded")) {
    return { key: "funded", label: "Performance / Funded P&L", withdrawable: false, phase: "Performance / Funded", rule };
  }
  if (treatment === "excluded_practice" || accountType === "Practice") {
    return { key: "practice", label: "Practice / Excluded", withdrawable: false, phase: "Practice", rule };
  }
  return { key: "unassigned", label: "Unassigned / Needs Review", withdrawable: false, phase: "Unassigned", rule };
}

function buildPhasePnlSummary(trades, manifest) {
  const context = createRuleContext(manifest);
  const trueProfitByAccount = new Map((manifest.tradingModes?.live?.profitReconciliation?.rows || []).map((row) => [row.account, row]));
  const buckets = new Map([
    ["withdrawable", { key: "withdrawable", label: "Active Real / Withdrawable P&L", net: 0, trades: 0 }],
    ["brokerage", { key: "brokerage", label: "Brokerage P&L", net: 0, trades: 0 }],
    ["evaluation", { key: "evaluation", label: "Evaluation Progress", net: 0, trades: 0 }],
    ["funded", { key: "funded", label: "Performance / Funded P&L", net: 0, trades: 0 }],
    ["forfeited", { key: "forfeited", label: "Failed / Forfeited History", net: 0, trades: 0 }],
    ["practice", { key: "practice", label: "Practice / Excluded", net: 0, trades: 0 }],
    ["unassigned", { key: "unassigned", label: "Unassigned / Needs Review", net: 0, trades: 0 }],
  ]);
  const accounts = new Map();
  for (const trade of trades || []) {
    const pnl = Number(trade.realizedPnlDollars);
    if (!Number.isFinite(pnl)) continue;
    const classification = classifyTradeProfit(trade, context);
    const ruleMaxLoss = classification.rule?.maxLossLimitDollars;
    const maxLossLimit = Number.isFinite(Number(ruleMaxLoss)) ? Number(ruleMaxLoss) : classification.key.startsWith("evaluation") || classification.key === "funded" ? 2000 : null;
    const accountKey = trade.account || "unknown";
    const accountRow = accounts.get(accountKey) || {
      account: accountKey,
      accountType: trade.accountType || "n/a",
      accountFamily: trade.accountFamily || "n/a",
      phase: classification.phase,
      category: classification.key,
      ruleSet: classification.rule?.label || "n/a",
      latestTradeDate: trade.exitAtUtc || trade.closedAtUtc || trade.tradeDateUtc || null,
      trades: 0,
      net: 0,
      wins: 0,
      losses: 0,
      equityHigh: 0,
      maxDrawdown: 0,
      maxLossLimit,
      breached: false,
    };
    accountRow.trades += 1;
    if (rowRecencyValue(trade) > rowRecencyValue(accountRow)) {
      accountRow.latestTradeDate = trade.exitAtUtc || trade.closedAtUtc || trade.tradeDateUtc || accountRow.latestTradeDate;
    }
    accountRow.net += pnl;
    if (pnl > 0) accountRow.wins += 1;
    if (pnl < 0) accountRow.losses += 1;
    accountRow.equityHigh = Math.max(accountRow.equityHigh, accountRow.net);
    accountRow.maxDrawdown = Math.max(accountRow.maxDrawdown, accountRow.equityHigh - accountRow.net);
    if (accountRow.maxLossLimit !== null && accountRow.maxDrawdown >= accountRow.maxLossLimit) accountRow.breached = true;
    accounts.set(accountKey, accountRow);
  }

  for (const account of accounts.values()) {
    const trueProfit = trueProfitByAccount.get(account.account);
    const accountTrades = (trades || []).filter((trade) => trade.account === account.account);
    const accountTradeDates = [...new Set(accountTrades.map((trade) => String(trade.exitAtUtc || trade.closedAtUtc || trade.tradeDateUtc || "").slice(0, 10)).filter(Boolean))];
    const canUseTrueProfit =
      trueProfit &&
      Number.isFinite(Number(trueProfit.trueProfitDollars)) &&
      (
        trueProfit.trueProfitSource !== "trade_account_monitor" ||
        (accountTradeDates.length <= 1 && accountTradeDates[0] === String(trueProfit.balanceAsOfUtc || "").slice(0, 10))
      );
    if (canUseTrueProfit) {
      account.grossFillNet = account.net;
      account.net = Number(trueProfit.trueProfitDollars);
      account.trueProfitSource = trueProfit.trueProfitSource;
      account.trueProfitSourceDetail = trueProfit.trueProfitSourceDetail;
    } else if (trueProfit?.trueProfitSource === "trade_account_monitor") {
      account.trueProfitSource = "closed_fill_pnl";
      account.trueProfitSourceDetail = "Using cumulative closed-fill P&L because the Sierra Trade Account Monitor daily P/L only covers one account day.";
    }
    const targetKey = account.breached && ["evaluation", "funded"].includes(account.category) ? "forfeited" : account.category;
    const bucket = buckets.get(targetKey) || buckets.get("unassigned");
    bucket.net += account.net;
    bucket.trades += account.trades;
    if (account.category === "brokerage" && !account.breached) {
      const withdrawable = buckets.get("withdrawable");
      withdrawable.net += account.net;
      withdrawable.trades += account.trades;
    }
  }

  return {
    buckets: [...buckets.values()].map((bucket) => ({
      ...bucket,
      net: Number(bucket.net.toFixed(2)),
    })),
    accounts: [...accounts.values()]
      .map((account) => ({
        ...account,
        net: Number(account.net.toFixed(2)),
        maxDrawdown: Number(account.maxDrawdown.toFixed(2)),
        winRate: account.trades ? account.wins / account.trades : null,
        ruleStatus: account.breached ? "Failed / breached" : "Within imported limits",
      }))
      .sort((a, b) => rowRecencyValue(b) - rowRecencyValue(a) || a.category.localeCompare(b.category) || a.account.localeCompare(b.account)),
  };
}

function renderPhasePnlTiles(phaseSummary) {
  const byKey = new Map(phaseSummary.buckets.map((bucket) => [bucket.key, bucket]));
  const tile = (key, tone = "neutral") => {
    const bucket = byKey.get(key) || { label: key, net: 0, trades: 0 };
    return summaryTile(bucket.label, `${formatCurrency(bucket.net)} (${bucket.trades} trades)`, tone);
  };
  return `
    <div class="tile-grid">
      ${tile("withdrawable", "good")}
      ${tile("brokerage", "good")}
      ${tile("evaluation", "neutral")}
      ${tile("funded", "neutral")}
      ${tile("forfeited", "warn")}
      ${tile("unassigned", "warn")}
    </div>
  `;
}

function renderAccountPhaseTable(accounts) {
  if (!accounts?.length) return '<p class="empty">No account phase performance has been calculated yet.</p>';
  return `
    <table data-filter-table>
      <thead>
        ${renderFilterRow(accounts, [
          { key: "account", label: "Account", type: "select", sort: "recent" },
          { key: "phase", label: "Phase", type: "select" },
          { key: "category", label: "Category", type: "select" },
          { key: "accountFamily", label: "Family", type: "select" },
          null,
          null,
          null,
          null,
          null,
          { key: "ruleStatus", label: "Rule Status", type: "select" },
        ])}
        <tr>
          <th>Account</th>
          <th>Phase</th>
          <th>Category</th>
          <th>Family</th>
          <th>Trades</th>
          <th>Most Recent Trade</th>
          <th>Net P&L</th>
          <th>Source</th>
          <th>Max Drawdown</th>
          <th>Rule Status</th>
        </tr>
      </thead>
      <tbody>
        ${accounts.map((account) => `
          <tr data-filter-row>
            <td>${escapeHtml(account.account)}</td>
            <td>${escapeHtml(account.phase)}</td>
            <td>${escapeHtml(humanizeStatus(account.category))}</td>
            <td>${escapeHtml(account.accountFamily)}</td>
            <td>${escapeHtml(account.trades)}</td>
            <td>${escapeHtml(account.latestTradeDate || "n/a")}</td>
            <td>${escapeHtml(formatCurrency(account.net))}</td>
            <td title="${escapeHtml(account.trueProfitSourceDetail || "")}">${escapeHtml(trueProfitSourceLabel(account.trueProfitSource || "closed_fill_pnl"))}</td>
            <td>${escapeHtml(formatCurrency(account.maxDrawdown))}</td>
            <td><span class="pill ${account.breached ? "warn" : "good"}">${escapeHtml(account.ruleStatus)}</span></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function paperAccountSizeSummary(paper) {
  const rows = paper.accountMonitor?.rows || [];
  const currentAccount = paper.account || "Sim1";
  const preferred = rows.find((row) => String(row.account || "").toLowerCase() === currentAccount.toLowerCase()) || null;
  const dailyNetProfitLoss = Number(paper.dailyNetProfitLossDollars);
  const rawAccountSize = preferred?.accountValueDollars ?? preferred?.currentCashBalanceDollars;
  const accountSize = Number(rawAccountSize);
  const hasAccountSize = rawAccountSize !== null && rawAccountSize !== undefined && Number.isFinite(accountSize);
  const preferredDailyNet = Number(preferred?.dailyNetProfitLossDollars);
  const preferredDailyGross = Number(preferred?.dailyProfitLossDollars);
  const preferredCash = preferred?.currentCashBalanceDollars;
  const preferredAvailable = preferred?.availableFundsForNewPositionsDollars;
  const preferredOpenPnl = preferred?.openPositionsProfitLossDollars;
  return {
    account: preferred?.account || currentAccount,
    accountSizeDollars: hasAccountSize ? accountSize : null,
    accountValueLabel: hasAccountSize ? "Sierra simulation account value" : "Actual Sim1 account value unavailable",
    accountValueSource: hasAccountSize ? "sierra_account_monitor" : "unavailable",
    cashBalanceDollars: preferredCash !== null && preferredCash !== undefined && Number.isFinite(Number(preferredCash)) ? Number(preferredCash) : null,
    availableFundsDollars: preferredAvailable !== null && preferredAvailable !== undefined && Number.isFinite(Number(preferredAvailable)) ? Number(preferredAvailable) : null,
    openPnlDollars: preferredOpenPnl !== null && preferredOpenPnl !== undefined && Number.isFinite(Number(preferredOpenPnl)) ? Number(preferredOpenPnl) : null,
    dailyPnlDollars: Number.isFinite(preferredDailyNet)
      ? preferredDailyNet
      : Number.isFinite(preferredDailyGross)
        ? preferredDailyGross
      : Number.isFinite(dailyNetProfitLoss)
        ? Number(dailyNetProfitLoss.toFixed(2))
        : null,
    sourceFile: preferred?.sourceFile || paper.dailyNetProfitLossSourceFile || paper.fullLedgerFile || null,
    updatedAtUtc: preferred?.updatedAtUtc || paper.dailyNetProfitLossDateUtc || null,
    warning: preferred
      ? null
      : paper.accountMonitor?.warning || (Number.isFinite(dailyNetProfitLoss)
        ? `No Sierra account snapshot row is available for ${currentAccount}; the paper dashboard uses the paper telemetry SQLite ledger and does not infer account value from fills.`
        : `No Sierra account monitor row is available for ${currentAccount}; closed-fill P&L is shown separately and is not used as account value.`),
  };
}

function renderPaperReconciliation(reconciliation) {
  if (!reconciliation) return '<p class="empty">No paper reconciliation has been generated yet.</p>';
  const missed = reconciliation.missedTrades || {};
  const rows = reconciliation.strategyRows || [];
  return `
    <div class="tile-grid">
      ${summaryTile("Missed trades detected", missed.detectedMissedTrades ?? 0, missed.detectedMissedTrades ? "warn" : "good")}
      ${summaryTile("Missed signals detected", missed.detectedMissedSignals ?? 0, missed.detectedMissedSignals ? "warn" : "good")}
      ${summaryTile("Open paper positions", missed.evidence?.dtcOpenPositions ?? 0, missed.evidence?.dtcOpenPositions ? "warn" : "good")}
      ${summaryTile("Account value", reconciliation.accountValueAvailable ? "Available" : "Unavailable", reconciliation.accountValueAvailable ? "good" : "warn")}
    </div>
    ${keyValueTable([
      ["Window start UTC", missed.windowStartUtc || "n/a"],
      ["Window end UTC", missed.windowEndUtc || "n/a"],
      ["Status", missed.status || "n/a"],
      ["Limitation", missed.limitation || "n/a"],
      ["Potential strategy", reconciliation.potentialStrategy?.strategy || "n/a"],
      ["Potential strategy note", reconciliation.potentialStrategy?.recommendation || "n/a"],
      ["Report file", reconciliation.reportFile || "n/a"],
    ])}
    ${rows.length ? renderGenericTable(rows.map((row) => ({
      Strategy: row.strategy,
      Trades: row.trades,
      Wins: row.wins,
      Losses: row.losses,
      "Win rate": row.winRate === null ? "n/a" : formatPercent(row.winRate),
      "Net P&L": formatCurrency(row.netProfitDollars),
      Points: Number(row.points || 0).toFixed(2),
      Recommendation: row.recommendation,
    }))) : '<p class="empty">No paper strategy rows are available.</p>'}
  `;
}

function renderPaperDashboard(paper) {
  const hygiene = paper.dataHygiene || {};
  const summary = paper.importSummary || {};
  const performanceClosedTrades = paperClosedTrades({ tradingModes: { paper } });
  const paperDailyNetProfitLoss = Number(paper.dailyNetProfitLossDollars);
  const paperCalendarActualRows = !performanceClosedTrades.length && Number.isFinite(paperDailyNetProfitLoss)
    ? [{
        account: paper.account || "Sim1",
        trueProfitDollars: Number(paperDailyNetProfitLoss.toFixed(2)),
        trueProfitSource: "sierra_daily_net_profit_loss",
        balanceAsOfUtc: paper.dailyNetProfitLossDateUtc || paper.importSummary?.lastTradeDateUtc || null,
      }]
    : [];
  const pnl = paperRealizedPnlSummary(paper);
  const accountSize = paperAccountSizeSummary(paper);
  const separation = paper.separation || {};
  const otherPaper = separation.otherStrategies || {};
  const manualPaper = separation.manual || {};
  return `
    <div class="journal-toolbar">
      <span>Account: ${escapeHtml(paper.account || "Sim1")}</span>
      <span>Symbol: ${escapeHtml(paper.symbol || "MNQM6.CME")}</span>
      <span>DTC: ${escapeHtml(paper.dataPort || "n/a")} / ${escapeHtml(paper.tradingPort || "n/a")}</span>
      <span>Status: ${escapeHtml(humanizeStatus(paper.status))}</span>
    </div>
    <div class="tile-grid">
      ${summaryTile("Mode", "Paper / Simulation", "good")}
      ${summaryTile("Active symbol", paper.symbol || "n/a")}
      ${summaryTile("Strategies", paper.strategies?.length || 0)}
      ${summaryTile("Instance", paper.instanceRoot || "n/a")}
      ${summaryTile("Paper account value", accountSize.accountSizeDollars === null ? "n/a" : formatCurrency(accountSize.accountSizeDollars), accountSize.accountSizeDollars < 0 ? "warn" : "good")}
      ${summaryTile("Paper cash balance", accountSize.cashBalanceDollars === null ? "n/a" : formatCurrency(accountSize.cashBalanceDollars))}
      ${summaryTile("Paper realised P&L", formatCurrency(pnl.net), pnl.net < 0 ? "warn" : "good")}
      ${summaryTile("Sierra balance P&L", accountSize.dailyPnlDollars === null ? "n/a" : formatCurrency(accountSize.dailyPnlDollars), accountSize.dailyPnlDollars < 0 ? "warn" : "good")}
      ${summaryTile("Closed trades", performanceClosedTrades.length || summary.closedTrades || pnl.count)}
      ${summaryTile("Win / loss", `${pnl.wins} / ${pnl.losses}`)}
      ${summaryTile("Other paper strategy fills", otherPaper.trades?.length || 0, otherPaper.trades?.length ? "warn" : "good")}
      ${summaryTile("Manual paper fills", manualPaper.trades?.length || 0, manualPaper.trades?.length ? "warn" : "good")}
    </div>
    <h2>Paper Account Size Source</h2>
    ${keyValueTable([
      ["Account monitor account", accountSize.account],
      ["Displayed paper value", accountSize.accountValueLabel],
      ["Displayed value source", accountSize.accountValueSource],
      ["Account monitor updated", accountSize.updatedAtUtc || "n/a"],
      ["Account monitor source", accountSize.sourceFile || "n/a"],
      ["Account monitor warning", accountSize.warning || "none"],
      ["Paper realised P&L", formatCurrency(pnl.net)],
      ["Closed-trade audit note", "Realised P&L is calculated from closed paper telemetry SQLite trades. Account-level daily P&L is read from the paper telemetry account_snapshot table when available; missing balance fields are not inferred from fills."],
    ])}
    <h2>Paper Trade Reconciliation</h2>
    ${renderPaperReconciliation(paper.reconciliation)}
    ${renderPerformanceCalendar("paper-dashboard-calendar", performanceClosedTrades, "paper", paperCalendarActualRows)}
    ${otherPaper.rows?.length ? `
      <h2>Other Paper Strategy Activity</h2>
      <p>Connector-attributed paper strategy activity that is not part of the approved paper bundle is isolated here and does not change the approved-bundle totals above.</p>
      ${createPaperPerformanceTable(otherPaper.rows)}
      <h3>Other Paper Closed Trades</h3>
      ${renderLiveClosedTradeTable(otherPaper.closedTrades || [])}
      <h3>Other Paper Fill Rows</h3>
      ${renderLiveTradeTable(otherPaper.trades || [])}
    ` : ""}
    ${manualPaper.trades?.length || manualPaper.openPositions?.length ? `
      <h2>Manual Paper Activity</h2>
      <p>Any remaining paper rows that the connector still cannot tie to a Sierra strategy stay in this manual bucket.</p>
      ${manualPaper.openPositions?.length ? renderOpenPositionTable(manualPaper.openPositions) : '<p class="empty">No manual paper open positions.</p>'}
      ${manualPaper.closedTrades?.length ? renderLiveClosedTradeTable(manualPaper.closedTrades) : '<p class="empty">No manual paper closed trades.</p>'}
    ` : ""}
    <h2>Closed Paper Trade Audit</h2>
    <p>Derived from the paper telemetry SQLite trades table only. This is not the simulation account balance.</p>
    ${renderLiveClosedTradeTable(paper.closedTrades || [])}
    <h2>Imported Paper Fill Rows</h2>
    <p>Recent paper trade rows from the paper telemetry SQLite ledger.</p>
    ${renderLiveTradeTable(paper.trades || [])}
    <h2>Paper Strategies</h2>
    ${renderModeStrategyTable(paper.strategies || [])}
    <h2>Paper Trading Notes</h2>
    ${bulletList((paper.summary ? [paper.summary] : []).concat(extractBullets(paper.statusSnippet, "Current Instrument Override", 8)))}
    <h2>Data Hygiene</h2>
    <div class="tile-grid">
      ${summaryTile("Archived manual logs", hygiene.archivedCopiedManualLogCount ?? 0, "good")}
      ${summaryTile("Active copied/manual logs", hygiene.activeCopiedManualLogCount ?? 0, hygiene.activeCopiedManualLogCount ? "warn" : "good")}
      ${summaryTile("SQLite source", hygiene.paperSqliteExists ? "Available" : "Missing", hygiene.paperSqliteExists ? "good" : "warn")}
      ${summaryTile("Policy", "SQLite only")}
    </div>
    ${keyValueTable([
      ["PATrading paper telemetry SQLite DB", hygiene.paperSqliteFile || "n/a"],
      ["SQLite size", hygiene.paperSqliteSizeBytes === null || hygiene.paperSqliteSizeBytes === undefined ? "n/a" : `${hygiene.paperSqliteSizeBytes} bytes`],
      ["Hygiene report", hygiene.artifactPath || "n/a"],
    ])}
  `;
}

function renderLucidRiskProfile(rules) {
  if (!rules) return '<p class="empty">No Lucid risk profile has been configured.</p>';
  return `
    <div class="tile-grid">
      ${summaryTile("Profile", rules.profileName || "Lucid Flex 50K", "good")}
      ${summaryTile("Eval target", formatCurrency(rules.evaluation?.profitTargetDollars))}
      ${summaryTile("Eval MLL", formatCurrency(rules.evaluation?.maxLossLimitDollars), "warn")}
      ${summaryTile("Eval consistency", `${Number((rules.evaluation?.consistencyMaxPercent || 0) * 100).toFixed(0)}% max`)}
      ${summaryTile("Live drawdown", formatCurrency(rules.live?.startingLiveDrawdownDollars), "warn")}
      ${summaryTile("Live max size", rules.live?.maxLiveContracts || "n/a")}
    </div>
    <div class="two-column">
      <section>
        <h3>Evaluation Guardrails</h3>
        ${keyValueTable([
          ["Profit target", formatCurrency(rules.evaluation?.profitTargetDollars)],
          ["Max loss limit", formatCurrency(rules.evaluation?.maxLossLimitDollars)],
          ["Largest day guide", `${formatCurrency(rules.evaluation?.largestDayAtTargetMaxDollars)} at target`],
          ["Consistency formula", "Largest single-day profit / account profit <= 50%"],
          ["Max contracts", rules.evaluation?.maxContracts],
        ])}
      </section>
      <section>
        <h3>Live Simulation Guardrails</h3>
        ${keyValueTable([
          ["Starting balance", formatCurrency(rules.live?.startingBalanceDollars)],
          ["Starting live drawdown", formatCurrency(rules.live?.startingLiveDrawdownDollars)],
          ["Max live contracts", rules.live?.maxLiveContracts],
          ["Daily loss limit", rules.live?.dailyLossLimit],
          ["Drawdown method", rules.live?.drawdownMethod],
        ])}
      </section>
    </div>
    <div class="two-column">
      <section>
        <h3>Strategy Acceptance Checks</h3>
        ${bulletList(rules.strategyAcceptance?.mustReport || [])}
      </section>
      <section>
        <h3>Platform Rules</h3>
        ${bulletList([
          rules.platformRules?.simCloseOut,
          rules.platformRules?.overnight,
          rules.platformRules?.microscalping,
          rules.platformRules?.hft,
          rules.platformRules?.automation,
        ].filter(Boolean))}
      </section>
    </div>
  `;
}

function renderLivePnlTreatmentNotes() {
  return `
    <section>
      <h3>Recommended P&L Treatment</h3>
      ${bulletList([
        "Brokerage trades should be reported as real account P&L.",
        "Prop funded/live trades should be reported separately from evaluations because they represent an active funded cycle.",
        "Prop evaluation P&L should be grouped by account attempt, with a separate pass/fail status and capped realized value once the drawdown rule is breached.",
        "Practice trades should be excluded from headline live P&L unless deliberately selected for review.",
      ])}
    </section>
  `;
}

function renderLiveDashboard(manifest) {
  const live = manifest.tradingModes?.live || {};
  const summary = live.importSummary || {};
  const trueProfit = live.profitReconciliation || {};
  const liveTrades = liveClosedTrades(manifest);
  const liveActualRows = (trueProfit.rows || []).filter((row) => row.trueProfitSource === "trade_account_monitor");
  const pnl = pnlSummary(liveTrades);
  const phaseSummary = buildPhasePnlSummary(liveTrades, manifest);
  const openPnl = (live.openPositions || []).reduce((sum, row) => sum + (Number(row.unrealizedPnlDollars) || 0), 0);
  return `
    <section class="performance-section live">
      <div class="section-head">
        <div>
          <h2>Phase-Separated Live P&L</h2>
          <p>Prop evaluation progress, funded/performance cycles, brokerage P&L, and failed/forfeited history are separated so headline profit is not overstated.</p>
        </div>
      </div>
      ${renderPhasePnlTiles(phaseSummary)}
      <h3>Account Phase Breakdown</h3>
      ${renderAccountPhaseTable(phaseSummary.accounts)}
    </section>
    ${renderPerformanceCalendar("live-dashboard-calendar", liveTrades, "live", liveActualRows)}
    <div class="journal-toolbar">
      <span>Mode: Live</span>
      <span>Status: ${escapeHtml(humanizeStatus(live.status))}</span>
      <span>Instance: ${escapeHtml(live.instanceRoot || "n/a")}</span>
    </div>
    <div class="tile-grid">
      ${summaryTile("Live status", humanizeStatus(live.status), "warn")}
      ${summaryTile("Approved live strategies", live.strategies?.length || 0)}
      ${summaryTile("Account", live.account || "n/a")}
      ${summaryTile("Execution", "Disabled")}
      ${summaryTile("Live fills imported", summary.fillsImported || 0)}
      ${summaryTile("Closed trades", summary.closedTrades || 0)}
      ${summaryTile("Open live P&L", formatCurrency(openPnl), openPnl < 0 ? "warn" : "good")}
      ${summaryTile("Cumulative closed P&L", formatCurrency(pnl.net), pnl.net < 0 ? "warn" : "good")}
      ${summaryTile("Account monitor P&L", formatCurrency(trueProfit.totalTrueProfitDollars ?? pnl.net), trueProfit.hasTradeAccountMonitor || trueProfit.hasAccountBalanceDelta ? "good" : "warn")}
      ${summaryTile("Avg P&L / trade", formatCurrency(pnl.average))}
      ${summaryTile("Win / loss", `${pnl.wins} / ${pnl.losses}`)}
      ${summaryTile("Manual fills", summary.manualFills || 0, summary.manualFills ? "warn" : "neutral")}
      ${summaryTile("Strategy fills", summary.strategyFills || 0)}
      ${summaryTile("Unpaired fills", summary.unpairedFills || 0, summary.unpairedFills ? "warn" : "good")}
      ${summaryTile("SQLite source", live.liveSqliteFile ? "Available" : "Missing", live.liveSqliteFile ? "good" : "warn")}
      ${summaryTile("Account log sets", summary.accountCount || 0)}
      ${summaryTile("Account P&L source", trueProfitSourceLabel(liveTrueProfitSummary(live).source), trueProfit.hasTradeAccountMonitor || trueProfit.hasAccountBalanceDelta ? "good" : "warn")}
      ${summaryTile("Date range", summary.firstTradeDateUtc && summary.lastTradeDateUtc ? `${summary.firstTradeDateUtc} to ${summary.lastTradeDateUtc}` : "n/a")}
    </div>
    <h2>Open Live Trade P&L</h2>
    ${renderOpenPositionTable(live.openPositions || [])}
    <h2>Closed Live Trade P&L</h2>
    <p>Closed live trades are read from the PATrading live SQLite trades table. Same-day account-monitor P&L is shown separately where available.</p>
    ${renderLiveClosedTradeTable(live.closedTrades || [])}
    <h2>Imported Live Fill Activity</h2>
    <p>${escapeHtml(live.summary || "Live Sierra activity is imported into this dashboard.")}</p>
    ${renderLiveTradeTable(live.trades || [])}
    ${renderLivePnlTreatmentNotes()}
    <h2>Live Strategies</h2>
    ${renderModeStrategyTable(live.strategies || [])}
    <h2>Blockers</h2>
    ${bulletList(live.blockers || [])}
  `;
}

function renderLiveLedger(manifest) {
  const live = manifest.tradingModes?.live || {};
  const summary = live.importSummary || {};
  const trueProfit = live.profitReconciliation || {};
  const phaseSummary = buildPhasePnlSummary(live.performanceClosedTrades || live.closedTrades || [], manifest);
  const closedPnl = pnlSummary(live.performanceClosedTrades || live.closedTrades || []);
  const openPnl = (live.openPositions || []).reduce((sum, row) => sum + (Number(row.unrealizedPnlDollars) || 0), 0);
  return `
    <h2>Phase-Separated Live P&L</h2>
    ${renderPhasePnlTiles(phaseSummary)}
    ${renderAccountPhaseTable(phaseSummary.accounts)}
    <div class="tile-grid">
      ${summaryTile("Live execution", "disabled", "warn")}
      ${summaryTile("Imported fills", summary.fillsImported || 0)}
      ${summaryTile("Closed trades", summary.closedTrades || 0)}
      ${summaryTile("Open live P&L", formatCurrency(openPnl), openPnl < 0 ? "warn" : "good")}
      ${summaryTile("Cumulative closed P&L", formatCurrency(closedPnl.net), closedPnl.net < 0 ? "warn" : "good")}
      ${summaryTile("Account monitor P&L", formatCurrency(trueProfit.totalTrueProfitDollars ?? 0), trueProfit.hasTradeAccountMonitor || trueProfit.hasAccountBalanceDelta ? "good" : "warn")}
      ${summaryTile("Manual fills", summary.manualFills || 0, summary.manualFills ? "warn" : "neutral")}
      ${summaryTile("Strategy fills", summary.strategyFills || 0)}
      ${summaryTile("Unpaired fills", summary.unpairedFills || 0, summary.unpairedFills ? "warn" : "good")}
      ${summaryTile("Account log sets", summary.accountCount || 0)}
      ${summaryTile("Approval", "required", "warn")}
    </div>
    <p>${escapeHtml(live.summary || "No live trading ledger has been started.")}</p>
    ${keyValueTable([
      ["Sierra live folder", live.instanceRoot || "n/a"],
      ["PATrading live SQLite DB", live.liveSqliteFile || live.importPolicy?.sqliteFile || "n/a"],
      ["Unpaired fill note", summary.unpairedFillNote || "none"],
      ["Account monitor source", live.accountMonitor?.sourceFiles?.[0] || "n/a"],
      ["Full imported ledger", live.fullLedgerFile || "n/a"],
      ["Classification", live.importPolicy?.classification || "Unknown trades are manual."],
    ])}
    <h2>Open Live Trade P&L</h2>
    ${renderOpenPositionTable(live.openPositions || [])}
    <h2>Closed Live Trade P&L</h2>
    ${renderLiveClosedTradeTable(live.closedTrades || [])}
    <h2>Imported Live Fill Activity</h2>
    ${renderLiveTradeTable(live.trades || [])}
    ${renderLivePnlTreatmentNotes()}
  `;
}

function renderLedgerCalendar(daily) {
  const day = Number(daily.dayNumber || 1);
  const pnl = daily.realizedPnL || "0R";
  const validTrades = Number(daily.validTrades || 0);
  const cells = Array.from({ length: 14 }, (_unused, index) => {
    const isActive = index + 1 === day;
    return `
      <div class="calendar-cell ${isActive ? "active" : ""}">
        <span>Day ${index + 1}</span>
        <strong>${isActive ? escapeHtml(pnl) : "-"}</strong>
        <small>${isActive ? `${validTrades} trades` : "pending"}</small>
      </div>
    `;
  }).join("");
  return `<div class="calendar-grid">${cells}</div>`;
}

function renderLedger(manifest) {
  const latest = manifest.ledger?.latestLedger || manifest.ledger || {};
  const daily = manifest.dailyReport || {};
  const paperSummary = paperLedgerSummary(manifest);
  const rows = buildLedgerRows(manifest);
  const paperTrading = paperSummary.active ? "yes" : String(latest.paperTradingPerformed || "").toLowerCase();
  const tone = paperTrading === "yes" ? "good" : paperTrading === "no" ? "warn" : "neutral";

  return `
    <div class="journal-toolbar">
      <span>Account: ${escapeHtml(paperSummary.account)}</span>
      <span>Instrument focus: ${escapeHtml(paperSummary.symbol)}</span>
      <span>View: Forward-test ledger</span>
      <span>Timezone: Europe/London</span>
    </div>
    <div class="tile-grid">
      ${summaryTile("Paper trading", paperSummary.active ? "yes" : latest.paperTradingPerformed || "n/a", tone)}
      ${summaryTile("Paper account value", paperSummary.accountSize.accountSizeDollars === null ? "n/a" : formatCurrency(paperSummary.accountSize.accountSizeDollars), paperSummary.accountSize.accountSizeDollars < 0 ? "warn" : "good")}
      ${summaryTile("Paper realised P&L", formatCurrency(paperSummary.pnl.net), paperSummary.pnl.net < 0 ? "warn" : "good")}
      ${summaryTile("Trades observed", paperSummary.tradesObserved)}
      ${summaryTile("Fills observed", paperSummary.fillsObserved)}
      ${summaryTile("Missed signals", paperSummary.missedSignals)}
      ${summaryTile("Sierra balance P&L", paperSummary.accountSize.dailyPnlDollars === null ? "n/a" : formatCurrency(paperSummary.accountSize.dailyPnlDollars), paperSummary.accountSize.dailyPnlDollars < 0 ? "warn" : "good")}
      ${summaryTile("Latest paper trade", paperSummary.latestTradeDate ? formatTradeTimestamp(paperSummary.latestTradeDate) : "n/a", paperSummary.active ? "good" : "neutral")}
    </div>
    <div class="chart-grid ledger-charts">
      <article class="chart-card">
        <h3>Trade Outcomes</h3>
        <canvas id="ledgerOutcomeChart"></canvas>
      </article>
    </div>
    <div class="section-head">
      <div>
        <h2>Trade Log</h2>
        <p>Current paper ledger from Sierra paper SIM imports.</p>
      </div>
    </div>
    ${renderTradeLogTable(rows)}
    <div class="two-column">
      <section>
        <h3>Forward-Test Calendar</h3>
        ${renderPerformanceCalendar("paper-ledger-calendar", paperClosedTrades(manifest), "paper")}
      </section>
      <section>
        <h3>Journal Summary</h3>
        ${keyValueTable([
          ["Strategy", latest.strategy || daily.strategy],
          ["Paper account value", paperSummary.accountSize.accountSizeDollars === null ? "n/a" : formatCurrency(paperSummary.accountSize.accountSizeDollars)],
          ["Displayed value source", paperSummary.accountSize.accountValueSource],
          ["Paper realised P&L", formatCurrency(paperSummary.pnl.net)],
          ["Sierra balance P&L", paperSummary.accountSize.dailyPnlDollars === null ? "n/a" : formatCurrency(paperSummary.accountSize.dailyPnlDollars)],
          ["Current paper trades", paperSummary.tradesObserved],
          ["Current paper fills", paperSummary.fillsObserved],
          ["Current source file", paperSummary.sourceFile],
        ])}
      </section>
    </div>
    ${
      paperSummary.active
        ? `
    <div class="two-column">
      <section>
        <h3>Current Import</h3>
        ${keyValueTable([
          ["Account", paperSummary.account],
          ["Account monitor account", paperSummary.accountSize.account],
          ["Account monitor source", paperSummary.accountSize.sourceFile || "n/a"],
          ["Account monitor warning", paperSummary.accountSize.warning || "none"],
          ["Instrument focus", paperSummary.symbol],
          ["Latest paper trade", paperSummary.latestTradeDate ? formatTradeTimestamp(paperSummary.latestTradeDate) : "n/a"],
        ])}
      </section>
      <section>
        <h3>Legacy Notes</h3>
        <p class="section-note">Older preflight notes are archived and no longer drive the paper trading ledger totals.</p>
      </section>
    </div>
    `
        : `
    <div class="two-column">
      <section>
        <h3>Preflight Findings</h3>
        ${bulletList(extractBullets(latest.textSnippet, "2026-05-15 preflight findings"))}
      </section>
      <section>
        <h3>Sierra Setup</h3>
        ${bulletList(extractBullets(latest.textSnippet, "Sierra paper setup checked", 10))}
      </section>
    </div>
    `
    }
  `;
}

function renderDailyReport(daily) {
  const syncedReports = daily.paperclipReports || [];
  return `
    <div class="tile-grid">
      ${summaryTile("Day", daily.dayNumber || "n/a")}
      ${summaryTile("Valid signals", daily.validSignals || "0")}
      ${summaryTile("Valid trades", daily.validTrades || "0")}
      ${summaryTile("Missed signals", daily.missedSignals || "0")}
      ${summaryTile("Realized PnL", daily.realizedPnL || "n/a")}
      ${summaryTile("Recommendation", daily.recommendation || "n/a")}
    </div>
    ${keyValueTable([
      ["Strategy", daily.strategy],
      ["Source file", basename(daily.path)],
      ["Full source path", daily.path],
    ])}
    <div class="two-column">
      <section>
        <h3>What Was Observed</h3>
        ${bulletList(extractBullets(daily.textSnippet, "What was observed", 10))}
      </section>
      <section>
        <h3>Sierra Setup Reviewed</h3>
        ${bulletList(extractBullets(daily.textSnippet, "Sierra paper setup reviewed", 10))}
      </section>
    </div>
    <h2>Paperclip Synced Reports</h2>
    <p class="section-note">Native Paperclip issue documents and reports that relate to the Ocean Trading website are synced into the dashboard data store.</p>
    ${renderPaperclipReportTable(syncedReports)}
  `;
}

function renderPaperclipReportTable(reports) {
  if (!reports?.length) return '<p class="empty">No Paperclip-native reports have been synced yet.</p>';
  return `
    <table>
      <thead>
        <tr>
          <th>Updated</th>
          <th>Issue</th>
          <th>Type</th>
          <th>Document</th>
          <th>Status</th>
          <th>Link</th>
        </tr>
      </thead>
      <tbody>
        ${reports
          .map(
            (report) => `
          <tr>
            <td>${escapeHtml(formatTradeTimestamp(report.updatedAtUtc))}</td>
            <td>${escapeHtml(report.identifier || report.issueId)}</td>
            <td>${escapeHtml(humanizeStatus(report.type))}</td>
            <td>${escapeHtml(report.title || report.documentKey)}</td>
            <td>${escapeHtml(humanizeStatus(report.issueStatus))}</td>
            <td><a class="text-link" href="${escapeHtml(report.url)}" target="_blank" rel="noreferrer">Open</a></td>
          </tr>
        `,
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function createStrategyMetricsTable(rows) {
  if (!rows || rows.length === 0) return '<p class="empty">No metrics extracted from local JSON yet.</p>';
  const hasVariant = rows.some((row) => row.variant);
  return `
    <table>
      <thead>
        <tr>
          <th>Strategy</th>
          ${hasVariant ? "<th>Variant</th>" : ""}
          <th>Trades</th>
          <th>Wins</th>
          <th>Losses</th>
          <th>Long</th>
          <th>Short</th>
          <th>Win rate</th>
          <th>Net PnL</th>
          <th>Profit factor</th>
          <th>Max drawdown</th>
          <th>Data source</th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (row) => `
          <tr>
            <td>${escapeHtml(row.strategy)}</td>
            ${hasVariant ? `<td>${escapeHtml(row.variant || "baseline")}</td>` : ""}
            <td>${escapeHtml(row.trades)}</td>
            <td>${escapeHtml(row.wins)}</td>
            <td>${escapeHtml(row.losses)}</td>
            <td>${escapeHtml(row.longTrades)}</td>
            <td>${escapeHtml(row.shortTrades)}</td>
            <td>${escapeHtml(formatPercent(row.winRate))}</td>
            <td>${escapeHtml(formatCurrency(row.netProfitDollars))}</td>
            <td>${escapeHtml(row.profitFactor)}</td>
            <td>${escapeHtml(formatCurrency(row.maxDrawdownDollars))}</td>
            <td>${dataSourceBadge(row.sourceSystem || "paperclip_artifact", row.sourceDetail)}</td>
          </tr>
        `,
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function createPaperPerformanceTable(rows) {
  if (!rows?.length) return '<p class="empty">No paper-trading performance rows found yet.</p>';
  return `
    <p class="section-note">Paper P&L is reconciled from the PATrading paper telemetry SQLite trades table.</p>
    <table>
      <thead>
        <tr>
          <th>Strategy / Bundle</th>
          <th>Paper status</th>
          <th>Trades observed</th>
          <th>Fills observed</th>
          <th>Missed signals</th>
          <th>Recommendation</th>
          <th>Data source</th>
          <th>Source</th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (row) => `
              <tr>
                <td>${escapeHtml(row.strategy)}</td>
                <td>${escapeHtml(row.paperTradingPerformed)}</td>
                <td>${escapeHtml(row.tradesObserved ?? "n/a")}</td>
                <td>${escapeHtml(row.fillsObserved ?? "n/a")}</td>
                <td>${escapeHtml(row.missedSignals ?? "n/a")}</td>
                <td>${escapeHtml(row.recommendation)}</td>
                <td>${dataSourceBadge(row.sourceSystem || "paperclip", row.sourceDetail)}</td>
                <td>${escapeHtml(basename(row.sourceFile))}</td>
              </tr>
            `,
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function createPaperReviewReportTable(rows) {
  if (!rows?.length) return "";
  return `
    <h4>Setup / Historical Paper Reports</h4>
    <p class="section-note">These reports are retained for audit/history but are not active paper-trading strategy performance rows.</p>
    <table>
      <thead>
        <tr>
          <th>Strategy / Report</th>
          <th>Status</th>
          <th>Paper trading</th>
          <th>Trades observed</th>
          <th>Fills observed</th>
          <th>Data source</th>
          <th>Source</th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (row) => `
              <tr>
                <td>${escapeHtml(row.strategy)}</td>
                <td>${escapeHtml(humanizeStatus(row.status))}</td>
                <td>${escapeHtml(row.paperTradingPerformed)}</td>
                <td>${escapeHtml(row.tradesObserved ?? "n/a")}</td>
                <td>${escapeHtml(row.fillsObserved ?? "n/a")}</td>
                <td>${dataSourceBadge(row.sourceSystem || "paperclip_artifact", row.sourceDetail)}</td>
                <td>${escapeHtml(basename(row.sourceFile))}</td>
              </tr>
            `,
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function createLivePerformanceTable(rows) {
  if (!rows?.length) return '<p class="empty">No live-trading performance rows found yet.</p>';
  return `
    <table>
      <thead>
        <tr>
          <th>Source</th>
          <th>Account Type</th>
          <th>Strategy / Owner</th>
          <th>Trades</th>
          <th>Wins</th>
          <th>Losses</th>
          <th>Long</th>
          <th>Short</th>
          <th>Win rate</th>
          <th>Net PnL</th>
          <th>True Profit</th>
          <th>Actual source</th>
          <th>Profit factor</th>
          <th>Max drawdown</th>
          <th>Priced fills</th>
          <th>Unreconciled fills</th>
          <th>Date range</th>
          <th>Data source</th>
          <th>Source</th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (row) => `
              <tr>
                <td><span class="pill ${row.source === "manual" ? "warn" : "good"}">${escapeHtml(humanizeStatus(row.source))}</span></td>
                <td>${escapeHtml(row.accountType || "n/a")}</td>
                <td>${escapeHtml(row.strategy)}</td>
                <td>${escapeHtml(row.trades)}</td>
                <td>${escapeHtml(row.wins)}</td>
                <td>${escapeHtml(row.losses)}</td>
                <td>${escapeHtml(row.longTrades)}</td>
                <td>${escapeHtml(row.shortTrades)}</td>
                <td>${escapeHtml(formatPercent(row.winRate))}</td>
                <td>${escapeHtml(formatCurrency(row.netProfitDollars))}</td>
                <td>${escapeHtml(formatCurrency(row.trueProfitDollars ?? row.netProfitDollars))}</td>
                <td title="${escapeHtml(row.trueProfitSourceDetail || "")}">${escapeHtml(trueProfitSourceLabel(row.trueProfitSource))}</td>
                <td>${escapeHtml(row.profitFactor)}</td>
                <td>${escapeHtml(formatCurrency(row.maxDrawdownDollars))}</td>
                <td>${escapeHtml(row.pricedFills ?? "n/a")}</td>
                <td>${escapeHtml(row.unreconciledFills ?? "n/a")}</td>
                <td>${escapeHtml(row.firstTradeDateUtc && row.lastTradeDateUtc ? `${row.firstTradeDateUtc} to ${row.lastTradeDateUtc}` : "n/a")}</td>
                <td>${dataSourceBadge(row.sourceSystem || "sierra", row.sourceDetail)}</td>
                <td>${escapeHtml(basename(row.sourceFile))}</td>
              </tr>
            `,
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function renderHistoricalCache(cache) {
  const datasets = cache?.datasets || [];
  const totalBars = datasets.reduce((sum, row) => sum + Number(row.bars || 0), 0);
  const latest = datasets
    .filter((row) => row.cachedFrom || row.cachedTo)
    .sort((a, b) => String(b.cachedTo || "").localeCompare(String(a.cachedTo || "")))[0];
  const uniqueSeries = new Set(datasets.map((row) => `${row.instrument}|${row.symbol}|${row.timeframe}`)).size;
  if (!cache?.ok) {
    return `<p class="empty">Historical cache could not be read: ${escapeHtml(cache?.error || "unknown error")}</p>`;
  }
  return `
    <div class="summary-grid">
      ${summaryTile("Cached series", uniqueSeries || 0)}
      ${summaryTile("Cached bars", totalBars.toLocaleString("en-GB"))}
      ${summaryTile("Latest loaded", latest?.cachedTo || "n/a", latest ? "good" : "warn")}
      ${summaryTile("Cache updated", cache.updatedAtUtc ? formatTradeTimestamp(cache.updatedAtUtc) : "n/a")}
    </div>
    <p class="section-note">This is shared historical market data. It is not tied to Cody's Strategy, VWAP, ORB, or any single approach.</p>
    ${
      datasets.length
        ? `<div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Instrument</th>
                  <th>Symbol</th>
                  <th>Timeframe</th>
                  <th>Cached From</th>
                  <th>Cached To</th>
                  <th>Trading Dates</th>
                  <th>Bars</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                ${datasets
                  .map(
                    (row) => `
                      <tr>
                        <td>${escapeHtml(row.instrument)}</td>
                        <td>${escapeHtml(row.symbol)}</td>
                        <td>${escapeHtml(row.timeframe)} min</td>
                        <td>${escapeHtml(row.cachedFrom || row.from || "n/a")}</td>
                        <td>${escapeHtml(row.cachedTo || row.to || "n/a")}</td>
                        <td>${escapeHtml(row.cachedTradingDates || "n/a")}</td>
                        <td>${escapeHtml(Number(row.bars || 0).toLocaleString("en-GB"))}</td>
                        <td>${escapeHtml(row.source || "n/a")}</td>
                      </tr>
                    `,
                  )
                  .join("")}
              </tbody>
            </table>
          </div>`
        : '<p class="empty">No historical Sierra data is currently cached for fast backtesting.</p>'
    }
  `;
}

function forecastNextRegime(summary) {
  const states = summary?.model?.states || [];
  const current = summary?.currentRegime?.probabilities || {};
  const matrix = summary?.transitionMatrix || {};
  const forecast = {};
  for (const state of states) forecast[state] = 0;
  for (const from of states) {
    for (const to of states) {
      forecast[to] += Number(current[from] || 0) * Number(matrix[from]?.[to] || 0);
    }
  }
  return Object.entries(forecast).sort((a, b) => b[1] - a[1]);
}

function renderRegimeProbabilityBars(probabilities = {}) {
  const rows = Object.entries(probabilities).sort((a, b) => Number(b[1]) - Number(a[1]));
  if (!rows.length) return '<p class="empty">No regime probabilities are available yet.</p>';
  return `
    <div class="probability-bars">
      ${rows.map(([label, value]) => {
        const pct = Math.max(0, Math.min(100, Number(value || 0) * 100));
        return `
          <div class="probability-row">
            <span>${escapeHtml(label)}</span>
            <div class="probability-track"><span style="width: ${pct.toFixed(1)}%"></span></div>
            <strong>${pct.toFixed(1)}%</strong>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function markovTimeframeLabel(timeframe) {
  if (timeframe?.label) return timeframe.label;
  const minutes = Number(timeframe?.minutes || 0);
  if (minutes === 1440) return "Daily";
  if (minutes === 60) return "Hourly";
  if (minutes === 15) return "15-minute";
  if (minutes === 5) return "5-minute";
  return minutes ? `${minutes}-minute` : "n/a";
}

function markovRiskFactors(summary) {
  const label = String(summary?.currentRegime?.label || "").toLowerCase();
  const confidence = Number(summary?.currentRegime?.confidence || 0);
  const strong = confidence >= 0.55;
  if (label.includes("chop")) return { long: "0.25", short: "0.25", range: "0.25" };
  if (label.includes("breakout")) return { long: "1.00", short: "1.00", range: "0.25" };
  if (label.includes("range") || label.includes("balance")) return { long: "0.50", short: "0.50", range: strong ? "1.25" : "1.00" };
  if (label.includes("trend up")) return { long: strong ? "1.25" : "1.00", short: "0.50", range: "0.50" };
  if (label.includes("trend down")) return { long: "0.50", short: strong ? "1.25" : "1.00", range: "0.50" };
  return { long: "1.00", short: "1.00", range: "1.00" };
}

function renderMarkovMultiTimeframeTable(payload) {
  const rows = (payload?.summaries || []).map((item) => {
    const summary = item.summary;
    if (!item.ok || !summary) {
      return {
        Timeframe: markovTimeframeLabel(item.timeframe),
        Regime: "Not built",
        Confidence: "n/a",
        "Forecast lead": "n/a",
        "Long risk": "n/a",
        "Short risk": "n/a",
        "Range risk": "n/a",
        "Last bar": "n/a",
      };
    }
    const forecast = forecastNextRegime(summary);
    const bestForecast = forecast[0];
    const risks = markovRiskFactors(summary);
    return {
      Timeframe: markovTimeframeLabel(item.timeframe),
      Regime: summary.currentRegime?.label || "n/a",
      Confidence: summary.currentRegime?.confidence === undefined ? "n/a" : formatPercent(summary.currentRegime.confidence),
      "Forecast lead": bestForecast ? `${bestForecast[0]} (${(bestForecast[1] * 100).toFixed(1)}%)` : "n/a",
      "Long risk": risks.long,
      "Short risk": risks.short,
      "Range risk": risks.range,
      "Last bar": summary.source?.coverage?.lastBarKey || "n/a",
    };
  });
  return rows.length ? renderGenericTable(rows) : '<p class="empty">No timeframe regime summaries have been built yet.</p>';
}

function renderMarkovSessionRiskTable(payload) {
  const wanted = new Set([1440, 60, 15, 5]);
  const rows = (payload?.sessionRisk || [])
    .filter((item) => wanted.has(Number(item.timeframe?.minutes || 0)))
    .sort((a, b) => {
      const sessionOrder = { Asian: 0, London: 1, US: 2 };
      const timeframeOrder = { 1440: 0, 60: 1, 15: 2, 5: 3 };
      return (sessionOrder[a.session] ?? 99) - (sessionOrder[b.session] ?? 99)
        || (timeframeOrder[Number(a.timeframe?.minutes || 0)] ?? 99) - (timeframeOrder[Number(b.timeframe?.minutes || 0)] ?? 99);
    })
    .map((item) => ({
      Session: item.session || "n/a",
      Timeframe: markovTimeframeLabel(item.timeframe),
      Regime: item.regime || "Not built",
      Confidence: item.confidence === null || item.confidence === undefined ? "n/a" : formatPercent(item.confidence),
      "Long risk": item.longRisk || "n/a",
      "Short risk": item.shortRisk || "n/a",
      "Range risk": item.rangeRisk || "n/a",
      "Latest bar": item.barKey || "n/a",
      Note: item.note || "",
    }));
  return rows.length ? renderGenericTable(rows) : '<p class="empty">No session risk rows have been built yet.</p>';
}

function scoreDisplay(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(3) : "n/a";
}

function confidenceDisplay(value) {
  const number = Number(value);
  return Number.isFinite(number) ? formatPercent(number) : "n/a";
}

function confluenceRowMap(report) {
  const map = new Map();
  for (const row of report?.rows || []) {
    const key = `${row.timeframe}|${row.system}`;
    map.set(key, row);
  }
  return map;
}

function confluenceTimeframeOrder(timeframe) {
  return { "5m": 0, "15m": 1, "60m": 2, daily: 3, weekly: 4 }[timeframe] ?? 99;
}

function confluenceCell(row) {
  if (!row) return "n/a";
  const score = row.score === null || row.score === undefined ? "" : ` ${scoreDisplay(row.score)}`;
  return `${row.bias || "n/a"}${score}`;
}

function confluenceStanceBucket(row) {
  if (!row) return null;
  const system = String(row.system || "").toLowerCase();
  const summary = String(row.summary || "").toLowerCase();
  const bias = String(row.bias || "").toLowerCase();
  const score = Number(row.score);
  if (system.includes("markov")) {
    if (summary.includes("trend down")) return "bearish";
    if (summary.includes("trend up")) return "bullish";
    if (summary.includes("range") || summary.includes("chop") || summary.includes("flat")) return "range";
    if (summary.includes("breakout")) return "range";
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

function confluenceStanceSummary(report) {
  const timeframeWeights = { "5m": 0.8, "15m": 1, "60m": 1.2, daily: 1.4, weekly: 1.5 };
  const systemWeights = {
    "Volatility": 0.75,
    "Trend/Momentum": 1,
    "Mean Reversion": 1,
    "Factor/Regression": 1,
    "Volume/Order Flow": 1,
    "Confluence engine": 1.25,
    "Markov regime": 1.1,
  };
  const totals = { bearish: 0, range: 0, bullish: 0 };
  const votes = { bearish: 0, range: 0, bullish: 0 };
  const rows = (report?.rows || []).filter((row) =>
    ["5m", "15m", "60m", "daily", "weekly"].includes(row.timeframe) && systemWeights[row.system]
  );
  for (const row of rows) {
    const bucket = confluenceStanceBucket(row);
    if (!bucket) continue;
    const confidence = Number(row.confidence);
    const confidenceWeight = Number.isFinite(confidence) ? Math.max(0.25, Math.min(1, confidence)) : 0.5;
    const weight = (timeframeWeights[row.timeframe] || 1) * (systemWeights[row.system] || 1) * confidenceWeight;
    totals[bucket] += weight;
    votes[bucket] += 1;
  }
  const total = totals.bearish + totals.range + totals.bullish;
  const percentages = total > 0
    ? {
        bearish: (totals.bearish / total) * 100,
        range: (totals.range / total) * 100,
        bullish: (totals.bullish / total) * 100,
      }
    : { bearish: 33.3, range: 33.4, bullish: 33.3 };
  const dominant = Object.entries(percentages).sort((a, b) => b[1] - a[1])[0]?.[0] || "range";
  const contradiction = percentages.bearish >= 25 && percentages.bullish >= 25;
  const contention = Math.max(percentages.bearish, percentages.range, percentages.bullish) < 45;
  return { percentages, votes, dominant, contradiction, contention, rowCount: rows.length };
}

function regimeBucket(label) {
  const value = String(label || "").toLowerCase();
  if (value.includes("down")) return "bearish";
  if (value.includes("up")) return "bullish";
  if (value.includes("range") || value.includes("balance") || value.includes("chop") || value.includes("breakout")) return "range";
  return "range";
}

function stanceFromPercentages(percentages, fallbackVotes = {}) {
  const dominant = Object.entries(percentages).sort((a, b) => b[1] - a[1])[0]?.[0] || "range";
  return {
    percentages,
    votes: {
      bearish: fallbackVotes.bearish || 0,
      range: fallbackVotes.range || 0,
      bullish: fallbackVotes.bullish || 0,
    },
    dominant,
    contradiction: percentages.bearish >= 25 && percentages.bullish >= 25,
    contention: Math.max(percentages.bearish, percentages.range, percentages.bullish) < 45,
    rowCount: fallbackVotes.rowCount || 0,
  };
}

function confluenceTomorrowStanceSummary(report, markovPayload) {
  const today = confluenceStanceSummary(report);
  const forecast = forecastNextRegime(markovPayload?.summary || {});
  if (!forecast.length) {
    return {
      ...today,
      basis: "Forecast unavailable; showing current confluence as the best available proxy.",
    };
  }
  const regimeTotals = { bearish: 0, range: 0, bullish: 0 };
  let total = 0;
  for (const [label, value] of forecast) {
    const probability = Number(value);
    if (!Number.isFinite(probability)) continue;
    regimeTotals[regimeBucket(label)] += probability;
    total += probability;
  }
  const forecastPercentages = total > 0
    ? {
        bearish: (regimeTotals.bearish / total) * 100,
        range: (regimeTotals.range / total) * 100,
        bullish: (regimeTotals.bullish / total) * 100,
      }
    : today.percentages;
  const blended = {
    bearish: forecastPercentages.bearish * 0.6 + today.percentages.bearish * 0.4,
    range: forecastPercentages.range * 0.6 + today.percentages.range * 0.4,
    bullish: forecastPercentages.bullish * 0.6 + today.percentages.bullish * 0.4,
  };
  return {
    ...stanceFromPercentages(blended, { ...today.votes, rowCount: today.rowCount }),
    basis: "60% Markov next-state forecast, 40% current seven-family confluence tilt.",
  };
}

function confluenceSessionProfile(sessionName) {
  const profiles = {
    Asian: {
      label: "Asian Session",
      note: "Overnight liquidity and early Globex structure.",
      timeframeWeights: { "5m": 1.15, "15m": 1.05, "60m": 0.9, daily: 0.75, weekly: 0.6 },
    },
    London: {
      label: "London Session",
      note: "UK/EU impulse and mid-session direction.",
      timeframeWeights: { "5m": 0.95, "15m": 1.2, "60m": 1.15, daily: 0.8, weekly: 0.65 },
    },
    US: {
      label: "US Session",
      note: "US cash-session response and continuation risk.",
      timeframeWeights: { "5m": 1.05, "15m": 1.1, "60m": 1.2, daily: 0.9, weekly: 0.7 },
    },
  };
  return profiles[sessionName] || profiles.London;
}

function confluenceApplyProbabilityFloor(percentages, floor = 8) {
  const bearish = Number(percentages?.bearish);
  const range = Number(percentages?.range);
  const bullish = Number(percentages?.bullish);
  if (![bearish, range, bullish].every(Number.isFinite)) return percentages;
  if (bearish >= floor && range >= floor && bullish >= floor) return percentages;
  const floored = {
    bearish: Math.max(floor, bearish),
    range: Math.max(floor, range),
    bullish: Math.max(floor, bullish),
  };
  const total = floored.bearish + floored.range + floored.bullish;
  return {
    bearish: (floored.bearish / total) * 100,
    range: (floored.range / total) * 100,
    bullish: (floored.bullish / total) * 100,
  };
}

function confluenceSessionStanceSummary(report, sessionName) {
  const profile = confluenceSessionProfile(sessionName);
  const sessionRows = Array.isArray(report?.sessions?.[sessionName]?.rows)
    ? report.sessions[sessionName].rows
    : null;
  const systemWeights = {
    "Volatility": 0.75,
    "Trend/Momentum": 1,
    "Mean Reversion": 1,
    "Factor/Regression": 1,
    "Volume/Order Flow": 1,
    "Confluence engine": 1.25,
    "Markov regime": 1.1,
  };
  const totals = { bearish: 0, range: 0, bullish: 0 };
  const votes = { bearish: 0, range: 0, bullish: 0 };
  const rows = (sessionRows || report?.rows || []).filter((row) =>
    profile.timeframeWeights[row.timeframe] && systemWeights[row.system]
  );
  for (const row of rows) {
    const bucket = confluenceStanceBucket(row);
    if (!bucket) continue;
    const confidence = Number(row.confidence);
    const confidenceWeight = Number.isFinite(confidence) ? Math.max(0.25, Math.min(1, confidence)) : 0.5;
    const weight = (profile.timeframeWeights[row.timeframe] || 1) * (systemWeights[row.system] || 1) * confidenceWeight;
    totals[bucket] += weight;
    votes[bucket] += 1;
  }
  const total = totals.bearish + totals.range + totals.bullish;
  const rawPercentages = total > 0
    ? {
        bearish: (totals.bearish / total) * 100,
        range: (totals.range / total) * 100,
        bullish: (totals.bullish / total) * 100,
      }
    : { bearish: 33.3, range: 33.4, bullish: 33.3 };
  const percentages = confluenceApplyProbabilityFloor(rawPercentages);
  return stanceFromPercentages(percentages, { ...votes, rowCount: rows.length });
}

function confluenceSessionTomorrowStanceSummary(report, markovPayload, sessionName) {
  const today = confluenceSessionStanceSummary(report, sessionName);
  const forecast = forecastNextRegime(markovPayload?.summary || {});
  if (!forecast.length) {
    return {
      ...today,
      basis: "Forecast unavailable; showing session-weighted confluence as the best available proxy.",
    };
  }
  const regimeTotals = { bearish: 0, range: 0, bullish: 0 };
  let total = 0;
  for (const [label, value] of forecast) {
    const probability = Number(value);
    if (!Number.isFinite(probability)) continue;
    regimeTotals[regimeBucket(label)] += probability;
    total += probability;
  }
  const forecastPercentages = total > 0
    ? {
        bearish: (regimeTotals.bearish / total) * 100,
        range: (regimeTotals.range / total) * 100,
        bullish: (regimeTotals.bullish / total) * 100,
      }
    : today.percentages;
  const blended = {
    bearish: forecastPercentages.bearish * 0.6 + today.percentages.bearish * 0.4,
    range: forecastPercentages.range * 0.6 + today.percentages.range * 0.4,
    bullish: forecastPercentages.bullish * 0.6 + today.percentages.bullish * 0.4,
  };
  return {
    ...stanceFromPercentages(blended, { ...today.votes, rowCount: today.rowCount }),
    basis: "Session-weighted forecast from saved confluence rows plus Markov next-state probabilities.",
  };
}

function ukDateKeyFromUtc(value) {
  const date = value ? new Date(value) : new Date();
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function zonedDateKey(value = new Date(), timeZone = "Europe/London") {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function zonedTimeMinutes(value = new Date(), timeZone = "Europe/London") {
  const date = value instanceof Date ? value : new Date(value);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return Number(parts.hour || 0) * 60 + Number(parts.minute || 0);
}

function shiftDateKey(dateKey, days) {
  const date = new Date(`${dateKey}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dateKeyWeekday(dateKey) {
  return new Date(`${dateKey}T12:00:00Z`).getUTCDay();
}

function isWeekendDateKey(dateKey) {
  const weekday = dateKeyWeekday(dateKey);
  return weekday === 0 || weekday === 6;
}

function previousTradingDateKey(dateKey) {
  let candidate = shiftDateKey(dateKey, -1);
  for (let guard = 0; guard < 14; guard += 1) {
    if (!isWeekendDateKey(candidate)) return candidate;
    candidate = shiftDateKey(candidate, -1);
  }
  return candidate;
}

function nextTradingDateKey(dateKey) {
  let candidate = shiftDateKey(dateKey, 1);
  for (let guard = 0; guard < 14; guard += 1) {
    if (!isWeekendDateKey(candidate)) return candidate;
    candidate = shiftDateKey(candidate, 1);
  }
  return candidate;
}

function currentCmeTradingDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const etDateKey = zonedDateKey(date, "America/New_York");
  const etMinutes = zonedTimeMinutes(date, "America/New_York");
  const weekday = dateKeyWeekday(etDateKey);
  if (weekday === 6) return previousTradingDateKey(etDateKey);
  if (weekday === 0) return etMinutes >= 18 * 60 ? nextTradingDateKey(etDateKey) : previousTradingDateKey(etDateKey);
  if (weekday >= 1 && weekday <= 4 && etMinutes >= 18 * 60) return nextTradingDateKey(etDateKey);
  return etDateKey;
}

function confluenceTradingDates(payload = {}) {
  const current = payload?.tradingDates?.current || currentCmeTradingDateKey();
  return {
    previous: payload?.tradingDates?.previous || previousTradingDateKey(current),
    current,
    next: payload?.tradingDates?.next || nextTradingDateKey(current),
  };
}

function ukTimeLabel(value) {
  if (!value) return "time n/a";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "time n/a";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function ukDateTimeLabel(value) {
  if (!value) return "time n/a";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "time n/a";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date).replace(",", "");
}

function confluencePriorForecastSnapshot(history = [], tradingDateKey = null) {
  return [...history].find((entry) => entry?.dateKey === tradingDateKey) || null;
}

function confluenceSnapshotForDate({ dateKey, todayDate, report, markovPayload, history = [], yesterdayForecast = null }) {
  if (!dateKey) return null;
  if (dateKey === todayDate && report) {
    return {
      dateKey,
      prediction: report,
      markovSummary: markovPayload?.summary || report?.markovSummary || null,
      sourceLabel: "current report",
    };
  }
  if (yesterdayForecast?.asOfDateLondon === dateKey) {
    return {
      dateKey,
      prediction: yesterdayForecast,
      markovSummary: yesterdayForecast.markovSummary || null,
      sourceLabel: `as-of ${dateKey} report`,
    };
  }
  const snapshot = confluencePriorForecastSnapshot(history, dateKey);
  if (!snapshot) return null;
  return {
    dateKey,
    prediction: snapshot.prediction,
    markovSummary: snapshot.markovSummary || snapshot.prediction?.markovSummary || null,
    sourceLabel: `saved ${dateKey} snapshot`,
  };
}

function shortTradingDateLabel(dateKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ""))) return dateKey || "n/a";
  const date = new Date(`${dateKey}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
  }).format(date);
}

function confluenceSessionActualForecastRows({ report, markovPayload, history = [], yesterdayForecast = null, tradingDates = null }) {
  const todayDate = tradingDates?.current || currentCmeTradingDateKey();
  const tomorrowDate = tradingDates?.next || nextTradingDateKey(todayDate);
  const yesterdayDate = tradingDates?.previous || previousTradingDateKey(todayDate);
  const previousDate = previousTradingDateKey(yesterdayDate);
  const dayBeforePreviousDate = previousTradingDateKey(previousDate);
  const specs = [
    {
      label: "Day before previous",
      detail: "actual confluence",
      dateKey: dayBeforePreviousDate,
      kind: "actual",
    },
    {
      label: "Previous day",
      detail: "actual confluence",
      dateKey: previousDate,
      kind: "actual",
    },
    {
      label: "Yesterday",
      detail: "actual confluence",
      dateKey: yesterdayDate,
      kind: "actual",
    },
    {
      label: "Today forecast",
      detail: "from previous trading day",
      dateKey: todayDate,
      sourceDate: yesterdayDate,
      kind: "prediction",
    },
    {
      label: "Today",
      detail: "actual confluence",
      dateKey: todayDate,
      kind: "actual",
    },
    {
      label: "Tomorrow",
      detail: "prediction",
      dateKey: tomorrowDate,
      sourceDate: todayDate,
      kind: "prediction",
    },
  ];
  return specs.map((spec) => ({
    ...spec,
    snapshot: confluenceSnapshotForDate({
      dateKey: spec.kind === "prediction" ? spec.sourceDate : spec.dateKey,
      todayDate,
      report,
      markovPayload,
      history,
      yesterdayForecast,
    }),
  }));
}

function confluenceSessionWindow(sessionName) {
  const windows = {
    Asian: { startMinute: 0, endMinute: 8 * 60 },
    London: { startMinute: 8 * 60, endMinute: 13 * 60 + 30 },
    US: { startMinute: 13 * 60 + 30, endMinute: 21 * 60 },
  };
  return windows[sessionName] || windows.London;
}

function confluenceSessionCoverageDateKey(snapshot, sessionName) {
  const coverage = Array.isArray(snapshot?.prediction?.sessions?.[sessionName]?.coverage)
    ? snapshot.prediction.sessions[sessionName].coverage
    : [];
  const intradayCoverage = coverage
    .filter((item) => [5, 15, 60].includes(Number(item?.timeframeMinutes)) && item?.lastUtc)
    .map((item) => {
      const date = new Date(item.lastUtc);
      return Number.isNaN(date.getTime()) ? null : zonedDateKey(date, "Europe/London");
    })
    .filter((dateKey) => /^\d{4}-\d{2}-\d{2}$/.test(dateKey))
    .sort();
  return intradayCoverage.at(-1) || null;
}

function confluenceStaleSessionStatus(row, sessionName, tradingDates = null) {
  if (!row?.snapshot) return null;
  const requiredDateKey = row.kind === "prediction"
    ? row.sourceDate || row.dateKey
    : row.dateKey;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(requiredDateKey || ""))) return null;
  const todayDate = tradingDates?.current || currentCmeTradingDateKey();
  const currentLondonDate = zonedDateKey(new Date(), "Europe/London");
  if (requiredDateKey === todayDate && currentLondonDate <= todayDate) {
    const session = confluenceSessionWindow(sessionName);
    const minutes = zonedTimeMinutes(new Date(), "Europe/London");
    if (minutes < session.startMinute) return null;
  }
  const latestDateKey = confluenceSessionCoverageDateKey(row.snapshot, sessionName);
  if (latestDateKey && latestDateKey >= requiredDateKey) return null;
  return {
    label: "Stale source",
    tone: "partial",
    icon: "alert",
    note: `Latest ${sessionName} intraday source is ${latestDateKey || "unavailable"}; waiting for ${requiredDateKey}.`,
    showBar: false,
  };
}

function confluenceRowStatus(row, sessionName, tradingDates = null) {
  const staleStatus = confluenceStaleSessionStatus(row, sessionName, tradingDates);
  if (staleStatus) return staleStatus;
  if (row.kind === "prediction" && row.label === "Today forecast") {
    return {
      label: "From yesterday",
      tone: "forecast",
      icon: "arrow",
      note: "Previous trading day forecast for today's session.",
      showBar: true,
    };
  }
  if (row.kind === "prediction" && row.label === "Tomorrow") {
    const todayDate = tradingDates?.current || currentCmeTradingDateKey();
    const currentLondonDate = zonedDateKey(new Date(), "Europe/London");
    if (currentLondonDate > todayDate) {
      return {
        label: "Session-ready",
        tone: "forecast",
        icon: "check",
        note: "Trading date has ended; this forecast uses the completed session-specific data.",
        showBar: true,
      };
    }
    const session = confluenceSessionWindow(sessionName);
    const minutes = zonedTimeMinutes(new Date(), "Europe/London");
    if (minutes >= session.endMinute) {
      return {
        label: "Session-ready",
        tone: "forecast",
        icon: "check",
        note: "Today's matching session window has completed; this forecast uses session-specific data.",
        showBar: true,
      };
    }
    if (minutes < session.startMinute) {
      return {
        label: "Early",
        tone: "provisional",
        icon: "alert",
        note: "Today's matching session has not started yet, so this forecast is early.",
        showBar: true,
      };
    }
    return {
      label: "Provisional",
      tone: "provisional",
      icon: "alert",
      note: "Today's matching session is still in progress, so this forecast is provisional.",
      showBar: true,
    };
  }
  const todayDate = tradingDates?.current || currentCmeTradingDateKey();
  if (row.dateKey !== todayDate) {
    return {
      label: row.snapshot ? "Complete" : "Missing",
      tone: row.snapshot ? "complete" : "pending",
      icon: row.snapshot ? "check" : "clock",
      note: row.snapshot ? "Completed saved confluence snapshot." : "No completed session snapshot is available.",
      showBar: Boolean(row.snapshot),
    };
  }
  const currentLondonDate = zonedDateKey(new Date(), "Europe/London");
  if (currentLondonDate > todayDate) {
    return {
      label: "Complete",
      tone: "complete",
      icon: "check",
      note: "Trading date has ended; this uses the completed saved confluence snapshot.",
      showBar: Boolean(row.snapshot),
    };
  }
  const minutes = zonedTimeMinutes(new Date(), "Europe/London");
  const session = confluenceSessionWindow(sessionName);
  if (minutes < session.startMinute) {
    return {
      label: "Pending",
      tone: "pending",
      icon: "clock",
      note: "Session has not started; awaiting session bars.",
      showBar: false,
    };
  }
  if (minutes < session.endMinute) {
    return {
      label: "Partial",
      tone: "partial",
      icon: "clock",
      note: "Session is in progress; this uses the latest available confluence.",
      showBar: Boolean(row.snapshot),
    };
  }
  return {
    label: "Complete",
    tone: "complete",
    icon: "check",
    note: "Session window has completed.",
    showBar: Boolean(row.snapshot),
  };
}

function confluenceStatusIcon(type) {
  const icons = {
    check: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.3 4.2 6.7 11 3.1 7.5"/></svg>',
    clock: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M8 4.8V8l2.2 1.4"/></svg>',
    alert: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.4 14 13H2L8 2.4Z"/><path d="M8 6.2v3.2M8 11.6h.01"/></svg>',
    arrow: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h9M8.8 4.8 12 8l-3.2 3.2"/></svg>',
  };
  return icons[type] || icons.clock;
}

function renderConfluenceStatusChip(status) {
  return `
    <span class="confluence-status-chip ${escapeHtml(status.tone || "pending")}">
      ${confluenceStatusIcon(status.icon)}
      ${escapeHtml(status.label || "Pending")}
    </span>
  `;
}

function renderCompactStanceBar(label, stance) {
  if (!stance) {
    return `
      <div class="confluence-session-bar pending" role="img" aria-label="${escapeHtml(label)} pending">
        <span class="stance-pending" style="width:100%"><b>Pending</b><em>n/a</em></span>
      </div>
    `;
  }
  const bearish = Math.max(4, stance.percentages.bearish);
  const range = Math.max(4, stance.percentages.range);
  const bullish = Math.max(4, stance.percentages.bullish);
  const scale = 100 / (bearish + range + bullish);
  return `
    <div class="confluence-session-bar" role="img" aria-label="${escapeHtml(label)} bearish ${stance.percentages.bearish.toFixed(1)} percent, ranging ${stance.percentages.range.toFixed(1)} percent, bullish ${stance.percentages.bullish.toFixed(1)} percent">
      <span class="stance-bearish" style="width:${(bearish * scale).toFixed(2)}%"><b>Bear</b><em>${stance.percentages.bearish.toFixed(0)}%</em></span>
      <span class="stance-range" style="width:${(range * scale).toFixed(2)}%"><b>Range</b><em>${stance.percentages.range.toFixed(0)}%</em></span>
      <span class="stance-bullish" style="width:${(bullish * scale).toFixed(2)}%"><b>Bull</b><em>${stance.percentages.bullish.toFixed(0)}%</em></span>
    </div>
  `;
}

function renderConfluenceSessionForecastCards(report, markovPayload, history = [], yesterdayForecast = null, tradingDates = null) {
  const rows = confluenceSessionActualForecastRows({ report, markovPayload, history, yesterdayForecast, tradingDates });
  const sessions = ["Asian", "London", "US"];
  return `
    <div class="confluence-session-forecast-block" aria-label="Session-weighted actual confluence and tomorrow forecast">
      <div class="confluence-session-forecast-intro">
        <strong>Session-weighted actuals and forecasts</strong>
        <span>Status chips show whether each session read is complete, partial, pending, or provisional.</span>
      </div>
      <div class="confluence-session-forecast-grid">
        ${sessions.map((sessionName) => {
          const profile = confluenceSessionProfile(sessionName);
          const todayRow = rows.find((row) => row.label === "Today");
          const todayStatus = todayRow
            ? confluenceRowStatus(todayRow, sessionName, tradingDates)
            : { label: "Pending", tone: "pending", icon: "clock" };
          return `
            <article class="confluence-session-forecast-card">
              <div class="confluence-session-card-head">
                <div>
                  <h4>${escapeHtml(profile.label)}</h4>
                  <p>${escapeHtml(profile.note)}</p>
                </div>
                ${renderConfluenceStatusChip(todayStatus)}
              </div>
              <div class="confluence-session-forecast-rows">
                ${rows.map((row) => {
                  const status = confluenceRowStatus(row, sessionName, tradingDates);
                  const stance = row.snapshot
                    ? row.kind === "prediction"
                      ? confluenceSessionTomorrowStanceSummary(row.snapshot.prediction, { summary: row.snapshot.markovSummary }, sessionName)
                      : confluenceSessionStanceSummary(row.snapshot.prediction, sessionName)
                    : null;
                  const visibleStance = status.showBar ? stance : null;
                  const sourceText = row.kind === "prediction"
                    ? row.snapshot
                      ? `${shortTradingDateLabel(row.sourceDate)} -> ${shortTradingDateLabel(row.dateKey)}`
                      : `${shortTradingDateLabel(row.sourceDate)} -> ${shortTradingDateLabel(row.dateKey)} missing`
                    : row.snapshot
                    ? `${shortTradingDateLabel(row.dateKey)} actual`
                    : `${shortTradingDateLabel(row.dateKey)} actual missing`;
                  return `
                    <div class="confluence-session-forecast-row">
                      <div class="confluence-session-row-label">
                        <strong>${escapeHtml(row.label)} ${renderConfluenceStatusChip(status)}</strong>
                        <span>${escapeHtml(row.detail)}</span>
                        <em>${escapeHtml(sourceText)}</em>
                      </div>
                      <div class="confluence-session-row-reading">
                        ${renderCompactStanceBar(`${profile.label} ${row.label}`, visibleStance)}
                        ${(status.tone === "pending" || status.tone === "partial" || status.tone === "provisional")
                          ? `<p>${escapeHtml(status.note)}</p>`
                          : ""}
                      </div>
                    </div>
                  `;
                }).join("")}
              </div>
            </article>
          `;
        }).join("")}
      </div>
    </div>
  `;
}

function accuracyPercentDisplay(value) {
  if (value === null || value === undefined || value === "") return "n/a";
  const number = Number(value);
  if (!Number.isFinite(number)) return formatMaybeNull(value);
  return formatPercent(Math.abs(number) > 1 ? number / 100 : number);
}

function accuracyErrorDisplay(value) {
  if (value === null || value === undefined || value === "") return "n/a";
  const number = Number(value);
  if (!Number.isFinite(number)) return formatMaybeNull(value);
  return `${Math.abs(number) > 1 ? number.toFixed(1) : (number * 100).toFixed(1)}%`;
}

function learnerHitRateDisplay(session) {
  const samples = Number(session?.samples ?? session?.sampleSize);
  const status = String(session?.status || session?.sampleStatus || "").toLowerCase();
  if (!Number.isFinite(samples) || samples < 5 || status.includes("unproven")) {
    return samples ? `provisional (${samples} sample${samples === 1 ? "" : "s"})` : "n/a";
  }
  return accuracyPercentDisplay(session?.hitRate ?? session?.accuracy);
}

function confluenceAccuracyStatusTone(status) {
  const text = String(status || "").toLowerCase();
  if (text.includes("reliable") || text.includes("usable") || text.includes("strong")) return "good";
  if (text.includes("weak") || text.includes("poor") || text.includes("miss")) return "bad";
  if (text.includes("watch") || text.includes("mixed")) return "warn";
  return "neutral";
}

function confluenceLearnerSessionRows(learner, accuracy) {
  const sessions = ["Asian", "London", "US"];
  const fromLearner = Array.isArray(learner?.sessions) ? learner.sessions : [];
  const fromAccuracy = Array.isArray(accuracy?.sessions) ? accuracy.sessions : [];
  return sessions.map((sessionName) => ({
    session: sessionName,
    ...(fromAccuracy.find((row) => row?.session === sessionName || row?.name === sessionName) || {}),
    ...(fromLearner.find((row) => row?.session === sessionName || row?.name === sessionName) || {}),
  }));
}

function confluenceWeakestSessionLabel(sessions) {
  const ranked = sessions
    .filter((session) => Number.isFinite(Number(session.avgErrorPct ?? session.averageErrorPct ?? session.meanAbsoluteError)))
    .sort((a, b) => Number(b.avgErrorPct ?? b.averageErrorPct ?? b.meanAbsoluteError) - Number(a.avgErrorPct ?? a.averageErrorPct ?? a.meanAbsoluteError));
  return ranked[0]?.session || ranked[0]?.name || "n/a";
}

function confluenceLearnerResultTone(value) {
  const text = String(value || "").toLowerCase();
  if (text.includes("hit")) return "good";
  if (text.includes("near")) return "warn";
  if (text.includes("miss") || text.includes("weak")) return "bad";
  return "neutral";
}

function renderConfluenceLearnerBar(record, kind) {
  const percentages = kind === "actual" ? record?.actualPercentages : record?.forecastPercentages;
  if (!percentages) {
    return `
      <div class="confluence-session-bar pending" role="img" aria-label="${escapeHtml(kind)} percentages unavailable">
        <span class="stance-pending" style="width:100%"><b>${escapeHtml(kind)}</b><em>n/a</em></span>
      </div>
    `;
  }
  const bearish = Math.max(4, Number(percentages.bearish) || 0);
  const range = Math.max(4, Number(percentages.range) || 0);
  const bullish = Math.max(4, Number(percentages.bullish) || 0);
  const scale = 100 / (bearish + range + bullish);
  return `
    <div class="confluence-session-bar learner" role="img" aria-label="${escapeHtml(kind)} bearish ${Number(percentages.bearish || 0).toFixed(1)} percent, ranging ${Number(percentages.range || 0).toFixed(1)} percent, bullish ${Number(percentages.bullish || 0).toFixed(1)} percent">
      <span class="stance-bearish" style="width:${(bearish * scale).toFixed(2)}%"><b>Bear</b><em>${Number(percentages.bearish || 0).toFixed(0)}%</em></span>
      <span class="stance-range" style="width:${(range * scale).toFixed(2)}%"><b>Range</b><em>${Number(percentages.range || 0).toFixed(0)}%</em></span>
      <span class="stance-bullish" style="width:${(bullish * scale).toFixed(2)}%"><b>Bull</b><em>${Number(percentages.bullish || 0).toFixed(0)}%</em></span>
    </div>
  `;
}

function latestConfluenceRecordForSession(records, sessionName) {
  return records
    .filter((record) => record?.session === sessionName)
    .sort((a, b) => String(b.actualDateKey || "").localeCompare(String(a.actualDateKey || "")))[0] || null;
}

function renderConfluencePerSessionLearner(accuracy, learner = null, sourcePath = null, learnerPath = null) {
  const routineLabel = "Daily Confluence forecast accuracy audit";
  if ((!accuracy || typeof accuracy !== "object") && (!learner || typeof learner !== "object")) {
    return `
      <div class="confluence-accuracy-card pending">
        <div class="confluence-accuracy-head">
          <div>
            <h3>Forecast Accuracy</h3>
            <p>Awaiting the first Hermes Strategy Learner accuracy audit.</p>
          </div>
          <span>Pending</span>
        </div>
        <div class="confluence-accuracy-empty">
          <strong>Hermes will update this after each scheduled calculation.</strong>
          <span>Routine: ${escapeHtml(routineLabel)}. Schedule: weeknights 23:30 Europe/London after the Confluence refresh.</span>
          <em>Expected artifact: ${escapeHtml(sourcePath || "confluence_forecast_accuracy.json")}</em>
        </div>
      </div>
    `;
  }

  const generatedAtUtc = accuracy?.generatedAtUtc || learner?.generatedAtUtc || learner?.updatedAtUtc;
  const generated = generatedAtUtc
    ? new Date(generatedAtUtc).toLocaleString("en-GB", { timeZone: "Europe/London" })
    : "time n/a";
  const sessions = confluenceLearnerSessionRows(learner, accuracy);
  const methods = Array.isArray(accuracy?.methods) ? accuracy.methods : [];
  const allRecords = Array.isArray(learner?.records) ? learner.records : [];
  const recentRecords = Array.isArray(accuracy?.recentSessionRecords) ? accuracy.recentSessionRecords : allRecords.slice(-9).reverse();
  const headlineStatus = accuracy?.sampleStatus || accuracy?.status || accuracy?.reliability || "unproven";
  const latestRef = accuracy?.latestIssueIdentifier || accuracy?.latestIssue || accuracy?.routineIssueIdentifier || accuracy?.routineId || "Hermes audit";
  const learnerUpdatedUtc = accuracy?.learnerUpdatedAtUtc || learner?.updatedAtUtc;
  const learnerUpdated = learnerUpdatedUtc
    ? new Date(learnerUpdatedUtc).toLocaleString("en-GB", { timeZone: "Europe/London" })
    : null;
  const totalSamples = accuracy?.samples ?? accuracy?.sampleSize ?? learner?.recordCount ?? sessions.reduce((sum, session) => sum + (Number(session.samples) || 0), 0);
  const sessionHits = sessions.reduce((sum, session) => sum + Math.round((Number(session.hitRate) || 0) * (Number(session.samples) || 0)), 0);
  const sessionSamples = sessions.reduce((sum, session) => sum + (Number(session.samples) || 0), 0);
  const fullDayHitRate = accuracy?.fullDay?.hitRate ?? accuracy?.overallHitRate ?? (sessionSamples ? sessionHits / sessionSamples : null);
  const weakestSession = confluenceWeakestSessionLabel(sessions);
  return `
    <div class="confluence-learner-shell">
      <div class="confluence-accuracy-head">
        <div>
          <h3>Per-Session Accuracy Learner</h3>
          <p>Persisted learner values split Asian, London, and US as separate populations; full-day is only a secondary roll-up.</p>
        </div>
        <span class="${escapeHtml(confluenceAccuracyStatusTone(headlineStatus))}">${escapeHtml(headlineStatus)}</span>
      </div>
      <div class="confluence-accuracy-meta">
        <span>Updated: <strong>${escapeHtml(generated)} UK</strong></span>
        <span>Source: <strong>${escapeHtml(latestRef)}</strong></span>
        <span>Samples: <strong>${escapeHtml(totalSamples ?? "n/a")}</strong></span>
        ${learnerUpdated ? `<span>Learner: <strong>${escapeHtml(learnerUpdated)} UK</strong></span>` : ""}
      </div>
      <div class="confluence-learner-grid">
        ${sessions.map((session) => {
          const sessionName = session.session || session.name || "Session";
          const latestRecord = latestConfluenceRecordForSession(allRecords, sessionName);
          return `
          <article class="confluence-learner-session ${escapeHtml(confluenceAccuracyStatusTone(session.status || session.sampleStatus))}">
            <header>
              <div>
                <h4>${escapeHtml(sessionName)}</h4>
                <p>${escapeHtml(confluenceSessionProfile(sessionName).note || "Session-specific learner population.")}</p>
              </div>
              <span class="${escapeHtml(confluenceAccuracyStatusTone(session.status || session.sampleStatus))}">${escapeHtml(session.status || session.sampleStatus || "unproven")}</span>
            </header>
            <dl>
              <dt>Hit rate</dt><dd>${escapeHtml(learnerHitRateDisplay(session))}</dd>
              <dt>Avg error</dt><dd>${escapeHtml(accuracyErrorDisplay(session.avgErrorPct ?? session.averageErrorPct ?? session.meanAbsoluteError))}</dd>
              <dt>Samples</dt><dd>${escapeHtml(session.samples ?? session.sampleSize ?? "n/a")}</dd>
              <dt>Near misses</dt><dd>${escapeHtml(session.nearMisses ?? "n/a")}</dd>
              <dt>Latest</dt><dd>${escapeHtml(session.latestResult || session.latest || "n/a")}</dd>
            </dl>
            ${latestRecord ? `
              <div class="confluence-learner-latest">
                <div>
                  <strong>${escapeHtml(latestRecord.actualDateKey || "n/a")}</strong>
                  <span class="${escapeHtml(confluenceLearnerResultTone(latestRecord.result))}">${escapeHtml(latestRecord.result || "n/a")}</span>
                </div>
                <p>${escapeHtml(latestRecord.forecastDominant || "n/a")} forecast vs ${escapeHtml(latestRecord.actualDominant || "n/a")} actual; error ${escapeHtml(accuracyErrorDisplay(latestRecord.errorPct))}</p>
                ${renderConfluenceLearnerBar(latestRecord, "forecast")}
                ${renderConfluenceLearnerBar(latestRecord, "actual")}
              </div>
            ` : `<p class="empty">No persisted samples for this session yet.</p>`}
          </article>
        `;
        }).join("")}
      </div>
      <div class="confluence-learner-rollup">
        <strong>Full-day secondary roll-up</strong>
        <span>Hit rate ${escapeHtml(sessionSamples < 15 ? `provisional (${sessionSamples} samples)` : accuracyPercentDisplay(fullDayHitRate))}; weakest primary session ${escapeHtml(weakestSession)}.</span>
      </div>
      ${methods.length ? `
        <div class="confluence-accuracy-methods">
          <strong>Persisted method contribution</strong>
          ${renderGenericTable(methods.slice(0, 8).map((method) => ({
            Method: method.method || method.system || "n/a",
            Impact: method.impact || method.recommendation || method.status || "n/a",
            Accuracy: accuracyPercentDisplay(method.hitRate ?? method.accuracy),
            Samples: method.samples ?? method.sampleSize ?? "n/a",
            "Actual days": method.actualDaySamples ?? "n/a",
            Note: method.note || method.reason || "",
          })))}
        </div>
      ` : ""}
      ${recentRecords.length ? `
        <div class="confluence-accuracy-methods">
          <strong>Recent persisted learner samples</strong>
          ${renderGenericTable(recentRecords.map((record) => ({
            Session: record.session || "n/a",
            Actual: record.actualDateKey || "n/a",
            Forecast: record.forecastSourceDateKey ? `${record.forecastSourceDateKey} -> ${record.actualDateKey || "n/a"}` : "n/a",
            Result: record.result || "n/a",
            "Forecast read": record.forecastDominant || "n/a",
            "Actual read": record.actualDominant || "n/a",
            Error: accuracyErrorDisplay(record.errorPct),
          })))}
        </div>
      ` : ""}
      <p class="section-note">${escapeHtml(accuracy?.recommendation || accuracy?.summary || learner?.note || "Hermes has not published a recommendation yet.")}</p>
      <div class="confluence-learner-source">
        <strong>Source and audit metadata</strong>
        ${keyValueTable([
          ["Accuracy artifact", sourcePath || "n/a"],
          ["Learner state", learnerPath || sourcePath?.replace(/confluence_forecast_accuracy\.json$/, "confluence_session_accuracy_learner.json") || "n/a"],
          ["History source", learner?.sourceHistoryFile || "n/a"],
          ["Learner id", learner?.learnerId || accuracy?.learnerId || "n/a"],
          ["Record count", learner?.recordCount ?? recentRecords.length ?? "n/a"],
        ])}
      </div>
    </div>
  `;
}

function renderSingleStanceBar(label, stance) {
  const bearish = Math.max(4, stance.percentages.bearish);
  const range = Math.max(4, stance.percentages.range);
  const bullish = Math.max(4, stance.percentages.bullish);
  const scale = 100 / (bearish + range + bullish);
  const contradictionText = stance.contradiction
    ? "Bearish and bullish reads are both materially present, so the headline should be treated as contested."
    : stance.contention
      ? "No single state has clear control yet; treat this as a mixed market read."
      : `Dominant read: ${stance.dominant}.`;
  return `
    <div class="confluence-stance-row">
      <div class="confluence-stance-label">
        <strong>${escapeHtml(label)}</strong>
        <span>${escapeHtml(contradictionText)}</span>
      </div>
      <div class="confluence-stance-bar" role="img" aria-label="${escapeHtml(label)} bearish ${stance.percentages.bearish.toFixed(1)} percent, ranging ${stance.percentages.range.toFixed(1)} percent, bullish ${stance.percentages.bullish.toFixed(1)} percent">
        <span class="stance-bearish" style="width:${(bearish * scale).toFixed(2)}%"><b>Bearish</b><em>${stance.percentages.bearish.toFixed(1)}%</em></span>
        <span class="stance-range" style="width:${(range * scale).toFixed(2)}%"><b>Ranging</b><em>${stance.percentages.range.toFixed(1)}%</em></span>
        <span class="stance-bullish" style="width:${(bullish * scale).toFixed(2)}%"><b>Bullish</b><em>${stance.percentages.bullish.toFixed(1)}%</em></span>
      </div>
    </div>
  `;
}

function renderPendingStanceBar(label, message) {
  return `
    <div class="confluence-stance-row">
      <div class="confluence-stance-label">
        <strong>${escapeHtml(label)}</strong>
        <span>${escapeHtml(message)}</span>
      </div>
      <div class="confluence-stance-bar pending" role="img" aria-label="${escapeHtml(label)} pending">
        <span class="stance-pending" style="width:100%"><b>Awaiting saved snapshot</b><em>n/a</em></span>
      </div>
    </div>
  `;
}

function renderConfluenceStanceBar(report, markovPayload, history = [], yesterdayForecast = null, calculatedAtUtc = null, tradingDates = null, forecastAccuracy = null, forecastAccuracySource = null, sessionLearner = null, sessionLearnerSource = null) {
  const tomorrowForecast = confluenceTomorrowStanceSummary(report, markovPayload);
  return `
    <div class="confluence-stance-card" aria-label="Confluence market stance">
      <div class="confluence-stance-head">
        <div>
          <h3>Session Stance</h3>
          <p>Asian, London, and US session actuals and forecasts are the primary confluence view.</p>
        </div>
        <strong>${escapeHtml(tomorrowForecast.basis || "")}</strong>
      </div>
      ${renderConfluenceSessionForecastCards(report, markovPayload, history, yesterdayForecast, tradingDates)}
      ${renderConfluencePerSessionLearner(forecastAccuracy, sessionLearner, forecastAccuracySource, sessionLearnerSource)}
    </div>
  `;
}

function renderConfluenceTimeframeMatrix(report) {
  const rows = report?.rows || [];
  const byKey = confluenceRowMap(report);
  const timeframes = [...new Set(rows.map((row) => row.timeframe))]
    .filter((timeframe) => ["5m", "15m", "60m", "daily", "weekly"].includes(timeframe))
    .sort((a, b) => confluenceTimeframeOrder(a) - confluenceTimeframeOrder(b));
  const tableRows = timeframes.map((timeframe) => {
    const confluence = byKey.get(`${timeframe}|Confluence engine`);
    const markov = byKey.get(`${timeframe}|Markov regime`);
    return {
      Timeframe: timeframe === "60m" ? "1h" : timeframe,
      Layer: rows.find((row) => row.timeframe === timeframe)?.layer || "n/a",
      "Combined read": confluenceCell(confluence),
      "Trade signal": confluence?.summary || "n/a",
      "Markov/regime": markov?.summary || "n/a",
      Trend: confluenceCell(byKey.get(`${timeframe}|Trend/Momentum`)),
      "Mean reversion": confluenceCell(byKey.get(`${timeframe}|Mean Reversion`)),
      Volume: confluenceCell(byKey.get(`${timeframe}|Volume/Order Flow`)),
    };
  });
  return tableRows.length ? renderGenericTable(tableRows) : '<p class="empty">No confluence timeframe rows are available yet.</p>';
}

function renderConfluenceModelMatrix(report) {
  const rows = report?.rows || [];
  const systems = [
    "Volatility",
    "Trend/Momentum",
    "Mean Reversion",
    "Factor/Regression",
    "Volume/Order Flow",
    "Confluence engine",
    "Markov regime",
  ];
  const byKey = confluenceRowMap(report);
  const timeframes = ["5m", "15m", "60m", "daily", "weekly"];
  return renderGenericTable(systems.map((system) => {
    const row = { System: system };
    for (const timeframe of timeframes) {
      row[timeframe === "60m" ? "1h" : timeframe] = confluenceCell(byKey.get(`${timeframe}|${system}`));
    }
    return row;
  }));
}

function renderConfluenceCoverage(report) {
  const rows = (report?.coverage || [])
    .filter((item) => [5, 15, 60, 1440].includes(Number(item.timeframeMinutes)))
    .map((item) => ({
      Timeframe: item.timeframeMinutes === 60 ? "1h" : item.timeframeMinutes === 1440 ? "Daily" : `${item.timeframeMinutes}m`,
      From: item.from,
      To: item.to,
      Bars: Number(item.bars || 0).toLocaleString("en-GB"),
      "Last bar": item.lastUtc || "n/a",
    }));
  if (report?.rows?.some((row) => row.timeframe === "weekly")) {
    rows.push({
      Timeframe: "Weekly",
      From: report.coverage?.find((item) => Number(item.timeframeMinutes) === 1440)?.from || "n/a",
      To: report.coverage?.find((item) => Number(item.timeframeMinutes) === 1440)?.to || "n/a",
      Bars: "Aggregated from daily",
      "Last bar": report.coverage?.find((item) => Number(item.timeframeMinutes) === 1440)?.lastUtc || "n/a",
    });
  }
  return rows.length ? renderGenericTable(rows) : '<p class="empty">No cache coverage is available yet.</p>';
}

function renderWalkForwardSummary(walkForward) {
  if (!walkForward?.outcome) return '<p class="empty">No walk-forward validation artifact is available yet.</p>';
  const outcome = walkForward.outcome;
  const accuracyRows = (walkForward.comboAccuracy || walkForward.combinationAccuracy || walkForward.comboStudy || [])
    .slice(0, 8)
    .map((row) => ({
      Combination: row.name || row.combo || row.combination || "n/a",
      Accuracy: row.accuracy === undefined ? "n/a" : formatPercent(row.accuracy),
      Samples: row.samples ?? row.count ?? "n/a",
      Note: row.note || row.result || "",
    }));
  return `
    ${keyValueTable([
      ["Anchor", walkForward.anchor || "n/a"],
      ["Checked week", outcome.dateRange || outcome.week || "n/a"],
      ["Actual result", `${outcome.actualDirection || "n/a"} (${scoreDisplay(outcome.returnPct)}%)`],
      ["Open / close", `${outcome.open ?? "n/a"} / ${outcome.close ?? "n/a"}`],
    ])}
    ${accuracyRows.length ? renderGenericTable(accuracyRows) : '<p class="section-note">The latest validation showed the best practical adjustment was to downgrade bullish reads to flat/wait when higher timeframes are overbought.</p>'}
  `;
}

function renderConfluenceReportPage(payload) {
  const report = payload?.prediction || {};
  const markovPayload = payload?.markov || {};
  const dataStatus = report.dataStatus || {};
  const tradingDates = confluenceTradingDates(payload);
  const overall = report.overall || {};
  const generated = report.generatedAtUtc || payload?.generatedAtUtc;
  const systems = [...new Set((report.rows || []).map((row) => row.system))];
  const timeframes = [...new Set((report.rows || []).map((row) => row.timeframe))]
    .map((timeframe) => timeframe === "60m" ? "1h" : timeframe)
    .join(", ");
  const summary = markovPayload.summary || {};
  const current = summary.currentRegime || {};
  const forecast = forecastNextRegime(summary);
  const bestForecast = forecast[0];
  const currentRisks = markovRiskFactors(summary);
  const dataStatusTitle = dataStatus.status === "partial" ? "Confluence data partial" : "Confluence data unavailable";
  const dataStatusWarning = dataStatus.status && dataStatus.status !== "available"
    ? `
      <div class="confluence-status-strip" role="status">
        <strong>${escapeHtml(dataStatusTitle)}</strong>
        <span>${escapeHtml(dataStatus.message || "No current market data is available for this calculation.")}</span>
        <small>${escapeHtml(dataStatus.symbol || "n/a")} | ${escapeHtml(dataStatus.requestedDate || "n/a")} | latest ${escapeHtml(dataStatus.latestAvailableDate || "none")}</small>
      </div>
    `
    : "";
  return `
    <div class="markov-shell">
      <aside class="side-menu" aria-label="Confluence navigation">
        <a href="#confluence-overview">Overview</a>
        <a href="#confluence-timeframes">Timeframes</a>
        <a href="#confluence-models">Model Families</a>
        <a href="#confluence-sessions">Sessions</a>
        <a href="#confluence-learner">Learner</a>
        <a href="#confluence-risk">Risk Guide</a>
        <a href="#confluence-validation">Validation</a>
        <a href="#confluence-source">Source</a>
      </aside>
      <div class="markov-content">
        <section class="panel" id="confluence-overview">
          <div class="section-head">
            <div>
              <h2>Confluence Report</h2>
              <p>Compact market-state read across model families and timeframes. This is context for strategies, not a standalone trade signal.</p>
            </div>
            <button class="button-link" type="button" data-confluence-rebuild>Recalculate from Sierra data</button>
          </div>
          ${dataStatusWarning}
          ${renderConfluenceStanceBar(report, markovPayload, payload?.history || [], payload?.yesterdayForecast || null, payload?.generatedAtUtc || null, tradingDates, payload?.forecastAccuracy || null, payload?.sources?.forecastAccuracy || null, payload?.sessionLearner || null, payload?.sources?.sessionAccuracyLearner || null)}
          <div class="summary-grid markov-at-glance">
            ${summaryTile("Overall bias", overall.bias || "n/a", String(overall.bias || "").includes("bearish") ? "warn" : "good")}
            ${summaryTile("Net bias score", scoreDisplay(overall.netBiasScore))}
            ${summaryTile("Systems", systems.length || "n/a")}
            ${summaryTile("Timeframes", timeframes || "n/a")}
            ${summaryTile("Current regime", current.label || "n/a")}
            ${summaryTile("Regime confidence", confidenceDisplay(current.confidence))}
            ${summaryTile("Forecast lead", bestForecast ? `${bestForecast[0]} (${(bestForecast[1] * 100).toFixed(1)}%)` : "n/a")}
            ${summaryTile("Last generated", generated ? new Date(generated).toLocaleString("en-GB", { timeZone: "Europe/London" }) : "n/a")}
          </div>
          ${keyValueTable([
            ["How to read this", "Use daily/weekly for context, hourly for bias, 15m for setup, and 5m for execution timing."],
            ["Current note", overall.note || report.note || "n/a"],
            ["Risk overlay", `Long ${currentRisks.long}, short ${currentRisks.short}, range ${currentRisks.range}`],
          ])}
          <p class="section-note" data-confluence-status></p>
        </section>
        <section class="panel priority-panel" id="confluence-timeframes">
          <h2>Timeframe Decision Matrix</h2>
          <p class="section-note">One compact row per timeframe. The combined read shows the weighted confluence engine; Markov/regime is shown as the market-state overlay.</p>
          ${renderConfluenceTimeframeMatrix(report)}
        </section>
        <section class="panel" id="confluence-models">
          <h2>Model Family Matrix</h2>
          <p class="section-note">Each cell shows bias plus numeric score where the model exposes one. Markov uses regime confidence rather than a directional score.</p>
          ${renderConfluenceModelMatrix(report)}
        </section>
        <section class="panel" id="confluence-sessions">
          <h2>Session Risk Matrix</h2>
          <p class="section-note">Asian, London, and US readings use the latest available UK-time session bars from the regime engine.</p>
          ${renderMarkovSessionRiskTable(markovPayload)}
        </section>
        <section class="panel priority-panel" id="confluence-learner">
          <h2>Quant Method Accuracy Learner</h2>
          <p class="section-note">The learner section above is sourced from persisted JSON artifacts only. Browser code formats stored values and does not recompute hit rates, errors, or method accuracy.</p>
          ${keyValueTable([
            ["Approved mockup", "dashboard/confluence-per-session-learner-approval-mockup-2026-06-03.png"],
            ["Approval gate", "OCE-650 approval interaction 8da58fed-aadc-46df-9c84-a04e62638f79 accepted at 2026-06-03T11:27:35Z"],
            ["Primary populations", "Asian, London, US"],
            ["Secondary roll-up", "Full-day summary is shown only after the session rows and names the weakest primary session."],
          ])}
        </section>
        <section class="panel" id="confluence-risk">
          <h2>Risk Factor Guide</h2>
          ${renderGenericTable([
            { "Risk factor": "0.25", "Meaning": "Poor/blocked conditions", "Use": "Avoid or tiny size" },
            { "Risk factor": "0.50", "Meaning": "Weak or conflicting conditions", "Use": "Half risk or require extra confirmation" },
            { "Risk factor": "1.00", "Meaning": "Normal conditions", "Use": "Standard configured risk" },
            { "Risk factor": "1.25", "Meaning": "Favourable alignment", "Use": "Only increase risk if account and prop rules permit" },
          ])}
        </section>
        <section class="panel" id="confluence-validation">
          <h2>Recent Walk-Forward Check</h2>
          ${renderWalkForwardSummary(payload?.walkForward)}
        </section>
        <section class="panel" id="confluence-source">
          <h2>Source And Cache</h2>
          ${renderConfluenceCoverage(report)}
          ${keyValueTable([
            ["Prediction report", payload?.sources?.predictionReport || "n/a"],
            ["Walk-forward study", payload?.sources?.walkForwardStudy || "n/a"],
            ["Forecast accuracy", payload?.sources?.forecastAccuracy || "n/a"],
            ["Cody Cache", payload?.sources?.cacheDb || "n/a"],
            ["Regime engine", payload?.sources?.regimeEngine || "n/a"],
            ["Scope lock", payload?.scope?.notes?.[0] || "Confluence-only consumer"],
          ])}
        </section>
      </div>
    </div>
  `;
}

function renderMarkovRegimePage(payload) {
  if (!payload?.ok || !payload.summary) {
    return `<p class="empty">Markov Regime Engine output is not available yet. Use the refresh button to build it from Cody Cache.</p>`;
  }
  const summary = payload.summary;
  const current = summary.currentRegime || {};
  const source = summary.source || {};
  const forecast = forecastNextRegime(summary);
  const bestForecast = forecast[0];
  const currentRisks = markovRiskFactors(summary);
  const strategyRows = (summary.strategyPerformanceByRegime || []).flatMap((strategy) =>
    (strategy.regimes || []).map((row) => ({
      Strategy: strategy.strategy,
      Source: strategy.source,
      Regime: row.regime,
      Trades: row.trades,
      "Win rate": formatPercent(row.winRate),
      "Net P&L": formatCurrency(row.netPnlDollars),
    })),
  );
  return `
    <div class="markov-shell">
      <aside class="side-menu" aria-label="Markov navigation">
        <a href="#markov-overview">Overview</a>
        <a href="#markov-timeframes">Timeframes</a>
        <a href="#markov-sessions">Sessions</a>
        <a href="#markov-probabilities">Probabilities</a>
        <a href="#markov-risk">Risk Factor</a>
        <a href="#markov-forecast">Tomorrow</a>
        <a href="#markov-strategies">Strategies</a>
        <a href="#markov-source">Source</a>
      </aside>
      <div class="markov-content">
        <section class="panel" id="markov-overview">
          <div class="section-head">
            <div>
              <h2>Markov Regime Engine</h2>
              <p>Read this as a market-context and risk overlay. The strategy still has to create the trade signal.</p>
            </div>
            <button class="button-link" type="button" data-markov-rebuild>Refresh cache + rebuild prediction</button>
          </div>
          <div class="summary-grid markov-at-glance">
            ${summaryTile("Current regime", current.label || "n/a", current.bias === "bearish" ? "warn" : "good")}
            ${summaryTile("Confidence", current.confidence === undefined ? "n/a" : formatPercent(current.confidence))}
            ${summaryTile("Forecast lead", bestForecast ? `${bestForecast[0]} (${(bestForecast[1] * 100).toFixed(1)}%)` : "n/a")}
            ${summaryTile("Last cached bar", source.coverage?.lastBarKey || "n/a")}
            ${summaryTile("Long risk", currentRisks.long)}
            ${summaryTile("Short risk", currentRisks.short)}
            ${summaryTile("Range risk", currentRisks.range)}
          </div>
          ${keyValueTable([
            ["Recommendation", summary.recommendation?.note || "n/a"],
            ["Allow", summary.recommendation?.allow || "n/a"],
            ["Avoid", summary.recommendation?.avoid || "n/a"],
            ["Model", `${summary.model?.type || "n/a"} - ${summary.model?.style || "n/a"}`],
          ])}
          <p class="section-note" data-markov-status></p>
        </section>
        <section class="panel" id="markov-timeframes">
          <h2>Multi-Timeframe Regime Risk</h2>
          <p class="section-note">Daily, hourly, 15-minute, and 5-minute regimes can disagree. Use higher timeframes for context and lower timeframes for execution timing.</p>
          ${renderMarkovMultiTimeframeTable(payload)}
        </section>
        <section class="panel priority-panel" id="markov-sessions">
          <h2>Session Risk Matrix</h2>
          <p class="section-note">Latest available UK-time session reading for Asian, London, and US sessions. Daily is shown as whole-day context for each session.</p>
          ${renderMarkovSessionRiskTable(payload)}
        </section>
        <section class="panel" id="markov-probabilities">
          <h2>Current Regime Probabilities</h2>
          ${renderRegimeProbabilityBars(current.probabilities)}
        </section>
        <section class="panel" id="markov-risk">
          <h2>Risk Factor Guide</h2>
          <p class="section-note">Use this as a trade permission and sizing overlay after a strategy has produced a valid signal. It should not create entries by itself.</p>
          ${renderGenericTable([
            {
              "Risk factor": "0.25",
              "Condition": "Very poor conditions",
              "Action": "Avoid the trade or greatly reduce size",
              "Example use": "Range-fade long while Markov shows strong trend-down risk",
            },
            {
              "Risk factor": "0.50",
              "Condition": "Weak conditions",
              "Action": "Half risk or require extra confirmation",
              "Example use": "Strategy signal agrees partly, but regime switch risk is high",
            },
            {
              "Risk factor": "1.00",
              "Condition": "Normal conditions",
              "Action": "Use standard configured risk",
              "Example use": "Trade direction and strategy edge are neutral-to-aligned with regime",
            },
            {
              "Risk factor": "1.25",
              "Condition": "Favourable conditions",
              "Action": "Allow increased risk only if account and prop rules permit",
              "Example use": "Strategy historically performs well in the current regime and forecast supports continuation",
            },
          ])}
          <p class="section-note">Recommended flow: strategy signal -> Markov regime check -> risk factor -> position size / allow-block decision.</p>
        </section>
        <section class="panel" id="markov-forecast">
          <h2>Tomorrow Regime Forecast</h2>
          <p class="section-note">Probability-weighted forecast using the current regime probabilities and Markov transition matrix.</p>
          ${renderGenericTable(forecast.map(([regime, value]) => ({
            Regime: regime,
            Probability: `${(value * 100).toFixed(1)}%`,
          })))}
        </section>
        <section class="panel" id="markov-strategies">
          <h2>Strategy Performance By Regime</h2>
          ${strategyRows.length ? renderGenericTable(strategyRows) : '<p class="empty">No strategy/regime alignment is available yet.</p>'}
        </section>
        <section class="panel" id="markov-source">
          <h2>Source</h2>
          ${keyValueTable([
            ["Instrument", source.instrument || "n/a"],
            ["Symbol", source.symbol || "n/a"],
            ["Timeframe", `${source.timeframeMinutes || "n/a"} minutes`],
            ["Date range", `${source.dateFrom || "n/a"} to ${source.dateTo || "n/a"}`],
            ["Bars analysed", Number(source.barsAnalyzed || 0).toLocaleString("en-GB")],
            ["Summary file", payload.summaryFile || "n/a"],
            ["Cache DB", payload.cacheDb || "n/a"],
          ])}
        </section>
      </div>
    </div>
  `;
}

function hmmFormatNumber(value, digits = 2) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits) : "n/a";
}

function hmmFormatTicks(value, digits = 2) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(digits)} ticks` : "n/a";
}

function hmmSlug(value) {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "strategy";
}

function hmmStatusTone(status) {
  const value = String(status || "").toLowerCase();
  if (value.includes("ready") || value.includes("complete") || value.includes("passed") || value === "true") return "good";
  if (value.includes("blocked") || value.includes("disabled") || value.includes("locked") || value === "false") return "warn";
  if (value.includes("waiting") || value.includes("pending")) return "pending";
  return "neutral";
}

function hmmStatusBadge(label, status) {
  return `<span class="hmm-status ${escapeHtml(hmmStatusTone(status))}"><strong>${escapeHtml(label)}</strong>${escapeHtml(humanizeStatus(status))}</span>`;
}

const HMM_STRATEGY_DRAFT_STORAGE_KEY = "oceanTradingHmmStrategyDraft";

function loadHmmStrategyDraft() {
  try {
    return JSON.parse(window.localStorage.getItem(HMM_STRATEGY_DRAFT_STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveHmmStrategyDraft(next = {}) {
  const draft = {
    ...loadHmmStrategyDraft(),
    ...next,
    updatedAtUtc: new Date().toISOString(),
  };
  window.localStorage.setItem(HMM_STRATEGY_DRAFT_STORAGE_KEY, JSON.stringify(draft));
  return draft;
}

function renderHmmActionStatusFromDraft(draft = {}) {
  if (!draft.lastIssueUrl) return "";
  const verb = draft.lastIssueStarted ? "Started" : draft.lastIssueReused ? "Using existing" : "Created";
  return `${escapeHtml(verb)} Paperclip evaluation job <a class="text-link" href="${escapeHtml(draft.lastIssueUrl)}" target="_blank" rel="noopener">${escapeHtml(draft.lastIssueIdentifier || draft.lastIssueId || "Issue")}</a> for ${escapeHtml(draft.strategyName || "strategy")}.`;
}

function renderHmmSelectedStrategyCard(payload, strategyName) {
  const name = String(strategyName || "").trim();
  const known = (payload?.strategyIntake?.knownStrategies || []).find((item) =>
    String(item.strategyName || "").toLowerCase() === name.toLowerCase(),
  );
  if (!name) {
    return `
      <div class="hmm-selected empty-state">
        <strong>No strategy selected</strong>
        <span>Draft only</span>
      </div>
    `;
  }
  const nextStage = payload?.workflowB?.nextStage || {};
  const platform = payload?.platform || {};
  return `
    <div class="hmm-selected">
      <div>
        <span class="eyebrow">Selected strategy</span>
        <h3>${escapeHtml(name)}</h3>
        <p>${escapeHtml(known ? `Source: ${humanizeStatus(known.source)}${known.status ? ` / ${humanizeStatus(known.status)}` : ""}` : "New strategy intake candidate")}</p>
      </div>
      <div class="hmm-selected-grid">
        ${summaryTile("Strategy ID", hmmSlug(name))}
        ${summaryTile("Paperclip state", platform.strategyEvaluationActive ? "Evaluation active" : "Not active yet", platform.strategyEvaluationActive ? "good" : "warn")}
        ${summaryTile("Active strategy", platform.activeStrategyId || "None", platform.activeStrategyId ? "good" : "warn")}
        ${summaryTile("Next gate", nextStage.label || "A1 strategy instruction", nextStage.can_run_now ? "good" : "warn")}
      </div>
    </div>
  `;
}

function renderHmmIssueLink(issue) {
  if (!issue?.id && !issue?.identifier) return "n/a";
  const label = issue.identifier || issue.id;
  if (!issue.url) return escapeHtml(label);
  return `<a class="text-link" href="${escapeHtml(issue.url)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`;
}

function renderHmmEvaluationJobPanel(payload) {
  const evaluation = payload?.strategyIntake?.currentEvaluation;
  if (!evaluation) {
    return `
      <div class="hmm-evaluation-job empty-state">
        <div>
          <span class="eyebrow">Current evaluation job</span>
          <strong>No Workflow B strategy job is active yet</strong>
        </div>
        <p>Use the strategy name field and start button to create or reuse a governed Paperclip evaluation job.</p>
      </div>
    `;
  }
  const safetyLocked = !(payload?.safety?.paper_shadow_mode_enabled
    || payload?.safety?.paper_trading_allowed
    || payload?.safety?.live_trading_allowed
    || payload?.safety?.broker_orders_allowed
    || payload?.safety?.sierra_execution_changes_allowed);
  const currentIssue = evaluation.currentIssue || {};
  const parentIssue = evaluation.parentIssue || {};
  const duplicateIssue = evaluation.duplicateIssue || null;
  const statusTone = evaluation.running ? "good" : evaluation.paused ? "warn" : hmmStatusTone(evaluation.status);
  return `
    <div class="hmm-evaluation-job ${escapeHtml(statusTone)}">
      <div class="hmm-evaluation-job-head">
        <div>
          <span class="eyebrow">Current evaluation job</span>
          <h3>${escapeHtml(evaluation.strategyName || "Strategy evaluation")}</h3>
          <p>${escapeHtml(evaluation.blockerSummary || "Workflow B status is sourced from Paperclip issues.")}</p>
        </div>
        ${hmmStatusBadge("Job", evaluation.status || "n/a")}
      </div>
      <div class="hmm-evaluation-job-grid">
        ${summaryTile("Workflow phase", evaluation.phase || "Workflow B", statusTone)}
        ${summaryTile("Current issue", currentIssue.identifier || "n/a", statusTone)}
        ${summaryTile("Parent intake", parentIssue.identifier || "n/a", parentIssue.status === "blocked" ? "warn" : "neutral")}
        ${summaryTile("Trading gates", safetyLocked ? "Locked" : "Check gates", safetyLocked ? "good" : "warn")}
      </div>
      <div class="hmm-evaluation-links">
        <span>Current work: ${renderHmmIssueLink(currentIssue)} / ${escapeHtml(humanizeStatus(currentIssue.status || "n/a"))}</span>
        <span>Parent intake: ${renderHmmIssueLink(parentIssue)} / ${escapeHtml(humanizeStatus(parentIssue.status || "n/a"))}</span>
        ${duplicateIssue ? `<span>Older duplicate left alone: ${renderHmmIssueLink(duplicateIssue)} / ${escapeHtml(humanizeStatus(duplicateIssue.status || "n/a"))}</span>` : ""}
        <span>Updated: ${escapeHtml(formatTradeTimestamp(evaluation.updatedAt))}</span>
      </div>
    </div>
  `;
}

function renderHmmSafetyGrid(safety = {}) {
  const rows = [
    ["Paper trading", safety.paper_trading_allowed],
    ["Paper shadow", safety.paper_shadow_mode_enabled],
    ["Live trading", safety.live_trading_allowed],
    ["Broker orders", safety.broker_orders_allowed],
    ["Sierra execution", safety.sierra_execution_changes_allowed],
  ];
  return `
    <div class="hmm-safety-grid">
      ${rows.map(([label, allowed]) => `
        <div class="hmm-safety-item ${allowed ? "warn" : "good"}">
          <span>${escapeHtml(label)}</span>
          <strong>${allowed ? "Allowed" : "Locked"}</strong>
        </div>
      `).join("")}
    </div>
  `;
}

function renderHmmGateRecord(platform = {}) {
  return `
    <div class="hmm-gate-details">
      <h3>Gate Record</h3>
      ${keyValueTable([
        ["Project", platform.project || "n/a"],
        ["Design version", platform.designVersion || "n/a"],
        ["Current stage", `${platform.currentStageId || "n/a"} / ${platform.currentStageStatus || "n/a"}`],
        ["Previous stage", `${platform.previousStageId || "n/a"} / ${platform.previousStageStatus || "n/a"}`],
        ["Next stage", `${platform.nextStageId || "n/a"} / ${platform.nextStageStatus || "n/a"}`],
        ["First major stop point", platform.firstMajorStopPoint || "n/a"],
        ["Platform ready for strategy", platform.platformReadyForStrategy ? "true" : "false"],
        ["Active strategy id", platform.activeStrategyId || "null"],
        ["Strategy evaluation active", platform.strategyEvaluationActive ? "true" : "false"],
        ["Reviewed at", formatTradeTimestamp(platform.reviewedAtUtc)],
        ["Next required action", platform.nextRequiredAction || "n/a"],
      ])}
    </div>
  `;
}

function renderHmmFeatureFlags(flags = {}) {
  const rows = Object.entries(flags).map(([flag, enabled]) => ({
    Flag: humanizeStatus(flag),
    State: enabled ? "Enabled" : "Disabled",
  }));
  return `
    <div class="hmm-gate-details">
      <h3>Feature Flags</h3>
      ${rows.length ? renderGenericTable(rows) : '<p class="empty">No feature flags found in the current gate artifact.</p>'}
    </div>
  `;
}

function renderHmmAcceptanceChecklist(platform = {}) {
  const rows = (platform.acceptanceItems || []).map((item) => ({
    Item: item.item_id || "n/a",
    Status: item.passed ? "Passed" : "Blocked",
    Label: item.label || "n/a",
    Evidence: item.evidence || "n/a",
    Notes: item.notes || "",
    Blocking: item.blocking ? "Yes" : "No",
  }));
  return `
    <div class="hmm-gate-details">
      <h3>Acceptance Checklist</h3>
      ${rows.length ? renderGenericTable(rows) : '<p class="empty">No acceptance checklist rows found.</p>'}
    </div>
  `;
}

function renderHmmStageHistory(platform = {}) {
  const rows = (platform.stageHistory || []).map((stage) => ({
    Stage: stage.stage_id || "n/a",
    Status: stage.status || "n/a",
    Summary: stage.summary || "n/a",
  }));
  return `
    <details class="hmm-gate-details">
      <summary>Stage History</summary>
      ${rows.length ? renderGenericTable(rows) : '<p class="empty">No stage history rows found.</p>'}
    </details>
  `;
}

function renderHmmGateLists(platform = {}) {
  return `
    <div class="hmm-gate-split">
      <div class="hmm-gate-details">
        <h3>Blockers</h3>
        ${(platform.blockers || []).length ? bulletList(platform.blockers) : '<p class="section-note">No blockers recorded.</p>'}
      </div>
      <div class="hmm-gate-details">
        <h3>Data Gaps</h3>
        ${(platform.dataGaps || []).length ? bulletList(platform.dataGaps) : '<p class="section-note">No data gaps recorded.</p>'}
      </div>
    </div>
  `;
}

function renderHmmPlatformGateInformation(platform = {}, safety = {}) {
  return `
    <div class="hmm-platform-gate-stack">
      ${renderHmmGateRecord(platform)}
      <div class="hmm-gate-details">
        <h3>Safety Locks</h3>
        ${renderHmmSafetyGrid(safety)}
      </div>
      ${renderHmmGateLists(platform)}
      ${renderHmmAcceptanceChecklist(platform)}
      ${renderHmmFeatureFlags(platform.featureFlags || {})}
      ${renderHmmStageHistory(platform)}
    </div>
  `;
}

function hmmWorkflowStageNumber(stageId) {
  const match = String(stageId || "").match(/^A(\d+)/i);
  return match ? Number(match[1]) : null;
}

function hmmCurrentWorkflowStageNumbers(evaluation = {}) {
  const phase = String(evaluation.phase || "");
  return [...phase.matchAll(/A(\d+)/gi)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value));
}

function hmmWorkflowStageOverlay(stage, evaluation = {}) {
  const currentNumbers = hmmCurrentWorkflowStageNumbers(evaluation);
  if (!currentNumbers.length) return null;
  const stageNumber = hmmWorkflowStageNumber(stage.stage_id);
  if (!stageNumber) return null;

  const minCurrent = Math.min(...currentNumbers);
  const maxCurrent = Math.max(...currentNumbers);
  const issue = evaluation.currentIssue || evaluation.parentIssue || {};
  const issueStatus = String(evaluation.status || issue.status || "").toLowerCase();

  if (stageNumber < minCurrent) {
    return {
      status: "complete_from_paperclip",
      note: `Completed before ${evaluation.currentIssue?.identifier || evaluation.phase || "current issue"}`,
      issue: evaluation.parentIssue || issue,
    };
  }

  if (stageNumber >= minCurrent && stageNumber <= maxCurrent) {
    if (issueStatus === "done") {
      return {
        status: "complete_from_paperclip",
        note: "Paperclip issue is done",
        issue,
      };
    }
    return {
      status: issueStatus || "paperclip_current",
      note: `Current Paperclip work: ${issue.identifier || "issue"}`,
      issue,
    };
  }

  if (issueStatus === "done" && stageNumber === maxCurrent + 1) {
    return {
      status: "ready_after_paperclip_issue",
      note: "Next stage after completed Paperclip issue",
      issue,
    };
  }

  return null;
}

function renderHmmWorkflowBlockerAction(payload) {
  const action = payload?.strategyIntake?.currentEvaluation?.blockerAction;
  if (!action?.available) {
    return `
      <div class="hmm-blocker-action empty-state">
        <div>
          <span class="eyebrow">Workflow action</span>
          <strong>No blocked Paperclip stage to clear</strong>
        </div>
        <p>The button appears here when the current Workflow B issue is blocked.</p>
      </div>
    `;
  }
  return `
    <div class="hmm-blocker-action">
      <div>
        <span class="eyebrow">Workflow action</span>
        <h3>${escapeHtml(action.label || "Resolve Workflow B blocker")}</h3>
        <p>${escapeHtml(action.description || "Run the registered backend action and update Paperclip if it passes.")}</p>
      </div>
      <div class="hmm-blocker-action-meta">
        <span>Target: ${renderHmmIssueLink(action.targetIssue)}</span>
        <span>Handler: ${escapeHtml(humanizeStatus(action.backendHandler || "paperclip_status_only"))}</span>
        ${action.resumesParent ? `<span>Also resumes: ${renderHmmIssueLink(action.parentIssue)}</span>` : ""}
      </div>
      <button class="dashboard-button hmm-resolve-blocker-button" type="button" data-hmm-resolve-blocker>
        ${escapeHtml(action.label || "Resolve blocker")}
      </button>
      <p class="section-note" data-hmm-blocker-action-status></p>
    </div>
  `;
}

function renderHmmWorkflowStages(workflow = {}, evaluation = null) {
  const stages = workflow.board?.stages || [];
  if (!stages.length) return '<p class="empty">Workflow B stage board is not available yet.</p>';
  return `
    <div class="hmm-stage-board">
      ${stages.map((stage, index) => {
        const overlay = evaluation ? hmmWorkflowStageOverlay(stage, evaluation) : null;
        const displayStatus = overlay?.status || stage.status || "unknown";
        return `
        <article class="hmm-stage ${hmmStatusTone(displayStatus)}${overlay ? " paperclip-overlay" : ""}">
          <span>${String(index + 1).padStart(2, "0")}</span>
          <div>
            <strong>${escapeHtml(stage.label || stage.stage_id)}</strong>
            <em>${escapeHtml(humanizeStatus(displayStatus))}</em>
          </div>
          <small>${escapeHtml(overlay?.note || (stage.can_run_now ? "Can run now" : humanizeStatus(stage.gate || "gate")))}</small>
          ${overlay?.issue ? `<small class="hmm-stage-issue">${renderHmmIssueLink(overlay.issue)}</small>` : ""}
        </article>
      `; }).join("")}
    </div>
  `;
}

function hmmWorkflowVisibleStageCounts(workflow = {}, evaluation = null) {
  const counts = {
    total: 0,
    complete: 0,
    blocked: 0,
    waiting: 0,
    locked: 0,
    runnable: 0,
  };
  for (const stage of workflow.board?.stages || []) {
    counts.total += 1;
    const overlay = evaluation ? hmmWorkflowStageOverlay(stage, evaluation) : null;
    const status = String(overlay?.status || stage.status || "").toLowerCase();
    if (/complete|passed|done/.test(status)) counts.complete += 1;
    if (/blocked/.test(status)) counts.blocked += 1;
    if (/waiting|pending/.test(status)) counts.waiting += 1;
    if (/locked/.test(status) && !/blocked/.test(status)) counts.locked += 1;
    if (stage.can_run_now && !overlay && !/locked|blocked/.test(status)) counts.runnable += 1;
    if (/ready_after|can_run/.test(status)) counts.runnable += 1;
  }
  return counts;
}

function renderHmmRegimeSnapshot(snapshot, label) {
  if (!snapshot) return `<p class="empty">${escapeHtml(label)} snapshot is not available yet.</p>`;
  const stateRows = Object.entries(snapshot.stateProbabilities || {})
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 6)
    .map(([state, value]) => ({
      State: humanizeStatus(state),
      Probability: formatPercent(value),
    }));
  return `
    <div class="hmm-regime-snapshot">
      <div class="summary-grid markov-at-glance">
        ${summaryTile("State", humanizeStatus(snapshot.dominantState || "n/a"), String(snapshot.dominantState || "").includes("down") ? "warn" : "good")}
        ${summaryTile("Confidence", confidenceDisplay(snapshot.confidence))}
        ${summaryTile("Expected return", hmmFormatTicks(snapshot.expectedReturnTicks))}
        ${summaryTile("Expected volatility", hmmFormatTicks(snapshot.expectedVolatilityTicks))}
        ${summaryTile("Mode", humanizeStatus(snapshot.recommendedStrategyMode || "n/a"))}
        ${summaryTile("Timestamp", formatTradeTimestamp(snapshot.timestamp))}
      </div>
      ${renderRegimeProbabilityBars(snapshot.stateProbabilities || {})}
      ${stateRows.length ? renderGenericTable(stateRows) : ""}
    </div>
  `;
}

function renderHmmRegimeMonitor(payload) {
  const regime = payload?.regimeEngine || {};
  const cross = regime.latestCrossSnapshot || {};
  const ltf = cross.ltfExecutionContext || {};
  const htf = cross.htfBias || {};
  return `
    <section class="panel" id="hmm-regime">
      <div class="section-head">
        <div>
          <h2>HMM Regime Engine</h2>
          <p>${escapeHtml(cross.symbol || "MNQM26_FUT_CME")} / ${escapeHtml(cross.timeframe || "5m / 15m")}</p>
        </div>
        ${dataSourceBadge("paperclip_artifact", "S5/S6 latest HMM snapshots")}
      </div>
      <div class="summary-grid markov-at-glance">
        ${summaryTile("Cross confidence", confidenceDisplay(cross.confidence))}
        ${summaryTile("Alignment", humanizeStatus(cross.alignment?.label || "n/a"), cross.alignment?.label === "same_state" ? "good" : "warn")}
        ${summaryTile("Conflict", humanizeStatus(cross.conflict?.level || "n/a"), cross.conflict?.level === "none" ? "good" : "warn")}
        ${summaryTile("5m state", humanizeStatus(ltf.dominant_state || regime.latest5mSnapshot?.dominantState || "n/a"))}
        ${summaryTile("15m state", humanizeStatus(htf.dominant_state || regime.latest15mSnapshot?.dominantState || "n/a"))}
        ${summaryTile("Models", (regime.modelRegistry?.models || []).filter((model) => model.active).length || "n/a")}
      </div>
      <div class="hmm-regime-grid">
        <article>
          <h3>Cross-Timeframe Snapshot</h3>
          ${renderHmmRegimeSnapshot(cross, "Cross-timeframe")}
        </article>
        <article>
          <h3>5m Execution Snapshot</h3>
          ${renderHmmRegimeSnapshot(regime.latest5mSnapshot, "5m")}
        </article>
      </div>
    </section>
  `;
}

function renderHmmScorecard(payload) {
  const scorecard = payload?.scorecard || {};
  const dummy = scorecard.dummyValidation || {};
  const modeRows = (dummy.mode_scores || []).map((row) => ({
    Mode: humanizeStatus(row.mode),
    Score: hmmFormatNumber(row.score, 2),
    "Net ticks": hmmFormatNumber(row.net_ticks, 1),
    Expectancy: hmmFormatNumber(row.expectancy_ticks, 2),
    "Max DD": hmmFormatNumber(row.max_drawdown_ticks, 1),
    "Profit factor": hmmFormatNumber(row.profit_factor, 3),
    "Win rate": formatPercent(row.win_rate),
    Trades: row.trade_count,
    "OOS expectancy": hmmFormatNumber(row.out_of_sample_expectancy_ticks, 2),
  }));
  const walkForward = dummy.walk_forward_summary || {};
  return `
    <section class="panel" id="hmm-scorecard">
      <div class="section-head">
        <div>
          <h2>Strategy Scorecard</h2>
          <p>${escapeHtml(dummy.recommendation || scorecard.template?.decision || "not_evaluated")}</p>
        </div>
        ${dataSourceBadge("paperclip_artifact", "Workflow B scorecard artifacts")}
      </div>
      <div class="summary-grid markov-at-glance">
        ${summaryTile("Best mode", humanizeStatus(dummy.best_mode || "n/a"))}
        ${summaryTile("Fold pass rate", formatPercent(walkForward.pass_rate))}
        ${summaryTile("OOS net ticks", hmmFormatNumber(walkForward.total_oos_net_ticks, 1))}
        ${summaryTile("OOS expectancy", hmmFormatNumber(walkForward.average_oos_expectancy_ticks, 2))}
        ${summaryTile("Stability", humanizeStatus(walkForward.stability_label || "n/a"))}
        ${summaryTile("Promotion", dummy.recommendation === "template_only_do_not_promote" ? "Blocked" : humanizeStatus(dummy.recommendation || "n/a"), "warn")}
      </div>
      <p class="section-note">${escapeHtml(dummy.recommendation_reason || "Scorecard template is waiting for a real strategy.")}</p>
      ${modeRows.length ? renderGenericTable(modeRows) : '<p class="empty">No mode score rows found.</p>'}
    </section>
  `;
}

function renderHmmPaperclipIssues(paperclip = {}) {
  const rows = (paperclip.issues || []).map((issue) => ({
    Issue: issue.url ? `<a class="text-link" href="${escapeHtml(issue.url)}" target="_blank" rel="noopener">${escapeHtml(issue.identifier || issue.id)}</a>` : escapeHtml(issue.identifier || issue.id),
    Title: escapeHtml(issue.title || "n/a"),
    Status: escapeHtml(humanizeStatus(issue.status || "n/a")),
    Priority: escapeHtml(humanizeStatus(issue.priority || "n/a")),
    Updated: escapeHtml(formatTradeTimestamp(issue.updatedAt)),
  }));
  if (!paperclip.ok) {
    return `<p class="empty">Paperclip issue status unavailable: ${escapeHtml(paperclip.error || "unknown error")}</p>`;
  }
  if (!rows.length) return '<p class="empty">No Hermes Workflow B strategy issues found yet.</p>';
  const headers = ["Issue", "Title", "Status", "Priority", "Updated"];
  return createTable(headers, rows.map((row) => headers.map((header) => row[header])));
}

function renderHmmSourceFiles(sourceFiles = {}) {
  const rows = Object.entries(sourceFiles).map(([key, meta]) => ({
    Artifact: humanizeStatus(key),
    Status: meta.exists ? "Current" : "Missing",
    Updated: formatTradeTimestamp(meta.updatedAtUtc),
    Path: meta.path || "n/a",
  }));
  return rows.length ? renderGenericTable(rows) : '<p class="empty">No source artifacts were listed.</p>';
}

function renderHmmStrategyMonitorPage(payload) {
  if (!payload?.ok) return `<p class="empty">HMM Strategy Monitor could not load: ${escapeHtml(payload?.error || "unknown error")}</p>`;
  const platform = payload.platform || {};
  const workflow = payload.workflowB || {};
  const stageCounts = workflow.stageCounts || {};
  const strategyOptions = payload.strategyIntake?.knownStrategies || [];
  const currentEvaluation = payload.strategyIntake?.currentEvaluation || {};
  const visibleStageCounts = hmmWorkflowVisibleStageCounts(workflow, currentEvaluation);
  const draft = loadHmmStrategyDraft();
  const defaultName = draft.strategyName || currentEvaluation.strategyName || platform.activeStrategyId || "";
  const defaultNote = draft.notes || "";
  const actionStatus = renderHmmActionStatusFromDraft(draft);
  return `
    <div class="markov-shell hmm-monitor-shell">
      <aside class="side-menu" aria-label="HMM strategy monitor navigation">
        <a href="#hmm-intake">Strategy</a>
        <a href="#hmm-workflow">Workflow B</a>
        <a href="#hmm-regime">Regime</a>
        <a href="#hmm-scorecard">Scorecard</a>
        <a href="#hmm-platform">Platform</a>
        <a href="#hmm-paperclip">Paperclip</a>
        <a href="#hmm-source">Source</a>
      </aside>
      <div class="markov-content">
        <section class="panel priority-panel" id="hmm-intake">
          <div class="section-head">
            <div>
              <h2>Strategy Intake</h2>
              <p>${escapeHtml(platform.nextRequiredAction || "Add a strategy plugin when ready.")}</p>
            </div>
            ${dataSourceBadge(payload.sourceSystem, "Hermes Markov/HMM stage and Workflow B artifacts")}
          </div>
          <div class="hmm-intake-grid">
            <label class="hmm-field">
              <span>Strategy name</span>
              <input type="text" list="hmm-strategy-options" value="${escapeHtml(defaultName)}" placeholder="Enter strategy name" data-hmm-strategy-name />
              <datalist id="hmm-strategy-options">
                ${strategyOptions.map((item) => `<option value="${escapeHtml(item.strategyName)}"></option>`).join("")}
              </datalist>
            </label>
            <label class="hmm-field">
              <span>Operator note</span>
              <input type="text" value="${escapeHtml(defaultNote)}" placeholder="Optional evaluation note" data-hmm-strategy-note />
            </label>
            <button class="dashboard-button hmm-start-button" type="button" data-hmm-start-evaluation ${payload.strategyIntake?.enabled ? "" : "disabled"}>${escapeHtml(payload.strategyIntake?.issueActionLabel || "Start evaluation job")}</button>
          </div>
          <div data-hmm-selected-strategy>${renderHmmSelectedStrategyCard(payload, defaultName)}</div>
          ${renderHmmEvaluationJobPanel(payload)}
          <p class="section-note" data-hmm-action-status>${actionStatus}</p>
        </section>

        <section class="panel" id="hmm-workflow">
          <div class="section-head">
            <div>
              <h2>Workflow B Stage Manager</h2>
              <p>${escapeHtml(workflow.board?.workflow || "Repeatable strategy evaluation process")}</p>
            </div>
            ${hmmStatusBadge("Next", workflow.nextStage?.status || "waiting")}
          </div>
          ${renderHmmWorkflowBlockerAction(payload)}
          <div class="summary-grid markov-at-glance">
            ${summaryTile("Paperclip phase", currentEvaluation.phase || "No active job", currentEvaluation.paused ? "warn" : currentEvaluation.running ? "good" : "neutral")}
            ${summaryTile("Current issue", currentEvaluation.currentIssue?.identifier || "None", currentEvaluation.currentIssue ? (currentEvaluation.paused ? "warn" : "good") : "neutral")}
            ${summaryTile("Issue state", humanizeStatus(currentEvaluation.status || "n/a"), currentEvaluation.paused ? "warn" : currentEvaluation.running ? "good" : "neutral")}
            ${summaryTile("Stages", visibleStageCounts.total || stageCounts.total || "n/a")}
            ${summaryTile("Complete", visibleStageCounts.complete ?? 0, "good")}
            ${summaryTile("Blocked", visibleStageCounts.blocked ?? 0, visibleStageCounts.blocked ? "warn" : "good")}
            ${summaryTile("Locked", visibleStageCounts.locked ?? 0, visibleStageCounts.locked ? "warn" : "good")}
            ${summaryTile("Can run now", visibleStageCounts.runnable ?? 0, visibleStageCounts.runnable ? "good" : "warn")}
          </div>
          <p class="section-note">Stage cards show live Paperclip overlay status when a strategy evaluation issue exists; the base board remains the original Workflow B artifact.</p>
          ${renderHmmWorkflowStages(workflow, currentEvaluation)}
        </section>

        ${renderHmmRegimeMonitor(payload)}

        ${renderHmmScorecard(payload)}

        <section class="panel" id="hmm-platform">
          <div class="section-head">
            <div>
              <h2>Platform Gate</h2>
              <p>${escapeHtml(platform.currentStageId)} / ${escapeHtml(platform.currentStageStatus)}</p>
            </div>
            ${hmmStatusBadge("Gate", platform.platformReadyForStrategy ? "ready" : "blocked")}
          </div>
          <div class="summary-grid markov-at-glance">
            ${summaryTile("Readiness", platform.platformReadyForStrategy ? "Ready for strategy" : "Blocked", platform.platformReadyForStrategy ? "good" : "warn")}
            ${summaryTile("Acceptance", `${platform.acceptanceItemsPassed ?? "n/a"} / ${platform.acceptanceItemsTotal ?? "n/a"}`, "good")}
            ${summaryTile("Active strategy", platform.activeStrategyId || "None", platform.activeStrategyId ? "good" : "warn")}
            ${summaryTile("Evaluation active", platform.strategyEvaluationActive ? "Yes" : "No", platform.strategyEvaluationActive ? "good" : "warn")}
            ${summaryTile("Next stage", platform.nextStageId || "n/a")}
            ${summaryTile("Reviewed", formatTradeTimestamp(platform.reviewedAtUtc))}
          </div>
          ${renderHmmPlatformGateInformation(platform, payload.safety || {})}
        </section>

        <section class="panel" id="hmm-paperclip">
          <div class="section-head">
            <div>
              <h2>Paperclip Evaluation Trail</h2>
              <p>Hermes Markov/HMM project ${escapeHtml(payload.hermesProject?.projectId || "n/a")}</p>
            </div>
            <a class="button-link" href="${escapeHtml(payload.hermesProject?.boardUrl || "#")}" target="_blank" rel="noopener">Open Paperclip</a>
          </div>
          ${renderHmmPaperclipIssues(payload.paperclip || {})}
        </section>

        <section class="panel" id="hmm-source">
          <h2>Source Artifacts</h2>
          ${renderHmmSourceFiles(payload.sourceFiles || {})}
        </section>
      </div>
    </div>
  `;
}

function renderBacktestEngineRuns(payload) {
  const runs = payload?.runs || [];
  if (!payload?.ok) {
    return `<p class="empty">Backtester engine runs could not be read: ${escapeHtml(payload?.error || "unknown error")}</p>`;
  }
  if (!runs.length) {
    return '<p class="empty">No cache-engine backtests have been run yet.</p>';
  }
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Run</th>
            <th>Strategy</th>
            <th>Instrument</th>
            <th>Symbol</th>
            <th>Timeframe</th>
            <th>Range</th>
            <th>Variants</th>
            <th>Best Variant</th>
            <th>Best P&L</th>
            <th>Best Win Rate</th>
            <th>Created</th>
            <th>Artifact</th>
          </tr>
        </thead>
        <tbody>
          ${runs
            .map(
              (run) => `
                <tr>
                  <td>${escapeHtml(run.runId)}</td>
                  <td>${escapeHtml(run.strategy)}</td>
                  <td>${escapeHtml(run.instrument)}</td>
                  <td>${escapeHtml(run.symbol)}</td>
                  <td>${escapeHtml(run.timeframe)} min</td>
                  <td>${escapeHtml(run.from || "all")} to ${escapeHtml(run.to || "all")}</td>
                  <td>${escapeHtml(run.variants)}</td>
                  <td>${escapeHtml(run.bestVariant || "n/a")}</td>
                  <td>${escapeHtml(formatCurrency(run.bestNetProfitDollars))}</td>
                  <td>${escapeHtml(formatPercent(run.bestWinRate))}</td>
                  <td>${escapeHtml(formatTradeTimestamp(run.createdAtUtc))}</td>
                  <td>${escapeHtml(run.artifactPath ? basename(run.artifactPath) : "n/a")}</td>
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderPerformanceSections(performance) {
  const backtesting = performance?.backtesting || {};
  const paperTrading = performance?.paperTrading || {};
  const liveTrading = performance?.liveTrading || {};
  const paperHygiene = paperTrading.dataHygiene || {};
  return `
    <div class="performance-stack">
      <section class="performance-section backtest">
        <div class="section-head">
          <div>
            <h3>Backtesting Performance</h3>
            <p>${escapeHtml(backtesting.summary || "Historical backtest metrics only.")}</p>
          </div>
        </div>
        ${createStrategyMetricsTable(backtesting.rows || [])}
        ${
          backtesting.candidateRows?.length
            ? `<h4>Additional Backtest Candidates</h4>${createStrategyMetricsTable(backtesting.candidateRows)}`
            : ""
        }
      </section>
      <section class="performance-section paper">
        <div class="section-head">
        <div>
          <h3>Paper Trading Performance</h3>
          <p>${escapeHtml(paperTrading.summary || "Forward-test performance only.")}</p>
        </div>
      </div>
      ${createPaperPerformanceTable(paperTrading.rows || [])}
      ${paperTrading.offBundleRows?.length ? `<h4>Other Paper Strategy Activity</h4><p class="section-note">Connector-attributed paper strategies that are not in the approved paper bundle are shown separately so experimental chartbooks do not pollute approved totals.</p>${createPaperPerformanceTable(paperTrading.offBundleRows)}` : ""}
      ${createPaperReviewReportTable(paperTrading.reviewReports || [])}
      <p class="data-note">
          Paper data hygiene: ${escapeHtml(paperHygiene.archivedCopiedManualLogCount ?? 0)} copied/manual account log files archived;
          ${escapeHtml(paperHygiene.activeCopiedManualLogCount ?? 0)} locked copied/manual log file(s) excluded from paper metrics.
        </p>
      </section>
      <section class="performance-section live">
        <div class="section-head">
          <div>
            <h3>Live Trading Performance</h3>
            <p>${escapeHtml(liveTrading.summary || "Live imported performance only.")}</p>
          </div>
        </div>
        ${createLivePerformanceTable(liveTrading.rows || [])}
      </section>
    </div>
  `;
}

function createStrategyCatalogTable(rows) {
  if (!rows?.length) return '<p class="empty">No Sierra studies found in OceanTrading.cpp.</p>';
  return `
    <table>
      <thead>
        <tr>
          <th>Sierra Study</th>
          <th>Function</th>
          <th>Platform</th>
          <th>Status</th>
          <th>Data source</th>
          <th>Source</th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (row) => `
              <tr>
                <td>${escapeHtml(row.name)}</td>
                <td>${escapeHtml(row.functionName)}</td>
                <td>${escapeHtml(row.platform)}</td>
                <td>${escapeHtml(row.status)}</td>
                <td>${dataSourceBadge(row.sourceSystem || "sierra_strategy_artifact", row.sourceDetail)}</td>
                <td>${escapeHtml(basename(row.sourceFile))}</td>
              </tr>
            `,
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function createResearchTable(run) {
  const strategies = run.strategies || [];
  return `
    <article class="run">
      <header class="run-header">
        <div>
          <h3>${escapeHtml(run.title)}</h3>
          <p>${escapeHtml(run.runDate || "n/a")}</p>
        </div>
        <span>${escapeHtml(basename(run.sourceFile))}</span>
      </header>
      ${
        strategies.length
          ? `
        <table>
          <thead>
            <tr>
              <th>Variant</th>
              <th>Trades</th>
              <th>Long</th>
              <th>Short</th>
              <th>Win rate</th>
              <th>Net PnL</th>
            </tr>
          </thead>
          <tbody>
            ${strategies
              .map(
                (strategy) => `
                <tr>
                  <td>${escapeHtml(strategy.strategy)}</td>
                  <td>${escapeHtml(strategy.tradeCount)}</td>
                  <td>${escapeHtml(strategy.longTrades)}</td>
                  <td>${escapeHtml(strategy.shortTrades)}</td>
                  <td>${escapeHtml(formatPercent(strategy.winRate))}</td>
                  <td>${escapeHtml(formatCurrency(strategy.netProfitDollars))}</td>
                </tr>
              `,
              )
              .join("")}
          </tbody>
        </table>
      `
          : '<p class="empty">No strategy metrics in this run artifact.</p>'
      }
    </article>
  `;
}

function createResearchHistory(history) {
  if (!history?.length) return '<p class="empty">No research history has been captured yet.</p>';
  return history
    .map(
      (entry) => `
        <article class="run ${entry.latest ? "latest" : ""}">
          <header class="run-header">
            <div>
              <h3>${escapeHtml(entry.title)} ${entry.latest ? '<span class="status-badge">Latest</span>' : ""}</h3>
              <p>${escapeHtml(entry.date)}</p>
            </div>
          </header>
          <div class="two-column">
            <section>
              <h4>Researched</h4>
              ${bulletList(entry.researched || [])}
            </section>
            <section>
              <h4>Results</h4>
              ${bulletList(entry.results || [])}
            </section>
          </div>
          <div class="two-column">
            <section>
              <h4>Chosen</h4>
              ${bulletList(entry.chosen || [])}
            </section>
            <section>
              <h4>Not Chosen</h4>
              ${
                entry.rejected?.length
                  ? `<ul class="summary-list">${entry.rejected
                      .map((item) => `<li><strong>${escapeHtml(item.strategy)}</strong>: ${escapeHtml(item.reason)}</li>`)
                      .join("")}</ul>`
                  : '<p class="empty">No rejected strategy in this research item.</p>'
              }
            </section>
          </div>
        </article>
      `,
    )
    .join("");
}

function loadBacktestRequestHistory() {
  try {
    return JSON.parse(window.localStorage.getItem("oceanTradingBacktestRequests") || "[]");
  } catch {
    return [];
  }
}

function saveBacktestRequestHistory(requests) {
  window.localStorage.setItem("oceanTradingBacktestRequests", JSON.stringify(requests.slice(0, 100)));
}

function rememberBacktestRequest(record) {
  const requests = loadBacktestRequestHistory();
  requests.unshift(record);
  saveBacktestRequestHistory(requests);
}

function requestsForStrategy(strategyName) {
  const target = String(strategyName || "").toLowerCase();
  return loadBacktestRequestHistory().filter((request) => String(request.strategyName || "").toLowerCase() === target);
}

function renderBacktestRequestHistory(strategyName) {
  const requests = requestsForStrategy(strategyName);
  if (!requests.length) return '<p class="empty">No previous backtest requests recorded for this strategy in this browser.</p>';
  return `
    <div class="request-history-list">
      <h3>Backtest Requests</h3>
      <table>
        <thead>
          <tr><th>Requested</th><th>Duration</th><th>Time frame</th><th>Optimization</th><th>Status</th><th>Issue</th></tr>
        </thead>
        <tbody>
          ${requests.slice(0, 8).map((request) => `
            <tr>
              <td>${escapeHtml(formatTradeTimestamp(request.requestedAtUtc))}</td>
              <td>${escapeHtml(request.duration || "n/a")}</td>
              <td>${escapeHtml(request.timeframe || "n/a")}</td>
              <td>${escapeHtml(request.optimization ? "Yes" : "No")}</td>
              <td>${escapeHtml(humanizeStatus(request.status || "requested"))}</td>
              <td>${request.url ? `<a class="text-link" href="${escapeHtml(request.url)}">${escapeHtml(request.identifier || request.issueId || "Issue")}</a>` : "n/a"}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
      <p class="form-help">Create another request only if you want a new iteration or a different duration/optimization choice.</p>
    </div>
  `;
}

function updateResearchRequestBadges() {
  document.querySelectorAll("[data-backtest-history-for]").forEach((target) => {
    const requests = requestsForStrategy(target.getAttribute("data-backtest-history-for"));
    target.innerHTML = requests.length
      ? `<span class="status-badge">${escapeHtml(requests.length)} backtest request${requests.length === 1 ? "" : "s"}</span>`
      : "";
  });
}

async function syncBacktestRequestHistory() {
  try {
    const response = await fetch("/api/backtest-requests");
    if (!response.ok) return;
    const payload = await response.json();
    const local = loadBacktestRequestHistory();
    const byKey = new Map(local.map((request) => [request.id || `${request.strategyName}|${request.requestedAtUtc}|${request.issueId}`, request]));
    for (const request of payload.requests || []) {
      byKey.set(request.id || `${request.strategyName}|${request.requestedAtUtc}|${request.issueId}`, request);
    }
    saveBacktestRequestHistory([...byKey.values()].sort((a, b) => String(b.requestedAtUtc || "").localeCompare(String(a.requestedAtUtc || ""))));
  } catch {
    // Local browser history still works if the dashboard API is temporarily unavailable.
  }
}

function backtestCoverageForStrategy(manifest, strategyName) {
  return (manifest.backtestCoverage || []).find((item) => item.strategyName === strategyName) || {
    backtestRuns: 0,
    testedVariants: 0,
    optimizationIterations: 0,
    status: "not_tested",
    latestArtifact: null,
  };
}

function indicatorGuidanceForStrategy(strategyName) {
  const name = String(strategyName || "").toLowerCase();
  if (name.includes("rubberband")) {
    return "Session VWAP; ATR(20); VWAP proximity threshold; breakout lookback high/low; ATR-based stop cap; 1R scale-out and 2R runner.";
  }
  if (name.includes("lunchy") || name.includes("ifvg")) {
    return "Morning range high/low; 12:35 anchor; fair value gap structure; sweep/bias logic; structure stop; 2R target.";
  }
  if (name.includes("opening range")) {
    return "Opening range high/low; session time window; SMA(200) trend filter; breakout close; opposite-side range stop; 2R target.";
  }
  if (name.includes("vwap")) {
    return "NY VWAP; optional Globex VWAP; EMA 5/8/13 trend stack; reclaim/pullback confirmation; structure/VWAP stop; 2R target.";
  }
  return "No indicator template is available yet. Add or remove indicators in the instruction box before creating the request.";
}

function researchCategory(find, coverage) {
  const status = String(find.status || "").toLowerCase();
  const decision = String(find.decision || "").toLowerCase();
  if (!coverage?.backtestRuns) return "new-untested";
  if (status.includes("rejected") || decision.includes("rejected")) return "rejected";
  if (status.includes("approved") || decision.includes("accepted into paper-trading bundle")) return "accepted";
  if (status.includes("blocked") || status.includes("candidate") || status.includes("merged") || decision.includes("not kept")) return "needs-review";
  return "tested";
}

function researchFilterOptions(manifest, key) {
  return uniqueValues(manifest.researchFinds || [], key);
}

function renderResearchFilters(manifest) {
  const categories = [
    ["all", "All strategies"],
    ["new-untested", "New / untested"],
    ["tested", "Tested"],
    ["accepted", "Accepted"],
    ["rejected", "Rejected"],
    ["needs-review", "Needs review / merged"],
  ];
  return `
    <div class="research-filters" aria-label="Research filters">
      <label>Category
        <select data-research-filter="category">
          ${categories.map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join("")}
        </select>
      </label>
      <label>Market
        <select data-research-filter="market">
          <option value="">All markets</option>
          ${researchFilterOptions(manifest, "market").map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("")}
        </select>
      </label>
      <label>Style
        <select data-research-filter="style">
          <option value="">All styles</option>
          ${researchFilterOptions(manifest, "style").map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("")}
        </select>
      </label>
      <label>Evidence
        <select data-research-filter="evidence">
          <option value="">All evidence</option>
          ${researchFilterOptions(manifest, "evidenceLevel").map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("")}
        </select>
      </label>
    </div>
    <p class="section-note" id="research-filter-count"></p>
  `;
}

function renderBacktestCoverageSummary(coverage) {
  const statusTone = coverage.backtestRuns ? (coverage.optimizationIterations ? "good" : "neutral") : "warn";
  return `
    <div class="tile-grid compact-grid">
      ${summaryTile("Backtest runs", coverage.backtestRuns || 0, coverage.backtestRuns ? "good" : "warn")}
      ${summaryTile("Optimization iterations", coverage.optimizationIterations || 0, coverage.optimizationIterations ? "good" : "neutral")}
      ${summaryTile("Tested variants", coverage.testedVariants || 0)}
      ${summaryTile("Status", humanizeStatus(coverage.status || "not_tested"), statusTone)}
    </div>
    ${coverage.latestArtifact ? `<p class="form-help">Latest artifact: ${escapeHtml(basename(coverage.latestArtifact))}</p>` : '<p class="form-help">No backtest artifact has been matched to this strategy yet.</p>'}
  `;
}

function createResearchFinds(manifest) {
  const finds = manifest.researchFinds || [];
  if (!finds?.length) return '<p class="empty">No research finds have been captured yet.</p>';
  return `
    <div class="research-find-grid">
      ${finds
        .map(
          (find) => {
            const coverage = backtestCoverageForStrategy(manifest, find.strategyName);
            const category = researchCategory(find, coverage);
            return `
            <article class="research-find" data-research-card data-category="${escapeHtml(category)}" data-tested="${coverage?.backtestRuns ? "true" : "false"}" data-market="${escapeHtml(find.market || "")}" data-style="${escapeHtml(find.style || "")}" data-evidence="${escapeHtml(find.evidenceLevel || "")}">
              <header class="run-header">
                <div>
                  <h3>${escapeHtml(find.strategyName)}</h3>
                  <p>${escapeHtml(find.cycle)} · ${escapeHtml(find.foundDate)}</p>
                </div>
                <div class="badge-stack">
                  <span class="status-badge">${escapeHtml(humanizeStatus(find.status))}</span>
                  ${dataSourceBadge(find.sourceSystem || "paperclip", find.sourceDetail)}
                </div>
              </header>
              ${keyValueTable([
                ["Market", find.market],
                ["Style", find.style],
                ["Evidence", find.evidenceLevel],
                ["Decision", find.decision],
              ])}
              <h4>Why It Was / Was Not Chosen</h4>
              <p>${escapeHtml(find.reason)}</p>
              <h4>Popularity / Discovery Signal</h4>
              <p>${escapeHtml(find.popularitySignal)}</p>
              <h4>Backtest / Optimization Status</h4>
              ${renderBacktestCoverageSummary(coverage)}
              <div class="card-actions">
                <span data-backtest-history-for="${escapeHtml(find.strategyName)}"></span>
                <button class="button-link" type="button" data-backtest-strategy="${escapeHtml(find.strategyName)}" data-backtest-indicators="${escapeHtml(indicatorGuidanceForStrategy(find.strategyName))}">Request backtest</button>
              </div>
            </article>
          `;
          },
        )
        .join("")}
    </div>
  `;
}

function createManualStrategyRequests() {
  const requests = loadBacktestRequestHistory().filter((request) => request.requestType === "manual_strategy");
  if (!requests.length) {
    return '<p class="empty">No manual strategy requests have been captured yet.</p>';
  }
  return createTable(
    [
      "Strategy",
      "Requested",
      "Duration",
      "Time frame",
      "Optimization",
      "Status",
      "Execution",
      "Issue",
    ],
    requests.map((request) => [
      request.strategyName || "Unnamed strategy",
      formatTradeTimestamp(request.requestedAtUtc),
      request.duration || "n/a",
      request.timeframe || "n/a",
      request.optimization ? "Yes" : "No",
      humanizeStatus(request.status || "requested"),
      request.backtestExecutionMode === "cache_native_sierra_historical_cache" ? "Cache-native" : "Paperclip",
      request.url ? `<a class="text-link" href="${escapeHtml(request.url)}">${escapeHtml(request.identifier || request.issueId || "Issue")}</a>` : "n/a",
    ]),
  );
}

function createCodedStrategyCards(manifest) {
  const rows = manifest.strategyCatalog || [];
  if (!rows.length) return '<p class="empty">No coded Sierra strategies have been cataloged yet.</p>';
  return `
    <div class="research-find-grid">
      ${rows.map((strategy) => {
        const lifecycle = (manifest.strategyLifecycle || []).find((item) => item.strategyName === strategy.name);
        const coverage = backtestCoverageForStrategy(manifest, strategy.name);
        return `
          <article class="research-find">
            <header class="run-header">
              <div>
                <h3>${escapeHtml(strategy.name)}</h3>
                <p>${escapeHtml(strategy.platform || "Sierra Chart ACSIL/C++")}</p>
              </div>
              <div class="badge-stack">
                <span class="status-badge">${escapeHtml(humanizeStatus(lifecycle?.currentStage || strategy.status || "created"))}</span>
                ${dataSourceBadge(strategy.sourceSystem || "sierra_strategy_artifact", strategy.sourceDetail)}
              </div>
            </header>
            ${keyValueTable([
              ["Function", strategy.functionName],
              ["Status", lifecycle?.decision || strategy.status || "created"],
              ["Source", basename(strategy.sourceFile)],
            ])}
            <h4>Backtest / Optimization Status</h4>
            ${renderBacktestCoverageSummary(coverage)}
            <div class="card-actions">
              <span data-backtest-history-for="${escapeHtml(strategy.name)}"></span>
              <button class="button-link" type="button" data-backtest-strategy="${escapeHtml(strategy.name)}" data-backtest-indicators="${escapeHtml(indicatorGuidanceForStrategy(strategy.name))}">Request backtest</button>
            </div>
          </article>
        `;
      }).join("")}
    </div>
  `;
}

function renderResearchPage(manifest) {
  return `
    <section data-research-panel="finds">
      <div class="section-head">
        <div>
          <h2>Latest Research Finds</h2>
          <p class="section-note">All candidates the research cycle looked at, including accepted, rejected, and folded-in strategies.</p>
        </div>
        <button class="button-link" type="button" data-manual-strategy-request>Manual strategy request</button>
      </div>
      ${renderResearchFilters(manifest)}
      ${createResearchFinds(manifest)}
    </section>
    <section data-research-panel="manual" hidden>
      <div class="section-head">
        <div>
          <h2>Manual Strategy Requests</h2>
          <p class="section-note">Strategies requested directly from the website, including uploaded scripts or operator-written rules.</p>
        </div>
        <button class="button-link" type="button" data-manual-strategy-request>Manual strategy request</button>
      </div>
      ${createManualStrategyRequests()}
    </section>
    <section data-research-panel="coded" hidden>
      <div class="section-head">
        <div>
          <h2>Coded Sierra Strategies</h2>
          <p class="section-note">Strategies that exist in the Ocean Trading Sierra Chart ACSIL source, including Codex-created strategies that are pending backtest.</p>
        </div>
      </div>
      ${createCodedStrategyCards(manifest)}
    </section>
    <section data-research-panel="history" hidden>
      <h2>Accepted / Decision History</h2>
      ${createResearchHistory(manifest.researchHistory || [])}
    </section>
    <section data-research-panel="artifacts" hidden>
      <h2>Recent Raw Backtest Artifacts</h2>
      ${
        manifest.researchRuns?.length
          ? manifest.researchRuns.map(createResearchTable).join("")
          : '<p class="empty">No recent research/backtest run outputs found.</p>'
      }
    </section>
  `;
}

function renderStrategyLifecycle(rows) {
  if (!rows?.length) return '<p class="empty">No strategy lifecycle records have been built yet.</p>';
  return `
    <table>
      <thead>
        <tr>
          <th>Strategy</th>
          <th>Current stage</th>
          <th>Decision</th>
          <th>Lifecycle</th>
          <th>Blockers</th>
          <th>Data source</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((row) => `
          <tr>
            <td>${escapeHtml(row.strategyName)}</td>
            <td>${escapeHtml(humanizeStatus(row.currentStage))}</td>
            <td>${escapeHtml(row.decision || "n/a")}</td>
            <td>
              <div class="lifecycle-steps">
                ${(row.stages || []).map((stage) => `
                  <span class="lifecycle-step ${escapeHtml(stage.status)}" title="${escapeHtml(stage.detail || "")}">
                    ${escapeHtml(humanizeStatus(stage.stage))}
                  </span>
                `).join("")}
              </div>
            </td>
            <td>${(row.blockers || []).length ? bulletList(row.blockers) : "None"}</td>
            <td>${dataSourceBadge(row.sourceSystem || "paperclip", "Strategy lifecycle assembled from Paperclip issues, decisions, and Sierra records")}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function renderSourceAudit(manifest) {
  const audit = manifest.dataSources || {};
  const summary = audit.summary || {};
  const records = audit.records || [];
  const database = manifest.database || {};
  if (!records.length) return '<p class="empty">No source files found.</p>';
  const bySystem = summary.bySourceSystem || {};
  const staleOrMissing = records.filter((record) => record.stale || !record.exists);
  return `
    <section class="source-contract">
      <h2>Data Ownership Contract</h2>
      ${bulletList(audit.contract || [])}
      ${keyValueTable([
        ["Dashboard read model", database.sqliteFile || "n/a"],
        ["Persistence rule", database.persistence || "Latest Paperclip and Sierra state is imported into SQLite on manifest rebuild."],
      ])}
      <div class="tile-grid compact-grid">
        ${summaryTile("Paperclip issues", summary.paperclipIssues || 0)}
        ${summaryTile("Paperclip reports", summary.paperclipReports || 0)}
        ${summaryTile("Backtest requests", summary.paperclipBacktestRequests || 0)}
        ${summaryTile("Source files", summary.totalSourceFiles || records.length)}
        ${summaryTile("Stale files", summary.staleSourceFiles || 0, summary.staleSourceFiles ? "warn" : "good")}
        ${summaryTile("Untracked artifacts", summary.untrackedPaperclipArtifacts || 0, summary.untrackedPaperclipArtifacts ? "warn" : "good")}
      </div>
      <p class="data-note">Source split: ${Object.entries(bySystem).map(([system, count]) => `${dataSourceBadge(system)} ${escapeHtml(count)}`).join(" ")}</p>
    </section>
    ${
      staleOrMissing.length
        ? `<section class="alert-panel"><h3>Stale or Missing Sources</h3>${listSourceRecords(staleOrMissing.slice(0, 80))}</section>`
        : '<p class="data-note">No missing source files were detected in the current manifest.</p>'
    }
    ${
      audit.reportsWithoutArtifacts?.length
        ? `<section class="alert-panel"><h3>Paperclip Reports Without File Artifacts</h3>${renderPaperclipReportTable(audit.reportsWithoutArtifacts)}</section>`
        : ""
    }
    ${
      audit.untrackedPaperclipArtifacts?.length
        ? `<section class="alert-panel"><h3>Paperclip Artifacts Not Yet Used By Website Tables</h3>${listUntrackedArtifacts(audit.untrackedPaperclipArtifacts)}</section>`
        : ""
    }
    <h2>All Source Files</h2>
    ${listSourceRecords(records)}
  `;
}

function listSourceRecords(records) {
  if (!records || records.length === 0) return '<p class="empty">No source records found.</p>';
  return `
    <table>
      <thead><tr><th>Artifact</th><th>System</th><th>Status</th><th>Last modified</th><th>Path</th></tr></thead>
      <tbody>
        ${records.map((record) => `
          <tr>
            <td>${escapeHtml(record.basename || basename(record.path))}</td>
            <td>${dataSourceBadge(record.sourceSystem)}</td>
            <td>${record.exists ? (record.stale ? '<span class="status-badge warn">Stale</span>' : '<span class="status-badge good">Current</span>') : '<span class="status-badge warn">Missing</span>'}</td>
            <td>${escapeHtml(formatTradeTimestamp(record.lastModifiedUtc))}</td>
            <td class="path-cell">${escapeHtml(record.path)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function listUntrackedArtifacts(rows) {
  return `
    <table>
      <thead><tr><th>Issue</th><th>Report</th><th>Type</th><th>Exists</th><th>Path</th></tr></thead>
      <tbody>
        ${rows.map((row) => `
          <tr>
            <td>${escapeHtml(row.identifier || "n/a")}</td>
            <td>${escapeHtml(row.reportTitle || "n/a")}</td>
            <td>${escapeHtml(humanizeStatus(row.reportType))}</td>
            <td>${escapeHtml(row.exists ? "Yes" : "No")}</td>
            <td class="path-cell">${escapeHtml(row.path)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function clearCanvas(canvas) {
  const ctx = canvas.getContext("2d");
  const scale = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width * scale));
  canvas.height = Math.max(1, Math.floor(rect.height * scale));
  ctx.scale(scale, scale);
  ctx.clearRect(0, 0, rect.width, rect.height);
  return { ctx, width: rect.width, height: rect.height };
}

function bindResearchInteractions() {
  const tabButtons = [...document.querySelectorAll("[data-research-tab]")];
  if (tabButtons.length) {
    tabButtons.forEach((button) => {
      button.addEventListener("click", () => {
        const tab = button.getAttribute("data-research-tab");
        tabButtons.forEach((item) => item.classList.toggle("active", item === button));
        document.querySelectorAll("[data-research-panel]").forEach((panel) => {
          panel.hidden = panel.getAttribute("data-research-panel") !== tab;
        });
      });
    });
  }

  const researchFilters = [...document.querySelectorAll("[data-research-filter]")];
  if (researchFilters.length) {
    const applyResearchFilters = () => {
      const values = Object.fromEntries(researchFilters.map((control) => [control.dataset.researchFilter, String(control.value || "")]));
      let visibleCount = 0;
      const cards = [...document.querySelectorAll("[data-research-card]")];
      cards.forEach((card) => {
        const categoryMatches =
          values.category === "all" ||
          !values.category ||
          (values.category === "tested" ? card.dataset.tested === "true" : card.dataset.category === values.category);
        const visible =
          categoryMatches &&
          (!values.market || card.dataset.market === values.market) &&
          (!values.style || card.dataset.style === values.style) &&
          (!values.evidence || card.dataset.evidence === values.evidence);
        card.hidden = !visible;
        if (visible) visibleCount += 1;
      });
      const countTarget = document.getElementById("research-filter-count");
      if (countTarget) countTarget.textContent = `Showing ${visibleCount} of ${cards.length} research strategies.`;
    };
    researchFilters.forEach((control) => control.addEventListener("change", applyResearchFilters));
    applyResearchFilters();
  }

  const modal = document.getElementById("backtest-modal");
  const form = document.getElementById("backtest-form");
  const status = document.getElementById("backtest-request-status");
  const strategyInput = document.getElementById("backtest-strategy-name");
  const title = document.getElementById("backtest-strategy-title");
  const historyTarget = document.getElementById("backtest-request-history");
  const indicatorInput = document.getElementById("backtest-indicator-instructions");
  updateResearchRequestBadges();
  document.querySelectorAll("[data-backtest-strategy]").forEach((button) => {
    button.addEventListener("click", () => {
      const strategy = button.getAttribute("data-backtest-strategy") || "";
      if (strategyInput) strategyInput.value = strategy;
      if (title) title.textContent = strategy;
      if (indicatorInput) indicatorInput.value = button.getAttribute("data-backtest-indicators") || indicatorGuidanceForStrategy(strategy);
      if (status) status.textContent = "";
      if (historyTarget) historyTarget.innerHTML = renderBacktestRequestHistory(strategy);
      if (modal?.showModal) modal.showModal();
    });
  });
  document.querySelectorAll("[data-close-modal]").forEach((button) => {
    button.addEventListener("click", () => modal?.close());
  });
  if (form) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submitButton = form.querySelector('button[type="submit"]');
      if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent = "Creating...";
      }
      if (status) status.textContent = "Creating cache-native Paperclip backtest issue...";
      const formData = new FormData(form);
      const payload = {
        strategyName: formData.get("strategyName"),
        duration: formData.get("duration"),
        timeframe: formData.get("timeframe"),
        indicatorInstructions: formData.get("indicatorInstructions"),
        optimization: formData.get("optimization") === "on",
        notes: formData.get("notes"),
      };
      try {
        const response = await fetch("/api/backtest-request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || "Request failed");
        rememberBacktestRequest(result.request || {
          strategyName: payload.strategyName,
          duration: payload.duration,
          timeframe: payload.timeframe,
          indicatorInstructions: payload.indicatorInstructions,
          optimization: payload.optimization,
          status: "requested",
          backtestExecutionMode: "cache_native_sierra_historical_cache",
          requestedAtUtc: new Date().toISOString(),
          issueId: result.issueId,
          identifier: result.identifier,
          url: result.url,
        });
        updateResearchRequestBadges();
        form.reset();
        modal?.close();
      } catch (error) {
        if (status) status.textContent = `Could not create request: ${String(error.message || error)}`;
      } finally {
        if (submitButton) {
          submitButton.disabled = false;
          submitButton.textContent = "Create backtest request";
        }
      }
    });
  }

  const manualModal = document.getElementById("manual-strategy-modal");
  const manualForm = document.getElementById("manual-strategy-form");
  const manualStatus = document.getElementById("manual-strategy-request-status");
  document.querySelectorAll("[data-manual-strategy-request]").forEach((button) => {
    button.addEventListener("click", () => {
      manualForm?.reset();
      if (manualStatus) manualStatus.textContent = "";
      if (manualModal?.showModal) manualModal.showModal();
    });
  });
  document.querySelectorAll("[data-close-manual-modal]").forEach((button) => {
    button.addEventListener("click", () => manualModal?.close());
  });
  if (manualForm) {
    manualForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (manualStatus) manualStatus.textContent = "Creating cache-native manual strategy request...";
      const formData = new FormData(manualForm);
      const payload = {
        strategyName: formData.get("strategyName"),
        duration: formData.get("duration"),
        timeframe: formData.get("timeframe"),
        instrument: formData.get("instrument"),
        contractQuantity: formData.get("contractQuantity"),
        tradeDirection: formData.get("tradeDirection"),
        sessionWindows: formData.get("sessionWindows"),
        userTimezone: formData.get("userTimezone"),
        strategyTimezone: formData.get("strategyTimezone"),
        maximumRiskDollars: formData.get("maximumRiskDollars"),
        suggestedStrategy: formData.get("suggestedStrategy"),
        rulesSummary: formData.get("rulesSummary"),
        optimization: formData.get("optimization") === "on",
        notes: formData.get("notes"),
        requestType: "manual_strategy",
      };
      const file = formData.get("strategyFile");
      if (file && file.size > 0) {
        if (file.size > 1_500_000) {
          if (manualStatus) manualStatus.textContent = "Upload is too large. Please keep strategy files below 1.5 MB.";
          return;
        }
        payload.uploadedFile = {
          name: file.name,
          type: file.type || "text/plain",
          size: file.size,
          content: await file.text(),
        };
      }
      try {
        const response = await fetch("/api/backtest-request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || "Request failed");
        rememberBacktestRequest(result.request || {
          strategyName: payload.strategyName,
          duration: payload.duration,
          timeframe: payload.timeframe,
          optimization: payload.optimization,
          status: "requested",
          requestType: "manual_strategy",
          userTimezone: payload.userTimezone,
          maximumRiskDollars: payload.maximumRiskDollars,
          backtestExecutionMode: "cache_native_sierra_historical_cache",
          requestedAtUtc: new Date().toISOString(),
          issueId: result.issueId,
          identifier: result.identifier,
          url: result.url,
        });
        updateResearchRequestBadges();
        manualForm.reset();
        manualModal?.close();
      } catch (error) {
        if (manualStatus) manualStatus.textContent = `Could not create request: ${String(error.message || error)}`;
      }
    });
  }
}

function drawBarChart(canvasId, rows, config) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !rows?.length) return;
  const { ctx, width, height } = clearCanvas(canvas);
  const margin = { top: 18, right: 18, bottom: 52, left: 54 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const values = rows.map((row) => Math.max(0, Number(config.value(row)) || 0));
  const max = Math.max(...values, 1);

  ctx.font = "12px Segoe UI, Arial";
  ctx.strokeStyle = "#d8dee9";
  ctx.fillStyle = "#475569";
  ctx.beginPath();
  ctx.moveTo(margin.left, margin.top);
  ctx.lineTo(margin.left, margin.top + plotHeight);
  ctx.lineTo(margin.left + plotWidth, margin.top + plotHeight);
  ctx.stroke();

  const gap = 14;
  const barWidth = Math.max(18, (plotWidth - gap * (rows.length - 1)) / rows.length);
  rows.forEach((row, index) => {
    const value = values[index];
    const barHeight = (value / max) * plotHeight;
    const x = margin.left + index * (barWidth + gap);
    const y = margin.top + plotHeight - barHeight;
    ctx.fillStyle = config.color(row, index);
    ctx.fillRect(x, y, barWidth, barHeight);
    ctx.fillStyle = "#0f172a";
    ctx.textAlign = "center";
    ctx.fillText(config.format(value), x + barWidth / 2, Math.max(12, y - 6));
    ctx.save();
    ctx.translate(x + barWidth / 2, margin.top + plotHeight + 12);
    ctx.rotate(-0.45);
    ctx.fillStyle = "#475569";
    ctx.fillText(String(row.strategy || row.title || "").slice(0, 24), 0, 0);
    ctx.restore();
  });
}

function drawStackedLongShort(canvasId, rows) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !rows?.length) return;
  const { ctx, width, height } = clearCanvas(canvas);
  const margin = { top: 18, right: 18, bottom: 52, left: 54 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const max = Math.max(...rows.map((row) => Number(row.longTrades || 0) + Number(row.shortTrades || 0)), 1);
  const gap = 14;
  const barWidth = Math.max(18, (plotWidth - gap * (rows.length - 1)) / rows.length);

  ctx.font = "12px Segoe UI, Arial";
  ctx.strokeStyle = "#d8dee9";
  ctx.beginPath();
  ctx.moveTo(margin.left, margin.top);
  ctx.lineTo(margin.left, margin.top + plotHeight);
  ctx.lineTo(margin.left + plotWidth, margin.top + plotHeight);
  ctx.stroke();

  rows.forEach((row, index) => {
    const longTrades = Number(row.longTrades || 0);
    const shortTrades = Number(row.shortTrades || 0);
    const x = margin.left + index * (barWidth + gap);
    const longHeight = (longTrades / max) * plotHeight;
    const shortHeight = (shortTrades / max) * plotHeight;
    const baseY = margin.top + plotHeight;
    ctx.fillStyle = "#2563eb";
    ctx.fillRect(x, baseY - longHeight, barWidth, longHeight);
    ctx.fillStyle = "#ef4444";
    ctx.fillRect(x, baseY - longHeight - shortHeight, barWidth, shortHeight);
    ctx.fillStyle = "#0f172a";
    ctx.textAlign = "center";
    ctx.fillText(`${longTrades}/${shortTrades}`, x + barWidth / 2, baseY - longHeight - shortHeight - 6);
    ctx.save();
    ctx.translate(x + barWidth / 2, baseY + 12);
    ctx.rotate(-0.45);
    ctx.fillStyle = "#475569";
    ctx.fillText(String(row.strategy || "").slice(0, 24), 0, 0);
    ctx.restore();
  });
}

function drawLedgerCharts(manifest) {
  const paperTrades = paperClosedTrades(manifest)
    .slice()
    .sort((a, b) => new Date(a.exitAtUtc || a.tradeDateUtc || 0) - new Date(b.exitAtUtc || b.tradeDateUtc || 0));
  const pnlCanvas = document.getElementById("ledgerPnlChart");
  if (pnlCanvas) {
    const { ctx, width, height } = clearCanvas(pnlCanvas);
    const values = paperTrades.reduce((points, trade) => {
      const previous = points.length ? points[points.length - 1] : 0;
      points.push(previous + (Number(trade.realizedPnlDollars) || 0));
      return points;
    }, []);
    const margin = { top: 20, right: 18, bottom: 34, left: 44 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    ctx.font = "12px Segoe UI, Arial";
    ctx.strokeStyle = "#d8dee9";
    ctx.beginPath();
    ctx.moveTo(margin.left, margin.top);
    ctx.lineTo(margin.left, margin.top + plotHeight);
    ctx.lineTo(margin.left + plotWidth, margin.top + plotHeight);
    ctx.stroke();
    if (values.length) {
      const minValue = Math.min(0, ...values);
      const maxValue = Math.max(0, ...values);
      const range = Math.max(maxValue - minValue, 1);
      ctx.strokeStyle = "#2563eb";
      ctx.lineWidth = 3;
      ctx.beginPath();
      values.forEach((value, index) => {
        const x = margin.left + (values.length === 1 ? plotWidth / 2 : (plotWidth / (values.length - 1)) * index);
        const y = margin.top + plotHeight - ((value - minValue) / range) * plotHeight;
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.fillStyle = "#0f172a";
      ctx.textAlign = "right";
      ctx.fillText(formatCurrency(values[values.length - 1]), width - margin.right, margin.top + 12);
    } else {
      ctx.fillStyle = "#64748b";
      ctx.textAlign = "center";
      ctx.fillText("No paper trades imported yet", width / 2, margin.top + plotHeight / 2 - 12);
    }
  }

  const outcomeCanvas = document.getElementById("ledgerOutcomeChart");
  if (outcomeCanvas) {
    const wins = paperTrades.filter((trade) => Number(trade.realizedPnlDollars) > 0).length;
    const losses = paperTrades.filter((trade) => Number(trade.realizedPnlDollars) < 0).length;
    const scratch = paperTrades.filter((trade) => Number(trade.realizedPnlDollars) === 0).length;
    const values = [
      { label: "Wins", value: wins, color: "#15803d" },
      { label: "Losses", value: losses, color: "#dc2626" },
      { label: "Flat", value: scratch, color: "#2563eb" },
    ];
    drawBarChart("ledgerOutcomeChart", values, {
      value: (row) => row.value,
      format: (value) => String(value),
      color: (row) => row.color,
    });
  }
}

function renderCharts(rows) {
  const palette = ["#2563eb", "#16a34a", "#f59e0b", "#7c3aed"];
  drawBarChart("profitChart", rows, {
    value: (row) => row.netProfitDollars,
    format: formatCurrency,
    color: (_row, index) => palette[index % palette.length],
  });
  drawBarChart("drawdownChart", rows, {
    value: (row) => row.maxDrawdownDollars,
    format: formatCurrency,
    color: () => "#ef4444",
  });
  drawBarChart("winRateChart", rows, {
    value: (row) => Number(row.winRate || 0) * 100,
    format: (value) => `${value.toFixed(1)}%`,
    color: () => "#16a34a",
  });
  drawBarChart("tradeCountChart", rows, {
    value: (row) => row.trades,
    format: (value) => String(value),
    color: () => "#0f766e",
  });
  drawStackedLongShort("directionChart", rows);
}

function renderDashboardSummary(manifest) {
  const ledger = manifest.ledger?.latestLedger || {};
  const daily = manifest.dailyReport || {};
  const metrics = currentStrategyPerformanceRows(manifest);
  const paper = manifest.tradingModes?.paper || {};
  const live = manifest.tradingModes?.live || {};
  const paperAccount = paperAccountSizeSummary(paper);
  const paperPnl = paperRealizedPnlSummary(paper);
  const liveClosedPnl = pnlSummary(selectedModeTrades(manifest, "live"));
  const lucid = manifest.riskProfiles?.lucidFlex50k || {};
  const totalTrades = metrics.reduce((sum, row) => sum + (Number(row.trades) || 0), 0);
  const tradedMetrics = metrics.filter((row) => Number(row.trades) > 0);
  const best = tradedMetrics
    .slice()
    .sort((a, b) => (Number(b.winRate) || 0) - (Number(a.winRate) || 0))[0];
  const worstDrawdown = tradedMetrics
    .slice()
    .sort((a, b) => (Number(b.maxDrawdownDollars) || 0) - (Number(a.maxDrawdownDollars) || 0))[0];

  return `
    ${summaryTile("Paper status", ledger.paperTradingPerformed || "n/a", ledger.paperTradingPerformed === "no" ? "warn" : "good")}
    ${summaryTile("Paper strategies", paper.strategies?.length || 0)}
    ${summaryTile("Paper account value", paperAccount.accountSizeDollars === null ? "n/a" : formatCurrency(paperAccount.accountSizeDollars), paperAccount.accountSizeDollars < 0 ? "warn" : "good")}
    ${summaryTile("Paper realised P&L", formatCurrency(paperPnl.net), paperPnl.net < 0 ? "warn" : "good")}
    ${summaryTile("Sierra balance P&L", paperAccount.dailyPnlDollars === null ? "n/a" : formatCurrency(paperAccount.dailyPnlDollars), paperAccount.dailyPnlDollars < 0 ? "warn" : "good")}
    ${summaryTile("Live status", humanizeStatus(live.status), "warn")}
    ${summaryTile("Live manual fills", live.importSummary?.manualFills || 0, live.importSummary?.manualFills ? "warn" : "neutral")}
    ${summaryTile("Live closed P&L", formatCurrency(liveClosedPnl.net), liveClosedPnl.net < 0 ? "warn" : "good")}
    ${summaryTile("Lucid Flex MLL", formatCurrency(lucid.evaluation?.maxLossLimitDollars || 2000), "warn")}
    ${summaryTile("Today strategy trades", totalTrades)}
    ${summaryTile("Best win-rate strategy", best?.strategy || "n/a", "good")}
    ${summaryTile("Largest drawdown", worstDrawdown ? `${worstDrawdown.strategy}: ${formatCurrency(worstDrawdown.maxDrawdownDollars)}` : "n/a", "warn")}
    <section class="panel monitor-activity-panel" id="monitor-activity-panel">
      <p class="empty">Loading monitor activity...</p>
    </section>
  `;
}

function renderHeader(manifest) {
  const generated = manifest.generatedAtUtc
    ? new Date(manifest.generatedAtUtc).toLocaleString("en-GB", { timeZone: "Europe/London" })
    : "n/a";
  const target = document.getElementById("generated");
  if (target) target.textContent = `Last generated: ${generated} UK`;
  setupNavigation();
}

function setupNavigation() {
  function ensureNavLink(nav, page, href, text, afterPage) {
    if (nav.querySelector(`[data-nav-page="${page}"]`)) return;
    const link = document.createElement("a");
    link.href = href;
    link.dataset.navPage = page;
    link.textContent = text;
    const after = afterPage ? nav.querySelector(`[data-nav-page="${afterPage}"]`) : null;
    if (after?.nextSibling) {
      nav.insertBefore(link, after.nextSibling);
    } else if (after) {
      nav.appendChild(link);
    } else {
      nav.appendChild(link);
    }
  }

  document.querySelectorAll(".main-nav").forEach((nav) => {
    nav.querySelectorAll('[data-nav-page="markov"]').forEach((link) => {
      link.href = "/confluence.html";
      link.dataset.navPage = "confluence";
      link.textContent = "Confluence";
    });
    ensureNavLink(nav, "confluence", "/confluence.html", "Confluence", "strategies");
    ensureNavLink(nav, "hmm-strategy", "/hmm-strategy.html", "HMM Strategy", "confluence");
    ensureNavLink(nav, "replay", "/replay-monitor.html", "Replay", "open");
    ensureNavLink(nav, "improvement", "/improvement/dashboard", "Continuous Improvement", "strategies");
  });
  const page = document.body?.dataset?.page || "dashboard";
  const labels = {
    dashboard: "Dashboard",
    paper: "Paper Trading",
    live: "Live Trading",
    open: "Open Trades",
    replay: "Replay Monitor",
    ledger: "Ledgers",
    daily: "Daily Report",
    research: "Research",
    strategies: "Strategies",
    sources: "Source Artifacts",
    rules: "Prop Firm Rules",
    markov: "Markov Regime",
    confluence: "Confluence",
    "hmm-strategy": "HMM Strategy Monitor",
  };
  document.querySelectorAll("[data-nav-page]").forEach((link) => {
    link.classList.toggle("active", link.getAttribute("data-nav-page") === page);
  });
  const current = document.getElementById("breadcrumb-current");
  if (current) current.textContent = labels[page] || "Current Page";
  refreshPaperclipNavLinks();
  document.querySelectorAll("[data-nav-back]").forEach((button) => {
    if (button.dataset.bound === "true") return;
    button.dataset.bound = "true";
    button.addEventListener("click", () => {
      if (window.history.length > 1) {
        window.history.back();
      } else {
        window.location.href = "/";
      }
    });
  });
}

async function refreshPaperclipNavLinks() {
  const links = [...document.querySelectorAll('[data-nav-page="paperclip"]')];
  if (!links.length) return;
  try {
    const response = await fetch("/api/site-config");
    const payload = await response.json();
    if (!response.ok || !payload.ok || !payload.paperclip?.dashboardUrl) return;
    links.forEach((link) => {
      link.href = payload.paperclip.dashboardUrl;
    });
  } catch {
    // Keep the neutral placeholder if the local server config endpoint is unavailable.
  }
}

async function refreshMonitorButton() {
  const buttons = [...document.querySelectorAll("[data-monitor-toggle]")];
  if (!buttons.length) return;
  try {
    const response = await fetch("/api/monitor/status");
    const state = await response.json();
    buttons.forEach((button) => {
      button.dataset.monitorRunning = state.running ? "true" : "false";
      button.setAttribute("aria-pressed", state.running ? "true" : "false");
      button.textContent = state.running ? "Monitor On" : "Monitor Off";
      button.classList.toggle("active", Boolean(state.running));
      button.title = `Monitor status: ${state.status || "unknown"}${state.lastScanAtUtc ? ` | last scan ${formatMonitorTimestamp(state.lastScanAtUtc)}` : ""}`;
      button.disabled = false;
    });
    const panel = document.getElementById("monitor-activity-panel");
    if (panel) panel.innerHTML = renderMonitorActivity(state);
  } catch {
    buttons.forEach((button) => {
      button.dataset.monitorRunning = "false";
      button.setAttribute("aria-pressed", "false");
      button.textContent = "Monitor Error";
      button.classList.remove("active");
      button.disabled = false;
    });
    const panel = document.getElementById("monitor-activity-panel");
    if (panel) panel.innerHTML = '<p class="empty">Monitor status unavailable right now.</p>';
  }
}

function bindMonitorButton() {
  document.querySelectorAll("[data-monitor-toggle]").forEach((button) => {
    if (button.dataset.bound === "true") return;
    button.dataset.bound = "true";
    button.addEventListener("click", async () => {
      const isOn = button.dataset.monitorRunning === "true";
      button.disabled = true;
      button.textContent = isOn ? "Stopping..." : "Starting...";
      try {
        await fetch(isOn ? "/api/monitor/stop" : "/api/monitor/start", { method: "POST" }).catch(() => null);
        if (!isOn && document.getElementById("replay-monitor")) {
          await fetch("/api/monitor/reconcile", { method: "POST" }).catch(() => null);
          await load();
          return;
        }
        await refreshMonitorButton();
      } finally {
        button.disabled = false;
      }
    });
  });
}

function ceoChatEnabled() {
  return window.localStorage.getItem("oceanTradingCeoChatEnabled") !== "false";
}

function ceoChatOpen() {
  return window.localStorage.getItem("oceanTradingCeoChatOpen") === "true";
}

function isCeoReplyComment(comment) {
  if (!comment) return false;
  if (comment.authorType === "agent") return true;
  return comment.authorType === "user" && Boolean(comment.createdByRunId);
}

function commentAuthorLabel(comment) {
  if (isCeoReplyComment(comment)) return "CEO";
  if (comment.authorType === "user") return "You";
  if (comment.authorType === "system") return "Paperclip";
  return comment.createdByAgentName || comment.agentName || comment.authorName || comment.authorType || "Paperclip";
}

function isCeoChatHousekeepingComment(comment) {
  const body = String(comment.body || comment.content || "").toLowerCase();
  return comment.authorType === "system"
    || body.includes("no new website chat payload")
    || body.includes("no new website comment")
    || body.includes("no new website board message")
    || body.includes("kept the standing handoff container issue")
    || body.includes("no pending handoff actions")
    || body.includes("reviewed completed child recovery issue");
}

function renderCeoChatMessages(payload) {
  const comments = (payload?.comments || []).filter((comment) => !isCeoChatHousekeepingComment(comment));
  const activeRun = payload?.activeRun;
  const liveRuns = payload?.liveRuns || [];
  const latestRun = activeRun || liveRuns[0] || null;
  return `
    <div class="ceo-chat-thread">
      ${
        comments.length
          ? comments.map((comment) => `
            <article class="ceo-chat-message ${isCeoReplyComment(comment) ? "agent" : "operator"}">
              <header>
                <strong>${escapeHtml(commentAuthorLabel(comment))}</strong>
                <span>${escapeHtml(formatChatTime(comment.createdAt || comment.createdAtUtc))}</span>
              </header>
              <p>${escapeHtml(comment.body || comment.content || "")}</p>
            </article>
          `).join("")
          : '<p class="empty">No CEO chat messages yet.</p>'
      }
      ${
        latestRun
          ? `<div class="ceo-chat-run">CEO run: ${escapeHtml(humanizeStatus(latestRun.status || "queued"))}</div>`
          : ""
      }
    </div>
  `;
}

async function refreshCeoChat() {
  const drawer = document.querySelector("[data-ceo-chat]");
  if (!drawer || drawer.dataset.enabled !== "true") return;
  const status = drawer.querySelector("[data-ceo-chat-status]");
  const messages = drawer.querySelector("[data-ceo-chat-messages]");
  const issueLink = drawer.querySelector("[data-ceo-chat-issue]");
  try {
    const response = await fetch("/api/ceo-chat");
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || "CEO chat failed");
    if (status) {
      status.textContent = payload.chatState?.label
        || (payload.activeRun ? `CEO ${humanizeStatus(payload.activeRun.status)}` : "Ready");
    }
    if (issueLink && payload.issue?.url) {
      issueLink.href = payload.issue.url;
      issueLink.textContent = payload.issue.identifier || "Open Paperclip";
    }
    if (messages) {
      messages.innerHTML = renderCeoChatMessages(payload);
      messages.scrollTop = messages.scrollHeight;
    }
  } catch (error) {
    if (status) status.textContent = `Offline: ${String(error.message || error)}`;
  }
}

async function sendCeoChatMessage(form) {
  const drawer = document.querySelector("[data-ceo-chat]");
  const input = form.querySelector("[name='message']");
  const status = drawer?.querySelector("[data-ceo-chat-status]");
  const message = String(input?.value || "").trim();
  if (!message) return;
  if (status) status.textContent = "Sending...";
  input.disabled = true;
  form.querySelector("button[type='submit']").disabled = true;
  try {
    const response = await fetch("/api/ceo-chat/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || "Failed to send CEO chat message");
    input.value = "";
    if (status) {
      status.textContent = payload.wakeupError
        ? "Message posted; wakeup needs review"
        : (payload.chatState?.label || "CEO wake requested");
    }
    const messages = drawer?.querySelector("[data-ceo-chat-messages]");
    if (messages) {
      messages.innerHTML = renderCeoChatMessages(payload);
      messages.scrollTop = messages.scrollHeight;
    }
  } catch (error) {
    if (status) status.textContent = `Send failed: ${String(error.message || error)}`;
  } finally {
    input.disabled = false;
    form.querySelector("button[type='submit']").disabled = false;
    input.focus();
  }
}

function setCeoChatState({ enabled, open } = {}) {
  const drawer = document.querySelector("[data-ceo-chat]");
  if (!drawer) return;
  const nextEnabled = enabled ?? drawer.dataset.enabled === "true";
  const nextOpen = open ?? drawer.classList.contains("open");
  drawer.dataset.enabled = String(nextEnabled);
  drawer.classList.toggle("open", nextEnabled && nextOpen);
  drawer.classList.toggle("disabled", !nextEnabled);
  window.localStorage.setItem("oceanTradingCeoChatEnabled", String(nextEnabled));
  window.localStorage.setItem("oceanTradingCeoChatOpen", String(nextOpen));
  document.querySelectorAll("[data-ceo-chat-toggle]").forEach((toggle) => {
    toggle.textContent = nextEnabled && nextOpen ? "Hide CEO Chat" : "CEO Chat";
  });
  const openNow = nextEnabled && nextOpen;
  const enable = drawer.querySelector("[data-ceo-chat-enable]");
  if (enable) enable.textContent = nextEnabled ? "Disable" : "Enable";
  const panelToggle = drawer.querySelector("[data-ceo-chat-panel-toggle]");
  if (panelToggle) {
    panelToggle.textContent = openNow ? "Close CEO Chat" : "Open CEO Chat";
    panelToggle.setAttribute("aria-expanded", String(openNow));
  }
  if (openNow) refreshCeoChat();
}

function toggleCeoChatDrawer(drawer = document.querySelector("[data-ceo-chat]")) {
  if (!drawer) return;
  const enabled = drawer.dataset.enabled === "true";
  const open = drawer.classList.contains("open");
  if (!enabled) {
    setCeoChatState({ enabled: true, open: true });
    return;
  }
  setCeoChatState({ enabled: true, open: !open });
}

function ensureHeaderActions() {
  const replayActions = document.querySelector(".replay-title-actions");
  if (replayActions) return replayActions;
  const monitor = document.querySelector("[data-monitor-toggle]");
  if (!monitor) return null;
  let actions = monitor.closest(".breadcrumb-actions");
  if (!actions) {
    actions = document.createElement("div");
    actions.className = "breadcrumb-actions";
    monitor.parentElement.insertBefore(actions, monitor);
    actions.appendChild(monitor);
  }
  actions.querySelector("[data-ceo-chat-toggle]")?.remove();
  return actions;
}

function mountCeoChatShell() {
  const shell = document.querySelector("[data-ceo-chat]");
  const actions = ensureHeaderActions();
  if (!shell || !actions || shell.parentElement === actions) return;
  actions.appendChild(shell);
}

function initCeoChat() {
  if (document.querySelector("[data-ceo-chat]")) {
    mountCeoChatShell();
    return;
  }
  const shell = document.createElement("aside");
  shell.className = "ceo-chat";
  shell.dataset.ceoChat = "true";
  shell.dataset.enabled = String(ceoChatEnabled());
  shell.innerHTML = `
    <button class="ceo-chat-tab" type="button" data-ceo-chat-panel-toggle aria-controls="ceo-chat-panel" aria-expanded="false">Open CEO Chat</button>
    <section class="ceo-chat-panel" id="ceo-chat-panel" aria-label="Paperclip CEO chat">
      <header>
        <div>
          <h2>CEO Chat</h2>
          <p data-ceo-chat-status>Ready</p>
        </div>
        <div class="ceo-chat-actions">
          <a class="text-link" href="#" target="_blank" rel="noreferrer" data-ceo-chat-issue>Paperclip</a>
          <button type="button" data-ceo-chat-enable>Disable</button>
        </div>
      </header>
      <div class="ceo-chat-messages" data-ceo-chat-messages></div>
      <form class="ceo-chat-form" data-ceo-chat-form>
        <textarea name="message" rows="3" placeholder="Message the Paperclip CEO..."></textarea>
        <button type="submit">Send</button>
      </form>
    </section>
  `;
  (ensureHeaderActions() || document.body).appendChild(shell);
  shell.querySelector("[data-ceo-chat-panel-toggle]")?.addEventListener("click", () => {
    toggleCeoChatDrawer(shell);
  });
  shell.querySelector("[data-ceo-chat-enable]").addEventListener("click", () => {
    setCeoChatState({ enabled: shell.dataset.enabled !== "true", open: true });
  });
  shell.querySelector("[data-ceo-chat-form]").addEventListener("submit", (event) => {
    event.preventDefault();
    sendCeoChatMessage(event.currentTarget);
  });
  setCeoChatState({ enabled: ceoChatEnabled(), open: ceoChatOpen() });
}

let tradeAlertInitialized = false;
let tradeAlertIds = new Set();
let tradeAudioContext = null;

function tradeEventId(mode, type, trade) {
  return [
    mode,
    type,
    trade.account,
    trade.symbol,
    trade.strategyName,
    trade.side,
    trade.quantity,
    trade.entryAtUtc || trade.openedAtUtc || trade.tradeDateUtc,
    trade.exitAtUtc || trade.lastUpdatedUtc || "",
    trade.internalOrderId || "",
  ].join("|");
}

function collectTradeEventIds(data) {
  const ids = new Set();
  for (const mode of ["live", "paper"]) {
    const payload = data?.[mode] || {};
    for (const trade of payload.openPositions || []) ids.add(tradeEventId(mode, "open", trade));
    for (const trade of payload.todayClosedTrades || []) ids.add(tradeEventId(mode, "closed", trade));
  }
  return ids;
}

function beepForTradeEvent() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  tradeAudioContext ||= new AudioContext();
  if (tradeAudioContext.state === "suspended") tradeAudioContext.resume().catch(() => null);
  const oscillator = tradeAudioContext.createOscillator();
  const gain = tradeAudioContext.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(880, tradeAudioContext.currentTime);
  gain.gain.setValueAtTime(0.0001, tradeAudioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.12, tradeAudioContext.currentTime + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, tradeAudioContext.currentTime + 0.22);
  oscillator.connect(gain);
  gain.connect(tradeAudioContext.destination);
  oscillator.start();
  oscillator.stop(tradeAudioContext.currentTime + 0.24);
}

function handleTradeAlerts(data) {
  const nextIds = collectTradeEventIds(data);
  if (!tradeAlertInitialized) {
    tradeAlertIds = nextIds;
    tradeAlertInitialized = true;
    return;
  }
  const hasNewTradeEvent = [...nextIds].some((id) => !tradeAlertIds.has(id));
  tradeAlertIds = nextIds;
  if (hasNewTradeEvent) beepForTradeEvent();
}

async function loadOpenTrades() {
  const target = document.getElementById("open-trades");
  if (!target) return;
  try {
    const response = await fetch("/api/open-trades");
    const data = await response.json();
    handleTradeAlerts(data);
    target.innerHTML = renderOpenTradesPage(data);
    const generated = document.getElementById("generated");
    if (generated) generated.textContent = `Last refreshed: ${new Date().toLocaleString("en-GB", { timeZone: "Europe/London" })} UK`;
    bindTableFilters(target);
    enhanceTables(target);
  } catch (error) {
    if (target) target.textContent = `Failed to load open trades: ${String(error.message || error)}`;
  }
}

async function loadHistoricalCache() {
  const target = document.getElementById("historical-cache");
  if (!target) return;
  try {
    const response = await fetch("/api/historical-cache");
    const cache = await response.json();
    target.innerHTML = renderHistoricalCache(cache);
    bindTableFilters(target);
    enhanceTables(target);
  } catch (error) {
    target.innerHTML = `<p class="empty">Failed to load historical cache: ${escapeHtml(error.message || error)}</p>`;
  }
}

async function loadBacktestEngineRuns() {
  const target = document.getElementById("backtest-engine-runs");
  if (!target) return;
  try {
    const response = await fetch("/api/backtest-engine-runs");
    const payload = await response.json();
    target.innerHTML = renderBacktestEngineRuns(payload);
    bindTableFilters(target);
    enhanceTables(target);
  } catch (error) {
    target.innerHTML = `<p class="empty">Failed to load backtester engine runs: ${escapeHtml(error.message || error)}</p>`;
  }
}

async function loadMarkovRegime() {
  const target = document.getElementById("markov-regime");
  if (!target) return;
  try {
    const response = await fetch("/api/markov-regime");
    const payload = await response.json();
    target.innerHTML = renderMarkovRegimePage(payload);
    bindMarkovActions(target);
    bindTableFilters(target);
    enhanceTables(target);
  } catch (error) {
    target.innerHTML = `<p class="empty">Failed to load Markov Regime Engine: ${escapeHtml(error.message || error)}</p>`;
  }
}

const CONFLUENCE_AUTO_REFRESH_MS = 60_000;
let confluenceRefreshTimer = null;
let confluenceRefreshInFlight = false;

function updateGeneratedStampFromPayload(payload, prefix = "Last Confluence refresh") {
  const generated = document.getElementById("generated");
  if (!generated) return;
  const stamp = payload?.generatedAtUtc
    ? new Date(payload.generatedAtUtc).toLocaleString("en-GB", { timeZone: "Europe/London" })
    : "n/a";
  generated.textContent = `${prefix}: ${stamp} UK`;
}

function startConfluenceAutoRefresh() {
  const target = document.getElementById("confluence-report");
  if (!target || confluenceRefreshTimer) return;
  target.dataset.autoRefresh = "true";
  target.dataset.autoRefreshMs = String(CONFLUENCE_AUTO_REFRESH_MS);
  confluenceRefreshTimer = window.setInterval(() => {
    void loadConfluenceReport({ silent: true });
  }, CONFLUENCE_AUTO_REFRESH_MS);
}

async function loadConfluenceReport(options = {}) {
  const target = document.getElementById("confluence-report");
  if (!target) return;
  if (confluenceRefreshInFlight) return;
  confluenceRefreshInFlight = true;
  try {
    const response = await fetch("/api/confluence-report");
    const payload = await response.json();
    if (!response.ok || payload.ok === false) throw new Error(payload.error || `Request failed with ${response.status}`);
    updateGeneratedStampFromPayload(payload);
    target.innerHTML = renderConfluenceReportPage(payload);
    target.dataset.autoRefresh = "true";
    target.dataset.autoRefreshMs = String(payload.autoRefresh?.refreshIntervalMs || CONFLUENCE_AUTO_REFRESH_MS);
    bindConfluenceActions(target);
    bindTableFilters(target);
    enhanceTables(target);
    startConfluenceAutoRefresh();
  } catch (error) {
    if (!options.silent) {
      target.innerHTML = `<p class="empty">Failed to load Confluence report: ${escapeHtml(error.message || error)}</p>`;
    }
  } finally {
    confluenceRefreshInFlight = false;
  }
}

function bindHmmStrategyMonitorActions(root = document, payload = {}) {
  const input = root.querySelector("[data-hmm-strategy-name]");
  const note = root.querySelector("[data-hmm-strategy-note]");
  const selectedTarget = root.querySelector("[data-hmm-selected-strategy]");
  const actionStatus = root.querySelector("[data-hmm-action-status]");
  const startButton = root.querySelector("[data-hmm-start-evaluation]");
  const resolveBlockerButton = root.querySelector("[data-hmm-resolve-blocker]");
  const blockerActionStatus = root.querySelector("[data-hmm-blocker-action-status]");
  const persistDraft = () => saveHmmStrategyDraft({
    strategyName: input?.value || "",
    notes: note?.value || "",
  });
  const renderSelected = () => {
    if (selectedTarget) selectedTarget.innerHTML = renderHmmSelectedStrategyCard(payload, input?.value || "");
  };
  if (input && input.dataset.bound !== "true") {
    input.dataset.bound = "true";
    input.addEventListener("input", () => {
      persistDraft();
      renderSelected();
    });
    input.addEventListener("change", () => {
      persistDraft();
      renderSelected();
    });
  }
  if (note && note.dataset.bound !== "true") {
    note.dataset.bound = "true";
    note.addEventListener("input", persistDraft);
    note.addEventListener("change", persistDraft);
  }
  renderSelected();
  if (startButton && startButton.dataset.bound !== "true") {
    startButton.dataset.bound = "true";
    startButton.addEventListener("click", async () => {
      const strategyName = String(input?.value || "").trim();
      if (!strategyName) {
        if (actionStatus) actionStatus.textContent = "Enter a strategy name before starting the evaluation job.";
        input?.focus();
        return;
      }
      persistDraft();
      const originalText = startButton.textContent || "Start evaluation job";
      startButton.disabled = true;
      startButton.textContent = "Starting job...";
      if (actionStatus) actionStatus.textContent = "Starting a governed Workflow B evaluation job in Paperclip.";
      try {
        const response = await fetch("/api/hmm-strategy-monitor/evaluations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            strategyName,
            notes: note?.value || "",
          }),
        });
        const result = await response.json();
        if (!response.ok || result.ok === false) throw new Error(result.error || `Request failed with ${response.status}`);
        saveHmmStrategyDraft({
          strategyName,
          notes: note?.value || "",
          lastIssueId: result.issue?.id || "",
          lastIssueIdentifier: result.issue?.identifier || "",
          lastIssueUrl: result.issue?.url || "",
          lastIssueReused: Boolean(result.reused),
          lastIssueStarted: Boolean(result.started),
        });
        if (actionStatus) {
          const verb = result.started ? "Started" : result.reused ? "Using existing" : "Created";
          actionStatus.innerHTML = `${escapeHtml(verb)} Paperclip evaluation job <a class="text-link" href="${escapeHtml(result.issue?.url || "#")}" target="_blank" rel="noopener">${escapeHtml(result.issue?.identifier || result.issue?.id || "Issue")}</a> for ${escapeHtml(result.strategyName)}.`;
        }
      } catch (error) {
        if (actionStatus) actionStatus.textContent = `Evaluation job start failed: ${String(error.message || error)}`;
      } finally {
        startButton.disabled = false;
        startButton.textContent = originalText;
      }
    });
  }
  if (resolveBlockerButton && resolveBlockerButton.dataset.bound !== "true") {
    resolveBlockerButton.dataset.bound = "true";
    resolveBlockerButton.addEventListener("click", async () => {
      const originalText = resolveBlockerButton.textContent || "Resolve blocker";
      resolveBlockerButton.disabled = true;
      resolveBlockerButton.textContent = "Running checks...";
      if (blockerActionStatus) {
        blockerActionStatus.textContent = "Running the registered backend stage action before updating Paperclip.";
      }
      try {
        const response = await fetch("/api/hmm-strategy-monitor/workflow-b/resolve-blocker", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            note: note?.value || "",
          }),
        });
        const result = await response.json();
        if (!response.ok || result.ok === false) throw new Error(result.error || `Request failed with ${response.status}`);
        const updated = (result.updatedIssues || []).map((issue) => issue.identifier || issue.id).filter(Boolean).join(", ");
        const suppressed = Array.isArray(result.suppressedActions) ? result.suppressedActions : [];
        if (blockerActionStatus) {
          if (suppressed.length) {
            const blockers = (suppressed[0].unresolvedBlockers || [])
              .map((blocker) => blocker.identifier || blocker.id)
              .filter(Boolean)
              .join(", ");
            blockerActionStatus.textContent = `Paperclip resume suppressed: unresolved blockers remain${blockers ? ` (${blockers})` : ""}.`;
          } else {
            blockerActionStatus.textContent = `Backend stage action passed. Updated Paperclip: ${updated || "issue status refreshed"}.`;
          }
        }
        await loadHmmStrategyMonitor();
      } catch (error) {
        if (blockerActionStatus) {
          blockerActionStatus.textContent = `Blocker action failed: ${String(error.message || error)}`;
        }
        resolveBlockerButton.disabled = false;
        resolveBlockerButton.textContent = originalText;
      }
    });
  }
}

async function loadHmmStrategyMonitor() {
  const target = document.getElementById("hmm-strategy-monitor");
  if (!target) return;
  try {
    const response = await fetch("/api/hmm-strategy-monitor");
    const payload = await response.json();
    if (!response.ok || payload.ok === false) throw new Error(payload.error || `Request failed with ${response.status}`);
    const generated = document.getElementById("generated");
    if (generated) {
      const stamp = payload.generatedAtUtc
        ? new Date(payload.generatedAtUtc).toLocaleString("en-GB", { timeZone: "Europe/London" })
        : "n/a";
      generated.textContent = `Last HMM refresh: ${stamp} UK`;
    }
    target.innerHTML = renderHmmStrategyMonitorPage(payload);
    bindHmmStrategyMonitorActions(target, payload);
    bindTableFilters(target);
    enhanceTables(target);
  } catch (error) {
    target.innerHTML = `<p class="empty">Failed to load HMM Strategy Monitor: ${escapeHtml(error.message || error)}</p>`;
  }
}

function closeReplayClearModal() {
  document.querySelector("[data-replay-clear-modal]")?.remove();
}

async function executeReplayAccountClear(accountId, accountLabel, triggerButton = null) {
  if (replayActionInFlight) return;
  replayActionInFlight = true;
  if (triggerButton) {
    triggerButton.disabled = true;
    triggerButton.textContent = "Clearing...";
  }
  setReplayActionStatus(`Clearing ${accountLabel} replay data...`);
  try {
    const response = await fetch("/api/replay-monitor/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ replayAccountId: accountId }),
      signal: AbortSignal.timeout(190000),
    });
    const payload = await response.json();
    if (!response.ok || payload.ok === false) throw new Error(payload.error || `Request failed with ${response.status}`);
    closeReplayClearModal();
    setReplayActionStatus(`${accountLabel} replay data cleared at ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} UK.`);
    resetSelectedReplayCalendarMonth();
    resetSelectedReplayCalendarDay();
    await load();
  } catch (error) {
    setReplayActionStatus(`${accountLabel} replay clear failed: ${String(error.message || error)}`);
  } finally {
    replayActionInFlight = false;
    if (triggerButton) {
      triggerButton.disabled = false;
      triggerButton.textContent = `Clear ${accountLabel} data`;
    }
  }
}

function openReplayClearModal(options) {
  closeReplayClearModal();
  const accountId = options.accountId || "Sim1";
  const accountLabel = options.accountLabel || replayAccountDisplayLabel(accountId);
  const trades = Number(options.trades) || 0;
  const days = Number(options.days) || 0;
  const sourceRows = Number(options.sourceRows) || 0;
  const confirmPhrase = options.confirmPhrase || `CLEAR ${accountLabel}`;
  const modal = document.createElement("div");
  modal.className = "replay-clear-modal-backdrop";
  modal.dataset.replayClearModal = "true";
  modal.innerHTML = `
    <div class="replay-clear-modal" role="dialog" aria-modal="true" aria-labelledby="replay-clear-title">
      <div class="replay-clear-modal-title">
        <h2 id="replay-clear-title">Clear replay data for ${escapeHtml(accountLabel)}</h2>
        <button type="button" aria-label="Close clear confirmation" data-replay-clear-cancel>&times;</button>
      </div>
      <div class="replay-clear-modal-body">
        <div class="replay-clear-warning">
          This removes ${escapeHtml(accountLabel)} replay calendar totals, trade rows, and source-row references from the website read model only. Sierra replay logs and the other SIM accounts are not touched.
        </div>
        <div class="replay-clear-summary">
          <div><span>Account</span><strong>${escapeHtml(accountLabel)}</strong></div>
          <div><span>Trades</span><strong>${escapeHtml(formatCount(trades))}</strong></div>
          <div><span>Daily totals</span><strong>${escapeHtml(formatCount(days))}</strong></div>
          <div><span>Source rows</span><strong>${escapeHtml(formatCount(sourceRows))}</strong></div>
        </div>
        <label class="replay-clear-confirm-label">
          <span>Type ${escapeHtml(confirmPhrase)} to confirm</span>
          <input type="text" autocomplete="off" spellcheck="false" data-replay-clear-confirm-input />
        </label>
      </div>
      <div class="replay-clear-modal-actions">
        <button type="button" data-replay-clear-cancel>Cancel</button>
        <button class="dashboard-button danger-solid" type="button" data-replay-clear-confirm-action disabled>Clear ${escapeHtml(accountLabel)} data</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  const input = modal.querySelector("[data-replay-clear-confirm-input]");
  const confirmButton = modal.querySelector("[data-replay-clear-confirm-action]");
  const cancel = () => closeReplayClearModal();
  modal.querySelectorAll("[data-replay-clear-cancel]").forEach((button) => button.addEventListener("click", cancel));
  modal.addEventListener("click", (event) => {
    if (event.target === modal) cancel();
  });
  input?.addEventListener("input", () => {
    confirmButton.disabled = input.value.trim() !== confirmPhrase;
  });
  input?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") cancel();
    if (event.key === "Enter" && !confirmButton.disabled) confirmButton.click();
  });
  confirmButton?.addEventListener("click", () => {
    void executeReplayAccountClear(accountId, accountLabel, confirmButton);
  });
  input?.focus();
}

let replayActionInFlight = false;

async function refreshReplayData(button) {
  if (replayActionInFlight) return;
  replayActionInFlight = true;
  button.disabled = true;
  setReplayActionStatus("Refreshing replay telemetry...");
  try {
    const response = await fetch("/api/monitor/reconcile", { method: "POST", signal: AbortSignal.timeout(95000) });
    const payload = await response.json();
    if (!response.ok || payload.ok === false) throw new Error(payload.error || `Request failed with ${response.status}`);
    setReplayActionStatus(`Rebuild completed at ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} UK.`);
    await load();
  } catch (error) {
    setReplayActionStatus(`Replay refresh failed: ${String(error.message || error)}. You can retry.`);
  } finally {
    replayActionInFlight = false;
    button.disabled = false;
  }
}

function bindReplayMonitorActions(root = document, currentManifest = null) {
  root.querySelectorAll("[data-replay-account-option]").forEach((button) => {
    if (button.dataset.bound === "true") return;
    button.dataset.bound = "true";
    button.addEventListener("click", async (event) => {
      setSelectedReplayAccountId(event.currentTarget.dataset.replayAccountOption || "Sim1");
      resetSelectedReplayCalendarMonth();
      resetSelectedReplayCalendarDay();
      await load();
    });
  });
  root.querySelectorAll("[data-replay-account-select]").forEach((select) => {
    if (select.dataset.bound === "true") return;
    select.dataset.bound = "true";
    select.addEventListener("change", async (event) => {
      setSelectedReplayAccountId(event.currentTarget.value);
      resetSelectedReplayCalendarMonth();
      resetSelectedReplayCalendarDay();
      await load();
    });
  });
  root.querySelectorAll("[data-replay-reconcile]").forEach((button) => {
    if (button.dataset.bound === "true") return;
    button.dataset.bound = "true";
    button.addEventListener("click", () => { void refreshReplayData(button); });
  });
  root.querySelectorAll("[data-replay-clear]").forEach((button) => {
    if (button.dataset.bound === "true") return;
    button.dataset.bound = "true";
    button.addEventListener("click", () => {
      const session = currentManifest?.replayMonitor?.currentSession || {};
      const accountId = button.dataset.replayClearAccountId || selectedReplayAccountId(session);
      const accountLabel = button.dataset.replayClearAccountLabel || replayAccountLabel(session, accountId);
      openReplayClearModal({
        accountId,
        accountLabel,
        trades: button.dataset.replayClearTrades,
        days: button.dataset.replayClearDays,
        sourceRows: button.dataset.replayClearSourceRows,
        confirmPhrase: button.dataset.replayClearConfirm,
      });
    });
  });
}

function bindMarkovActions(root = document) {
  root.querySelectorAll("[data-markov-rebuild]").forEach((button) => {
    if (button.dataset.bound === "true") return;
    button.dataset.bound = "true";
    button.addEventListener("click", async () => {
      const status = root.querySelector("[data-markov-status]");
      button.disabled = true;
      button.textContent = "Refreshing local cache...";
      if (status) status.textContent = "Updating Cody Cache from Sierra data and rebuilding the regime forecast. This can take a minute or two.";
      try {
        const response = await fetch("/api/markov-regime/rebuild", { method: "POST" });
        const payload = await response.json();
        if (!response.ok || payload.ok === false) throw new Error(payload.error || `Request failed with ${response.status}`);
        if (status) status.textContent = "Refresh complete.";
        await loadMarkovRegime();
      } catch (error) {
        if (status) status.textContent = `Refresh failed: ${error.message || error}`;
      } finally {
        button.disabled = false;
        button.textContent = "Refresh cache + rebuild prediction";
      }
    });
  });
}

function bindConfluenceActions(root = document) {
  root.querySelectorAll("[data-confluence-rebuild]").forEach((button) => {
    if (button.dataset.bound === "true") return;
    button.dataset.bound = "true";
    button.addEventListener("click", async () => {
      const status = root.querySelector("[data-confluence-status]");
      button.disabled = true;
      button.textContent = "Recalculating...";
      if (status) status.textContent = "Re-reading Sierra data and rebuilding the multi-timeframe regime layer. This can take a minute or two.";
      try {
        const response = await fetch("/api/confluence-report/rebuild", { method: "POST" });
        const payload = await response.json();
        if (!response.ok || payload.ok === false) throw new Error(payload.error || `Request failed with ${response.status}`);
        if (status) status.textContent = "Refresh complete.";
        await loadConfluenceReport();
      } catch (error) {
        if (status) status.textContent = `Refresh failed: ${error.message || error}`;
      } finally {
        button.disabled = false;
        button.textContent = "Recalculate from Sierra data";
      }
    });
  });
}

async function load(options = {}) {
  try {
    initCeoChat();
    const response = await fetch(options.rebuild ? "/api/rebuild" : "/api/manifest");
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.message || payload?.error || `Request failed with ${response.status}`);
    const manifest = options.rebuild ? payload.manifest : payload;
    renderHeader(manifest);

    const metrics = manifest.perStrategyMetrics || [];
    const currentStrategyMetrics = currentStrategyPerformanceRows(manifest);
    const dashboardSummary = document.getElementById("dashboard-summary");
    if (dashboardSummary) dashboardSummary.innerHTML = renderDashboardSummary(manifest);
    const dashboardPerformanceCalendar = document.getElementById("dashboard-performance-calendar");
    if (dashboardPerformanceCalendar) {
      dashboardPerformanceCalendar.innerHTML = renderDashboardPerformanceCalendar(manifest);
      bindDashboardPerformanceCalendar(manifest);
      startDashboardCalendarFreshnessWatcher();
    }
    const performanceTarget = document.getElementById("performance-split");
    if (performanceTarget) performanceTarget.innerHTML = renderPerformanceSections(manifest.performance);
    const paperSummary = document.getElementById("paper-mode-summary");
    if (paperSummary) paperSummary.textContent = manifest.tradingModes?.paper?.summary || "Paper trading dashboard configured.";
    const liveSummary = document.getElementById("live-mode-summary");
    if (liveSummary) liveSummary.textContent = manifest.tradingModes?.live?.summary || "Live dashboard pending approval.";

    const paperDashboard = document.getElementById("paper-dashboard");
    if (paperDashboard) paperDashboard.innerHTML = renderPaperDashboard(manifest.tradingModes?.paper || {});

    const liveDashboard = document.getElementById("live-dashboard");
    if (liveDashboard) liveDashboard.innerHTML = renderLiveDashboard(manifest);
    bindPerformanceCalendars(manifest);
    bindTableFilters();
    const riskTarget = document.getElementById("risk-profile");
    if (riskTarget) riskTarget.innerHTML = renderLucidRiskProfile(manifest.riskProfiles?.lucidFlex50k);

    const ledgerTarget = document.getElementById("ledger");
    if (ledgerTarget) {
      ledgerTarget.innerHTML = renderLedger(manifest);
      drawLedgerCharts(manifest);
    }
    const liveLedger = document.getElementById("live-ledger");
    if (liveLedger) liveLedger.innerHTML = renderLiveLedger(manifest);

    const dailyTarget = document.getElementById("daily");
    if (dailyTarget) dailyTarget.innerHTML = renderDailyReport(manifest.dailyReport || {});

    const researchTarget = document.getElementById("research");
    if (researchTarget) {
      await syncBacktestRequestHistory();
      researchTarget.innerHTML = renderResearchPage(manifest);
      bindResearchInteractions();
    }

    const metricsTarget = document.getElementById("metrics");
    if (metricsTarget) metricsTarget.innerHTML = `
      <h2>Strategy Lifecycle</h2>
      <p class="section-note">Lifecycle state is assembled from Paperclip research, backtest, approval, and Sierra execution records.</p>
      ${renderStrategyLifecycle(manifest.strategyLifecycle || [])}
      <h2>Separated Performance</h2>
      ${renderPerformanceSections(manifest.performance)}
      <h2>Sierra Strategy Catalog</h2>
      ${createStrategyCatalogTable(manifest.strategyCatalog || [])}
    `;
    await loadHistoricalCache();
    await loadBacktestEngineRuns();
    await loadMarkovRegime();
    await loadConfluenceReport();
    await loadHmmStrategyMonitor();

    const sourcesTarget = document.getElementById("sources");
    if (sourcesTarget) sourcesTarget.innerHTML = renderSourceAudit(manifest);
    const rulesTarget = document.getElementById("prop-firm-rules");
    if (rulesTarget) {
      rulesTarget.innerHTML = renderPropFirmRulesPage(manifest);
      bindPropFirmRuleActions();
    }
    const replayTarget = document.getElementById("replay-monitor");
    if (replayTarget) {
      replayTarget.innerHTML = renderReplayMonitorPage(manifest);
      mountCeoChatShell();
      bindReplayMonitorActions(replayTarget, manifest);
      bindReplayPerformanceCalendar(replayTarget.querySelector("[data-replay-performance-calendar]"), replaySessionForSelectedAccount(manifest.replayMonitor?.currentSession || {}));
    }
    await loadOpenTrades();

    bindPerformanceCalendars(manifest);
    bindTableFilters();
    enhanceTables();
    bindMonitorButton();
    await refreshMonitorButton();
    renderCharts(currentStrategyMetrics.length ? currentStrategyMetrics : metrics);
  } catch (error) {
    for (const id of ["dashboard-summary", "dashboard-performance-calendar", "ledger", "daily", "research", "metrics", "sources", "paper-dashboard", "live-dashboard", "live-ledger", "replay-monitor", "hmm-strategy-monitor"]) {
      const target = document.getElementById(id);
      if (target) target.textContent = `Failed to load manifest: ${String(error)}`;
    }
  }
}

load();
let resizeTimer;
const MANIFEST_AUTO_REFRESH_MS = 60_000;
const REPLAY_MANIFEST_AUTO_REFRESH_MS = 30_000;
const DASHBOARD_CALENDAR_FRESHNESS_MS = 5_000;
let lastManifestAutoRefreshAt = Date.now();
let manifestAutoRefreshInFlight = false;
let dashboardCalendarFreshnessTimer = null;
const dashboardCalendarFreshnessSignatures = { paper: "", live: "" };
let dashboardCalendarFreshnessInFlight = false;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(load, 150);
});

function canAutoRefreshManifest() {
  if (document.hidden) return false;
  if (replayActionInFlight || document.querySelector("[data-replay-clear-modal]")) return false;
  if (document.querySelector("dialog[open]")) return false;
  if (document.body?.dataset?.page === "hmm-strategy" && document.querySelector("[data-hmm-start-evaluation]:disabled")) return false;
  const active = document.activeElement;
  if (active && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName)) return false;
  return true;
}

function manifestAutoRefreshIntervalMs() {
  return document.body?.dataset?.page === "replay" ? REPLAY_MANIFEST_AUTO_REFRESH_MS : MANIFEST_AUTO_REFRESH_MS;
}

function startDashboardCalendarFreshnessWatcher() {
  if (dashboardCalendarFreshnessTimer || !document.getElementById("dashboard-performance-calendar")) return;
  dashboardCalendarFreshnessTimer = window.setInterval(async () => {
    if (document.hidden || dashboardCalendarFreshnessInFlight || manifestAutoRefreshInFlight) return;
    dashboardCalendarFreshnessInFlight = true;
    try {
      const mode = dashboardPerformanceMode() === "live" ? "live" : "paper";
      const response = await fetch(`/api/${mode}-calendar-freshness`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || payload.ok === false) return;
      if (!dashboardCalendarFreshnessSignatures[mode]) {
        dashboardCalendarFreshnessSignatures[mode] = payload.signature || "";
        return;
      }
      if (payload.signature && payload.signature !== dashboardCalendarFreshnessSignatures[mode]) {
        dashboardCalendarFreshnessSignatures[mode] = payload.signature;
        await load();
      }
    } catch {
      // The monitor status endpoint remains the source of error detail.
    } finally {
      dashboardCalendarFreshnessInFlight = false;
    }
  }, DASHBOARD_CALENDAR_FRESHNESS_MS);
}

function maybeAutoRefreshManifest() {
  if (!canAutoRefreshManifest()) return;
  if (manifestAutoRefreshInFlight) return;
  if (Date.now() - lastManifestAutoRefreshAt < manifestAutoRefreshIntervalMs()) return;
  manifestAutoRefreshInFlight = true;
  lastManifestAutoRefreshAt = Date.now();
  load()
    .catch(() => null)
    .finally(() => {
      manifestAutoRefreshInFlight = false;
    });
}

setInterval(() => {
  refreshMonitorButton();
  loadOpenTrades();
  maybeAutoRefreshManifest();
  const drawer = document.querySelector("[data-ceo-chat]");
  if (drawer?.classList.contains("open") && drawer.dataset.enabled === "true") {
    refreshCeoChat();
  }
}, 5000);

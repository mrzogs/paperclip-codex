import hashlib
import json
import sqlite3
import sys
from pathlib import Path


def stable_id(*parts):
    text = "|".join("" if part is None else str(part) for part in parts)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def value(payload, key, default=None):
    if isinstance(payload, dict):
        return payload.get(key, default)
    return default


def as_json(payload):
    return json.dumps(payload, ensure_ascii=False, sort_keys=True)


def create_schema(conn):
    conn.executescript(
        """
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS current_manifest (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          generated_at_utc TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at_utc TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );

        CREATE TABLE IF NOT EXISTS manifest_snapshots (
          id TEXT PRIMARY KEY,
          generated_at_utc TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at_utc TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );

        CREATE TABLE IF NOT EXISTS source_files (
          path TEXT PRIMARY KEY,
          basename TEXT,
          source_system TEXT,
          exists_on_disk INTEGER,
          last_modified_utc TEXT,
          stale INTEGER,
          last_seen_generated_at_utc TEXT
        );

        CREATE TABLE IF NOT EXISTS strategy_catalog (
          id TEXT PRIMARY KEY,
          name TEXT,
          function_name TEXT,
          platform TEXT,
          status TEXT,
          source_file TEXT,
          source_system TEXT,
          source_detail TEXT,
          payload_json TEXT,
          last_seen_generated_at_utc TEXT
        );

        CREATE TABLE IF NOT EXISTS performance_rows (
          id TEXT PRIMARY KEY,
          mode TEXT NOT NULL,
          source TEXT,
          account_type TEXT,
          strategy TEXT,
          trades INTEGER,
          wins INTEGER,
          losses INTEGER,
          long_trades INTEGER,
          short_trades INTEGER,
          win_rate REAL,
          net_profit_dollars REAL,
          profit_factor TEXT,
          max_drawdown_dollars REAL,
          first_trade_date_utc TEXT,
          last_trade_date_utc TEXT,
          source_system TEXT,
          source_detail TEXT,
          payload_json TEXT,
          last_seen_generated_at_utc TEXT
        );

        CREATE TABLE IF NOT EXISTS closed_trades (
          id TEXT PRIMARY KEY,
          mode TEXT NOT NULL,
          trade_date_utc TEXT,
          entry_at_utc TEXT,
          exit_at_utc TEXT,
          duration_minutes REAL,
          account TEXT,
          account_type TEXT,
          account_family TEXT,
          symbol TEXT,
          trade_source TEXT,
          strategy_name TEXT,
          side TEXT,
          quantity REAL,
          entry_price REAL,
          exit_price REAL,
          points REAL,
          realized_pnl_dollars REAL,
          profit_treatment TEXT,
          status TEXT,
          source_file TEXT,
          payload_json TEXT,
          last_seen_generated_at_utc TEXT
        );

        CREATE TABLE IF NOT EXISTS trade_fills (
          id TEXT PRIMARY KEY,
          mode TEXT NOT NULL,
          sequence INTEGER,
          event_type TEXT,
          trade_date_utc TEXT,
          account TEXT,
          account_type TEXT,
          account_family TEXT,
          symbol TEXT,
          chartbook TEXT,
          trade_source TEXT,
          strategy_name TEXT,
          side TEXT,
          quantity REAL,
          price REAL,
          previous_position REAL,
          position_after REAL,
          realized_pnl_dollars REAL,
          internal_order_id TEXT,
          status TEXT,
          source_file TEXT,
          payload_json TEXT,
          last_seen_generated_at_utc TEXT
        );

        CREATE TABLE IF NOT EXISTS research_finds (
          id TEXT PRIMARY KEY,
          strategy_name TEXT,
          found_date TEXT,
          cycle TEXT,
          status TEXT,
          market TEXT,
          style TEXT,
          evidence_level TEXT,
          decision TEXT,
          reason TEXT,
          popularity_signal TEXT,
          source_system TEXT,
          source_detail TEXT,
          payload_json TEXT,
          last_seen_generated_at_utc TEXT
        );

        CREATE TABLE IF NOT EXISTS strategy_lifecycle (
          id TEXT PRIMARY KEY,
          strategy_name TEXT,
          current_stage TEXT,
          decision TEXT,
          source_system TEXT,
          blockers_json TEXT,
          stages_json TEXT,
          payload_json TEXT,
          last_seen_generated_at_utc TEXT
        );

        CREATE TABLE IF NOT EXISTS source_audit (
          id TEXT PRIMARY KEY,
          kind TEXT,
          source_system TEXT,
          title TEXT,
          path TEXT,
          exists_on_disk INTEGER,
          stale INTEGER,
          payload_json TEXT,
          last_seen_generated_at_utc TEXT
        );

        CREATE TABLE IF NOT EXISTS research_runs (
          id TEXT PRIMARY KEY,
          slot INTEGER,
          title TEXT,
          run_date TEXT,
          source_file TEXT,
          payload_json TEXT,
          last_seen_generated_at_utc TEXT
        );

        CREATE TABLE IF NOT EXISTS daily_reports (
          id TEXT PRIMARY KEY,
          report_date TEXT,
          strategy TEXT,
          day_number TEXT,
          valid_signals TEXT,
          valid_trades TEXT,
          missed_signals TEXT,
          realized_pnl TEXT,
          recommendation TEXT,
          path TEXT,
          text_snippet TEXT,
          payload_json TEXT,
          last_seen_generated_at_utc TEXT
        );

        CREATE TABLE IF NOT EXISTS uploaded_artifacts (
          path TEXT PRIMARY KEY,
          name TEXT,
          kind TEXT,
          size_bytes INTEGER,
          last_seen_generated_at_utc TEXT
        );

        CREATE TABLE IF NOT EXISTS open_positions (
          id TEXT PRIMARY KEY,
          mode TEXT NOT NULL,
          account TEXT,
          account_type TEXT,
          account_family TEXT,
          symbol TEXT,
          trade_source TEXT,
          strategy_name TEXT,
          side TEXT,
          quantity REAL,
          average_entry_price REAL,
          latest_price REAL,
          unrealized_pnl_dollars REAL,
          opened_at_utc TEXT,
          last_updated_utc TEXT,
          source_file TEXT,
          profit_treatment TEXT,
          status TEXT,
          payload_json TEXT,
          last_seen_generated_at_utc TEXT
        );

        CREATE TABLE IF NOT EXISTS monitor_events (
          id TEXT PRIMARY KEY,
          event_time_utc TEXT,
          status TEXT,
          message TEXT,
          payload_json TEXT
        );

        CREATE TABLE IF NOT EXISTS paperclip_native_issues (
          id TEXT PRIMARY KEY,
          identifier TEXT,
          title TEXT,
          status TEXT,
          url TEXT,
          created_at_utc TEXT,
          updated_at_utc TEXT,
          completed_at_utc TEXT,
          payload_json TEXT,
          last_seen_generated_at_utc TEXT
        );

        CREATE TABLE IF NOT EXISTS paperclip_native_reports (
          id TEXT PRIMARY KEY,
          issue_id TEXT,
          identifier TEXT,
          issue_title TEXT,
          issue_status TEXT,
          document_key TEXT,
          title TEXT,
          type TEXT,
          url TEXT,
          updated_at_utc TEXT,
          text_snippet TEXT,
          payload_json TEXT,
          last_seen_generated_at_utc TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_closed_trades_mode_date ON closed_trades(mode, trade_date_utc);
        CREATE INDEX IF NOT EXISTS idx_open_positions_mode ON open_positions(mode);
        CREATE INDEX IF NOT EXISTS idx_closed_trades_account_type ON closed_trades(account_type);
        CREATE INDEX IF NOT EXISTS idx_closed_trades_strategy ON closed_trades(strategy_name);
        CREATE INDEX IF NOT EXISTS idx_trade_fills_mode_date ON trade_fills(mode, trade_date_utc);
        CREATE INDEX IF NOT EXISTS idx_performance_mode ON performance_rows(mode);
        CREATE INDEX IF NOT EXISTS idx_research_finds_status ON research_finds(status);
        CREATE INDEX IF NOT EXISTS idx_paperclip_native_issues_identifier ON paperclip_native_issues(identifier);
        CREATE INDEX IF NOT EXISTS idx_paperclip_native_reports_type ON paperclip_native_reports(type);
        CREATE INDEX IF NOT EXISTS idx_strategy_lifecycle_name ON strategy_lifecycle(strategy_name);
        CREATE INDEX IF NOT EXISTS idx_source_audit_kind ON source_audit(kind);
        """
    )
    ensure_column(conn, "source_files", "source_system", "TEXT")
    ensure_column(conn, "source_files", "exists_on_disk", "INTEGER")
    ensure_column(conn, "source_files", "last_modified_utc", "TEXT")
    ensure_column(conn, "source_files", "stale", "INTEGER")
    ensure_column(conn, "strategy_catalog", "source_system", "TEXT")
    ensure_column(conn, "strategy_catalog", "source_detail", "TEXT")
    ensure_column(conn, "performance_rows", "source_system", "TEXT")
    ensure_column(conn, "performance_rows", "source_detail", "TEXT")
    ensure_column(conn, "research_finds", "source_system", "TEXT")
    ensure_column(conn, "research_finds", "source_detail", "TEXT")
    ensure_column(conn, "closed_trades", "entry_at_utc", "TEXT")
    ensure_column(conn, "closed_trades", "exit_at_utc", "TEXT")
    ensure_column(conn, "closed_trades", "duration_minutes", "REAL")


def ensure_column(conn, table, column, declaration):
    existing = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
    if column not in existing:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {declaration}")


def clear_current_tables(conn):
    for table in [
        "source_files",
        "strategy_catalog",
        "performance_rows",
        "closed_trades",
        "trade_fills",
        "research_finds",
        "research_runs",
        "daily_reports",
        "uploaded_artifacts",
        "open_positions",
        "paperclip_native_issues",
        "paperclip_native_reports",
        "strategy_lifecycle",
        "source_audit",
    ]:
        conn.execute(f"DELETE FROM {table}")


def insert_source_files(conn, manifest, generated_at):
    records_by_path = {
        value(record, "path"): record
        for record in ((manifest.get("dataSources", {}) or {}).get("records", []) or [])
    }
    for path_text in manifest.get("sourceFiles", []) or []:
        record = records_by_path.get(path_text, {})
        conn.execute(
            """
            INSERT OR REPLACE INTO source_files
            (path, basename, source_system, exists_on_disk, last_modified_utc, stale, last_seen_generated_at_utc)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                path_text,
                Path(path_text).name,
                value(record, "sourceSystem"),
                1 if value(record, "exists") else 0,
                value(record, "lastModifiedUtc"),
                1 if value(record, "stale") else 0,
                generated_at,
            ),
        )


def insert_strategy_catalog(conn, manifest, generated_at):
    for item in manifest.get("strategyCatalog", []) or []:
        item_id = stable_id(value(item, "name"), value(item, "functionName"), value(item, "sourceFile"))
        conn.execute(
            """
            INSERT OR REPLACE INTO strategy_catalog
            (id, name, function_name, platform, status, source_file, source_system, source_detail,
             payload_json, last_seen_generated_at_utc)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                item_id,
                value(item, "name"),
                value(item, "functionName"),
                value(item, "platform"),
                value(item, "status"),
                value(item, "sourceFile"),
                value(item, "sourceSystem"),
                value(item, "sourceDetail"),
                as_json(item),
                generated_at,
            ),
        )


def insert_performance(conn, manifest, generated_at):
    performance = manifest.get("performance", {}) or {}
    for mode in ["backtesting", "paperTrading", "liveTrading"]:
        group = performance.get(mode, {}) or {}
        for row in group.get("rows", []) or []:
            item_id = stable_id(mode, value(row, "source"), value(row, "accountType"), value(row, "strategy"))
            conn.execute(
                """
                INSERT OR REPLACE INTO performance_rows
                (id, mode, source, account_type, strategy, trades, wins, losses, long_trades, short_trades,
                 win_rate, net_profit_dollars, profit_factor, max_drawdown_dollars, first_trade_date_utc,
                 last_trade_date_utc, source_system, source_detail, payload_json, last_seen_generated_at_utc)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    item_id,
                    mode,
                    value(row, "source"),
                    value(row, "accountType"),
                    value(row, "strategy"),
                    value(row, "trades"),
                    value(row, "wins"),
                    value(row, "losses"),
                    value(row, "longTrades"),
                    value(row, "shortTrades"),
                    value(row, "winRate"),
                    value(row, "netProfitDollars"),
                    None if value(row, "profitFactor") is None else str(value(row, "profitFactor")),
                    value(row, "maxDrawdownDollars"),
                    value(row, "firstTradeDateUtc"),
                    value(row, "lastTradeDateUtc"),
                    value(row, "sourceSystem"),
                    value(row, "sourceDetail"),
                    as_json(row),
                    generated_at,
                ),
            )


def iter_mode_payloads(manifest):
    modes = manifest.get("tradingModes", {}) or {}
    for mode in ["paper", "live"]:
        yield mode, modes.get(mode, {}) or {}


def insert_closed_trades(conn, manifest, generated_at):
    for mode, payload in iter_mode_payloads(manifest):
        for index, trade in enumerate(payload.get("performanceClosedTrades", []) or []):
            item_id = stable_id(
                mode,
                value(trade, "tradeDateUtc"),
                value(trade, "account"),
                value(trade, "symbol"),
                value(trade, "internalOrderId"),
                index,
                value(trade, "realizedPnlDollars"),
            )
            conn.execute(
                """
                INSERT OR REPLACE INTO closed_trades
                (id, mode, trade_date_utc, entry_at_utc, exit_at_utc, duration_minutes,
                 account, account_type, account_family, symbol, trade_source,
                 strategy_name, side, quantity, entry_price, exit_price, points, realized_pnl_dollars,
                 profit_treatment, status, source_file, payload_json, last_seen_generated_at_utc)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    item_id,
                    mode,
                    value(trade, "tradeDateUtc"),
                    value(trade, "entryAtUtc"),
                    value(trade, "exitAtUtc"),
                    value(trade, "durationMinutes"),
                    value(trade, "account"),
                    value(trade, "accountType"),
                    value(trade, "accountFamily"),
                    value(trade, "symbol"),
                    value(trade, "tradeSource"),
                    value(trade, "strategyName"),
                    value(trade, "side"),
                    value(trade, "quantity"),
                    value(trade, "entryPrice"),
                    value(trade, "exitPrice"),
                    value(trade, "points"),
                    value(trade, "realizedPnlDollars"),
                    value(trade, "profitTreatment"),
                    value(trade, "status"),
                    value(trade, "sourceFile"),
                    as_json(trade),
                    generated_at,
                ),
            )


def insert_trade_fills(conn, manifest, generated_at):
    for mode, payload in iter_mode_payloads(manifest):
        for index, fill in enumerate(payload.get("performanceTrades", []) or []):
            item_id = stable_id(
                mode,
                value(fill, "sourceFile"),
                value(fill, "sequence"),
                value(fill, "tradeDateUtc"),
                value(fill, "account"),
                value(fill, "internalOrderId"),
                index,
            )
            conn.execute(
                """
                INSERT OR REPLACE INTO trade_fills
                (id, mode, sequence, event_type, trade_date_utc, account, account_type, account_family,
                 symbol, chartbook, trade_source, strategy_name, side, quantity, price, previous_position,
                 position_after, realized_pnl_dollars, internal_order_id, status, source_file, payload_json,
                 last_seen_generated_at_utc)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    item_id,
                    mode,
                    value(fill, "sequence"),
                    value(fill, "eventType"),
                    value(fill, "tradeDateUtc"),
                    value(fill, "account"),
                    value(fill, "accountType"),
                    value(fill, "accountFamily"),
                    value(fill, "symbol"),
                    value(fill, "chartbook"),
                    value(fill, "tradeSource"),
                    value(fill, "strategyName"),
                    value(fill, "side"),
                    value(fill, "quantity"),
                    value(fill, "price"),
                    value(fill, "previousPosition"),
                    value(fill, "positionAfter"),
                    value(fill, "realizedPnlDollars"),
                    value(fill, "internalOrderId"),
                    value(fill, "status"),
                    value(fill, "sourceFile"),
                    as_json(fill),
                    generated_at,
                ),
            )


def insert_open_positions(conn, manifest, generated_at):
    for mode, payload in iter_mode_payloads(manifest):
        for position in payload.get("openPositions", []) or []:
            item_id = stable_id(
                mode,
                value(position, "account"),
                value(position, "symbol"),
                value(position, "side"),
                value(position, "openedAtUtc"),
            )
            conn.execute(
                """
                INSERT OR REPLACE INTO open_positions
                (id, mode, account, account_type, account_family, symbol, trade_source, strategy_name,
                 side, quantity, average_entry_price, latest_price, unrealized_pnl_dollars, opened_at_utc,
                 last_updated_utc, source_file, profit_treatment, status, payload_json, last_seen_generated_at_utc)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    item_id,
                    mode,
                    value(position, "account"),
                    value(position, "accountType"),
                    value(position, "accountFamily"),
                    value(position, "symbol"),
                    value(position, "tradeSource"),
                    value(position, "strategyName"),
                    value(position, "side"),
                    value(position, "quantity"),
                    value(position, "averageEntryPrice"),
                    value(position, "latestPrice"),
                    value(position, "unrealizedPnlDollars"),
                    value(position, "openedAtUtc"),
                    value(position, "lastUpdatedUtc"),
                    value(position, "sourceFile"),
                    value(position, "profitTreatment"),
                    value(position, "status"),
                    as_json(position),
                    generated_at,
                ),
            )


def insert_research(conn, manifest, generated_at):
    for item in manifest.get("researchFinds", []) or []:
        item_id = stable_id(value(item, "strategyName"), value(item, "foundDate"), value(item, "cycle"))
        conn.execute(
            """
            INSERT OR REPLACE INTO research_finds
            (id, strategy_name, found_date, cycle, status, market, style, evidence_level, decision,
             reason, popularity_signal, source_system, source_detail, payload_json, last_seen_generated_at_utc)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                item_id,
                value(item, "strategyName"),
                value(item, "foundDate"),
                value(item, "cycle"),
                value(item, "status"),
                value(item, "market"),
                value(item, "style"),
                value(item, "evidenceLevel"),
                value(item, "decision"),
                value(item, "reason"),
                value(item, "popularitySignal"),
                value(item, "sourceSystem"),
                value(item, "sourceDetail"),
                as_json(item),
                generated_at,
            ),
        )

    for item in manifest.get("researchRuns", []) or []:
        item_id = stable_id(value(item, "slot"), value(item, "title"), value(item, "sourceFile"))
        conn.execute(
            """
            INSERT OR REPLACE INTO research_runs
            (id, slot, title, run_date, source_file, payload_json, last_seen_generated_at_utc)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                item_id,
                value(item, "slot"),
                value(item, "title"),
                value(item, "runDate"),
                value(item, "sourceFile"),
                as_json(item),
                generated_at,
            ),
        )


def insert_strategy_lifecycle(conn, manifest, generated_at):
    for item in manifest.get("strategyLifecycle", []) or []:
        item_id = stable_id(value(item, "strategyName"))
        conn.execute(
            """
            INSERT OR REPLACE INTO strategy_lifecycle
            (id, strategy_name, current_stage, decision, source_system, blockers_json, stages_json,
             payload_json, last_seen_generated_at_utc)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                item_id,
                value(item, "strategyName"),
                value(item, "currentStage"),
                value(item, "decision"),
                value(item, "sourceSystem"),
                as_json(value(item, "blockers", [])),
                as_json(value(item, "stages", [])),
                as_json(item),
                generated_at,
            ),
        )


def insert_source_audit(conn, manifest, generated_at):
    audit = manifest.get("dataSources", {}) or {}
    for record in audit.get("records", []) or []:
        conn.execute(
            """
            INSERT OR REPLACE INTO source_audit
            (id, kind, source_system, title, path, exists_on_disk, stale, payload_json, last_seen_generated_at_utc)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                stable_id("source", value(record, "path")),
                "source_file",
                value(record, "sourceSystem"),
                value(record, "basename"),
                value(record, "path"),
                1 if value(record, "exists") else 0,
                1 if value(record, "stale") else 0,
                as_json(record),
                generated_at,
            ),
        )
    for report in audit.get("reportsWithoutArtifacts", []) or []:
        conn.execute(
            """
            INSERT OR REPLACE INTO source_audit
            (id, kind, source_system, title, path, exists_on_disk, stale, payload_json, last_seen_generated_at_utc)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                stable_id("paperclip_report_without_artifact", value(report, "id")),
                "paperclip_report_without_artifact",
                "paperclip",
                value(report, "title"),
                value(report, "url"),
                0,
                0,
                as_json(report),
                generated_at,
            ),
        )
    for artifact in audit.get("untrackedPaperclipArtifacts", []) or []:
        conn.execute(
            """
            INSERT OR REPLACE INTO source_audit
            (id, kind, source_system, title, path, exists_on_disk, stale, payload_json, last_seen_generated_at_utc)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                stable_id("untracked_paperclip_artifact", value(artifact, "path"), value(artifact, "reportId")),
                "untracked_paperclip_artifact",
                "paperclip",
                value(artifact, "reportTitle"),
                value(artifact, "path"),
                1 if value(artifact, "exists") else 0,
                0,
                as_json(artifact),
                generated_at,
            ),
        )


def insert_daily_report(conn, manifest, generated_at):
    report = manifest.get("dailyReport")
    if not report:
        return
    report_id = stable_id(value(report, "path"), value(report, "dayNumber"), value(report, "strategy"))
    path = value(report, "path")
    report_date = None
    if path:
        import re
        match = re.search(r"(\d{4}-\d{2}-\d{2})", path)
        report_date = match.group(1) if match else None
    conn.execute(
        """
        INSERT OR REPLACE INTO daily_reports
        (id, report_date, strategy, day_number, valid_signals, valid_trades, missed_signals,
         realized_pnl, recommendation, path, text_snippet, payload_json, last_seen_generated_at_utc)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            report_id,
            report_date,
            value(report, "strategy"),
            value(report, "dayNumber"),
            value(report, "validSignals"),
            value(report, "validTrades"),
            value(report, "missedSignals"),
            value(report, "realizedPnL"),
            value(report, "recommendation"),
            path,
            value(report, "textSnippet"),
            as_json(report),
            generated_at,
        ),
    )


def insert_paperclip_native(conn, manifest, generated_at):
    sync = manifest.get("paperclipNative", {}) or {}
    for issue in sync.get("issues", []) or []:
        conn.execute(
            """
            INSERT OR REPLACE INTO paperclip_native_issues
            (id, identifier, title, status, url, created_at_utc, updated_at_utc, completed_at_utc,
             payload_json, last_seen_generated_at_utc)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                value(issue, "id"),
                value(issue, "identifier"),
                value(issue, "title"),
                value(issue, "status"),
                value(issue, "url"),
                value(issue, "createdAt"),
                value(issue, "updatedAt"),
                value(issue, "completedAt"),
                as_json(issue),
                generated_at,
            ),
        )

    for report in sync.get("reports", []) or []:
        conn.execute(
            """
            INSERT OR REPLACE INTO paperclip_native_reports
            (id, issue_id, identifier, issue_title, issue_status, document_key, title, type,
             url, updated_at_utc, text_snippet, payload_json, last_seen_generated_at_utc)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                value(report, "id"),
                value(report, "issueId"),
                value(report, "identifier"),
                value(report, "issueTitle"),
                value(report, "issueStatus"),
                value(report, "documentKey"),
                value(report, "title"),
                value(report, "type"),
                value(report, "url"),
                value(report, "updatedAtUtc"),
                value(report, "textSnippet"),
                as_json(report),
                generated_at,
            ),
        )


def insert_uploads(conn, dashboard_dir, generated_at):
    upload_dir = dashboard_dir / "uploads"
    if not upload_dir.exists():
        return
    for file_path in upload_dir.iterdir():
        if not file_path.is_file():
            continue
        stat = file_path.stat()
        conn.execute(
            "INSERT OR REPLACE INTO uploaded_artifacts(path, name, kind, size_bytes, last_seen_generated_at_utc) VALUES (?, ?, ?, ?, ?)",
            (str(file_path), file_path.name, file_path.suffix.lower().lstrip("."), stat.st_size, generated_at),
        )


def persist(manifest_path, db_path):
    manifest_path = Path(manifest_path)
    dashboard_dir = manifest_path.parent
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    generated_at = manifest.get("generatedAtUtc") or ""

    conn = sqlite3.connect(db_path)
    try:
        create_schema(conn)
        with conn:
            conn.execute(
                "INSERT OR REPLACE INTO current_manifest(id, generated_at_utc, payload_json) VALUES (1, ?, ?)",
                (generated_at, as_json(manifest)),
            )
            clear_current_tables(conn)
            insert_source_files(conn, manifest, generated_at)
            insert_strategy_catalog(conn, manifest, generated_at)
            insert_performance(conn, manifest, generated_at)
            insert_closed_trades(conn, manifest, generated_at)
            insert_trade_fills(conn, manifest, generated_at)
            insert_open_positions(conn, manifest, generated_at)
            insert_research(conn, manifest, generated_at)
            insert_strategy_lifecycle(conn, manifest, generated_at)
            insert_daily_report(conn, manifest, generated_at)
            insert_paperclip_native(conn, manifest, generated_at)
            insert_source_audit(conn, manifest, generated_at)
            insert_uploads(conn, dashboard_dir, generated_at)
    finally:
        conn.close()


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: persist-sqlite.py <manifest-json> <sqlite-db>", file=sys.stderr)
        sys.exit(2)
    persist(sys.argv[1], sys.argv[2])

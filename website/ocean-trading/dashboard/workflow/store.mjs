import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { requireThat } from "./common.mjs";

const IMMUTABLE = ["ow_profiles", "ow_artifacts", "ow_decisions", "ow_events", "ow_decision_revocations", "ow_setup_receipts"];
const RUN_IMMUTABLE = ["ow_run_versions", "ow_run_settings", "ow_dataset_permissions", "ow_run_plans", "ow_run_progress", "ow_coverage_receipts", "ow_evidence_revisions", "ow_run_presets"];

export class WorkflowStore {
  constructor(filename) {
    requireThat(typeof filename === "string" && path.isAbsolute(filename), 503, "ABSOLUTE_WORKFLOW_DB_REQUIRED");
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    if (fs.existsSync(filename)) {
      const probe = new DatabaseSync(filename, { readOnly: true, timeout: 250 });
      try {
        const tables = probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
        requireThat(!tables.length || tables.every((table) => table.name.startsWith("ow_")), 503, "EXISTING_NON_WORKFLOW_DATABASE_REJECTED");
      } finally { probe.close(); }
    }
    this.db = new DatabaseSync(filename, { timeout: 250 });
    try {
      this.db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=250;");
      const applied = this.db.prepare("SELECT name FROM sqlite_master WHERE name='ow_schema_migrations'").get();
      if (!applied) {
        requireThat(this.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n === 0, 503, "EXISTING_NON_WORKFLOW_DATABASE_REJECTED");
        this.transaction(() => {
          this.db.exec(fs.readFileSync(new URL("./migrations/001-up.sql", import.meta.url), "utf8"));
          for (const table of IMMUTABLE) {
            for (const action of ["UPDATE", "DELETE"]) this.db.exec(`CREATE TRIGGER ${table}_no_${action.toLowerCase()} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'immutable workflow record'); END;`);
          }
        });
      }
      const version = this.db.prepare("SELECT MAX(version) AS version FROM ow_schema_migrations").get().version;
      requireThat([1,2,3].includes(version), 503, "WORKFLOW_MIGRATION_VERSION_CONFLICT");
      if (version === 1) this.transaction(() => {
        this.db.exec(fs.readFileSync(new URL("./migrations/002-up.sql", import.meta.url), "utf8"));
        for (const table of RUN_IMMUTABLE) for (const action of ["UPDATE","DELETE"]) this.db.exec(`CREATE TRIGGER ${table}_no_${action.toLowerCase()} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'immutable run record'); END;`);
      });
      if (version < 3) this.transaction(() => {
        this.db.exec(fs.readFileSync(new URL("./migrations/003-up.sql", import.meta.url), "utf8"));
        this.db.exec("DELETE FROM ow_sessions");
        for (const action of ["UPDATE", "DELETE"]) this.db.exec(`CREATE TRIGGER ow_auth_audit_no_${action.toLowerCase()} BEFORE ${action} ON ow_auth_audit BEGIN SELECT RAISE(ABORT,'immutable auth audit'); END;`);
      });
    } catch (error) { this.db.close(); throw error; }
  }
  transaction(work) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  registerIdentity(identity) {
    const current = this.db.prepare("SELECT metadata_json FROM ow_identities WHERE id=?").get(identity.identity_id);
    if (current) requireThat(current.metadata_json === JSON.stringify(identity), 503, "IDENTITY_RECONCILIATION_REQUIRED");
    else this.db.prepare("INSERT INTO ow_identities VALUES(?,?,?)").run(identity.identity_id, identity.role, JSON.stringify(identity));
  }
  identityCurrent(identity) {
    return this.db.prepare("SELECT metadata_json FROM ow_identities WHERE id=?").get(identity.identity_id)?.metadata_json === JSON.stringify(identity);
  }
  saveSession(hash, csrf, subject, expiry) {
    this.db.prepare("DELETE FROM ow_sessions WHERE expires_ms<=?").run(Date.now());
    requireThat(this.db.prepare("SELECT COUNT(*) AS n FROM ow_sessions").get().n < 100, 429, "SESSION_CAPACITY");
    this.db.prepare("INSERT INTO ow_sessions VALUES(?,?,?,?)").run(hash, csrf, subject, expiry);
  }
  getSession(hash) { return this.db.prepare("SELECT * FROM ow_sessions WHERE session_hash=?").get(hash); }
  browserCurrent(hash) { return this.db.prepare("SELECT credential_hash FROM ow_auth_state WHERE id='browser'").get()?.credential_hash === hash; }
  bindBrowser(hash, managed = false) {
    const current = this.db.prepare("SELECT credential_hash FROM ow_auth_state WHERE id='browser'").get();
    if (!current && !managed) this.db.prepare("INSERT INTO ow_auth_state VALUES('browser',?)").run(hash);
    else requireThat(current?.credential_hash === hash, 503, "BROWSER_RECOVERY_REQUIRED");
  }
  close() { this.db.close(); }
  revertEmptyMigration() {
    const count = this.db.prepare("SELECT (SELECT COUNT(*) FROM ow_cases)+(SELECT COUNT(*) FROM ow_runs)+(SELECT COUNT(*) FROM ow_setup_receipts) AS n").get().n;
    requireThat(count === 0, 409, "POPULATED_WORKFLOW_REQUIRES_BACKUP_AND_OPERATOR_ROLLBACK");
    this.transaction(() => {
      this.db.exec("DROP TABLE ow_auth_audit; DROP TABLE ow_auth_state; DELETE FROM ow_schema_migrations WHERE version=3;");
      this.db.exec(fs.readFileSync(new URL("./migrations/002-down.sql", import.meta.url), "utf8"));
      this.db.exec(fs.readFileSync(new URL("./migrations/001-down.sql", import.meta.url), "utf8"));
    });
  }
}

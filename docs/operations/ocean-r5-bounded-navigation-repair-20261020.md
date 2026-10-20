# Ocean r5 bounded navigation repair

## Measured blocker

Diagnostic build `ocean-bc88dcb-20261020-vwap-r5-diagnostic` measured a 75,796 ms
synchronous strategy-view render (request 205, PID 60348, completed at
2026-10-20 17:35:39.548 UTC). Its 34 run-learning projections consumed 9,735 ms.
The exact remaining leaf was not established by that first measurement.

The finer `ocean-1d4c49a-20261020-vwap-r5-diagnostic2` build measured a 3,977 ms
event-loop delay at 17:46:07.147 UTC: strategy navigation consumed 1,971 ms
(1,625 ms in 34 run-learning calls), immediately followed by dashboard navigation
consuming 1,897 ms (1,889 ms in ten full case reads). The primary response took
4,146 ms. Manifest work in this interval was not the dominant measured path.
Do not attribute the entire earlier 75-second episode to a specific SQL leaf.

## Targeted change

Human-only list/strategy/dashboard navigation now reads bounded recorded
run/case metadata. It does not load current run-manager authority, research
artifacts, receipt counts, full event history or per-run learning qualification.
Rows explicitly say that they are recorded summaries and direct the user to
the detail page for current checks. No eligibility, physical execution, approval
or protected action is inferred from a navigation row.

Full run/case detail and protected action paths retain their existing readers
and validations. Paper trade display and live Paperclip approval/current-work
projection remain separate. UI module version changes to prevent stale labels.

The real list-API regression uses an in-memory SQLite store and delayed evidence
readers: before the change it called them 150 times and took 4,727 ms; after the
change it calls none and took about 4 ms. It also proves pagination, read-only
behavior, human-only access and continued full-reader use on detail routes.

## Deployment approval boundary

The running workflow database `D:\OceanTradingData\website\workflow\workflow.sqlite`
was independently read as schema 13. Current `develop` now also includes the
separate booking provider merge `bd78999ad1a7212475dad0ce0f502dca4177aa68`.
`WorkflowStore` unconditionally runs migration 014 when the database is below
14, even when the booking provider is disabled. That migration adds booking and
booking-event tables, an index, immutable triggers and schema version 14.

The website repair is not permission to migrate this operational database.
Do not deploy the booking provider without separate approval for that exact
schema-14 migration. The website-only repair can be packaged on a `release/*`
branch from current merged `develop`, excluding merge `bd78999` from that release
only. Keep the integration feature on `develop`; do not merge the release-scope
revert back. Compare the exact release tree against deployed commit `1d4c49a`:
only this navigation repair may differ. This preserves the existing schema-13
runtime contract without inferring migration approval from the website request.
A source merge or disposable local test does not grant runtime migration,
booking, Stage, Replay, Paper, Live or order authority.
Keep all physical bindings, monitor PID/state and Quant Terminal state intact.

Before final promotion, the running build is diagnostic2, not the final r5
navigation repair. Its active manifest SHA256 is
`12243fc41b5347c4360bfd324d8b61101f00f1c5b4210e176c6ffa70b2409a78`.
No sustained final-fix acceptance can be claimed before approved deployment and
a fresh undebugged signed-in/health/database-monitor observation window.

Local checks: 81 targeted tests passed (19,517 ms), including the actual list
API and browser onboarding regression. Quant Terminal and deployment resolver
checks are required again on the exact committed release tree before promotion.

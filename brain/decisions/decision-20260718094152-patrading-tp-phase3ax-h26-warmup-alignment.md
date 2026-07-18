---
id: decision-20260718094152-patrading-tp-phase3ax-h26-warmup-alignment
decision_id: decision-20260718094152-patrading-tp-phase3ax-h26-warmup-alignment
title: PATrading TP Phase 3AX H26 bounded Replay exposes warmup alignment blocker
decision: Phase 3AX H26 bounded original-Replay validation is a partial pass, not full H26 acceptance. The bounded Replay matched all corrected harness signals through 2026-01-08 09:00:00 on side and win/loss shape, with matched Replay +78.75 points versus harness +78.00 points, but Replay also produced one extra early Trend Pullback long at 2026-01-02 00:55:00 for +69.25 points. Older H26 triggered-context diagnostics classify that timestamp as warmup_or_invalid_input, so the next action is harness/Replayer warmup alignment only. Do not tune TP filters, stops, targets, or strategy logic to remove or keep this trade until the comparison surface is proven.
type: decision
domain: patrading
strategy_or_project: patrading-trend-pullback
source_system: codex-local
source_path: D:\Paperclip-codex\workspaces\PATrading\reports\replay\tp-phase3ax-h26-bounded-replay-20260718.md
created_at: '2026-07-18T09:41:52+00:00'
updated_at: '2026-07-18T09:41:52+00:00'
status: needs-followup
confidence: high
evidence_ids:
- reports/replay/tp-phase3ax-h26-bounded-replay-20260718.md
- reports/replay/tp-phase3ax-h26-bounded-telemetry-comparison-20260718.json
- reports/replay/tp-phase3ax-h26-final-chartdiag-20260718.json
- reports/replay/tp-phase3ax-h26-final-cleanup-dryrun-20260718.json
decision_ids:
- decision-20260718094152-patrading-tp-phase3ax-h26-warmup-alignment
agent: codex
model: openai-codex
prompt_version: codex-desktop-20260718
source_records:
- branch=codex/trend-pullback-strategy
- commit_before_record=f674e13
- replay_instance=D:\Trading\SierraChart-Replay\SierraChart_64.exe
- account=Sim2
- symbol=MNQH26_FUT_CME
- m26_not_used=true
- paper_live_replay_two_replay_three_not_used=true
retrieved_notes: []
correction_ids: []
supersedes: null
superseded_by: null
trace_id: local-trace-20260718094152-phase3ax
agent_run_id: local-agent-run-20260718094152-phase3ax
---

# PATrading TP Phase 3AX H26 bounded Replay exposes warmup alignment blocker

## Decision

Phase 3AX H26 bounded original-Replay validation is a partial pass, not full H26 acceptance. The bounded Replay matched all corrected harness signals through `2026-01-08 09:00:00` on side and win/loss shape, with matched Replay `+78.75` points versus harness `+78.00` points. Replay also produced one extra early Trend Pullback long at `2026-01-02 00:55:00` for `+69.25` points.

Older H26 triggered-context diagnostics classify `2026-01-02 00:55:00` as `warmup_or_invalid_input`, so this is a harness/Replayer warmup-alignment blocker before full H26 acceptance. Do not tune TP filters, stops, targets, or strategy logic to remove or keep this trade until the comparison surface is proven.

## Evidence

- Original Replay only: `D:\Trading\SierraChart-Replay\SierraChart_64.exe`.
- Account: `Sim2`.
- Symbol: `MNQH26_FUT_CME`.
- H2/L2 disabled; TP enabled; PATrading SQLite/debug disabled; telemetry logger active.
- M26, Paper, Live, Replay Two, and Replay Three were not used.
- Corrected harness slice through `2026-01-08 09:00:00`: `8` trades, `3` longs, `5` shorts, `4` wins, `4` losses, `50.00%` WR, `+78.00` points.
- Matched Replay signals: `8` trades, `3` longs, `5` shorts, `4` wins, `4` losses, `50.00%` WR, `+78.75` points.
- All Replay trades: `9` trades, `4` longs, `5` shorts, `5` wins, `4` losses, `55.56%` WR, `+148.00` points.
- Extra Replay trade: `2026-01-02 00:55:00`, long, `+69.25` points, tag `PATrading Trend Pullback LONG 2026-01-02 00:55:00`.
- Final state: safe-off settings saved, full H26 date range restored and saved to original-Replay chartbook, Replay stopped, `Sim2`, flat, no working orders.

## Lesson

Align harness `Start`/`TradeStart` warmup to the Replay chart-history surface before full H26 acceptance. Direct reads of the controller status file can be stale during active Replay, so use sparse explicit single-lane `status` commands for chart-time proof.

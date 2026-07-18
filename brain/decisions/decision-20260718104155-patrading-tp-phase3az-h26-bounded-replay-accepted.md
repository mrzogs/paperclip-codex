---
id: decision-20260718104155-patrading-tp-phase3az-h26-bounded-replay-accepted
decision_id: decision-20260718104155-patrading-tp-phase3az-h26-bounded-replay-accepted
title: PATrading TP Phase 3AZ accepts bounded H26 Replay after warmup alignment
decision: Phase 3AZ accepts the bounded H26 original-Replay rerun against the corrected Phase 3AY warmup baseline. Original Replay only was used with chart #1 MNQH26_FUT_CME, selected account Sim2, H2/L2 disabled, TP enabled, PATrading SQLite/debug disabled, and telemetry logger active. Corrected bounded harness expected 9 trades, 4 longs, 5 shorts, 5 wins, 4 losses, 55.56% win rate, +147.25 points, and 57.25 drawdown. Replay telemetry produced the same 9 signals with no missing or extra trades, no side mismatches, no win/loss mismatches, 55.56% win rate, +148.00 points, and 57.00 drawdown. The +0.75 point residual is Sierra fill behaviour. Full H26 Replay acceptance is still pending; M26, Paper, Live, Replay Two, Replay Three, and H2 remained untouched.
type: decision
domain: patrading
strategy_or_project: patrading-trend-pullback
source_system: codex-local
source_path: D:\Paperclip-codex\workspaces\PATrading\reports\replay\tp-phase3az-h26-bounded-replay-20260718.md
created_at: '2026-07-18T10:41:55+00:00'
updated_at: '2026-07-18T10:41:55+00:00'
status: accepted
confidence: high
evidence_ids:
- reports/replay/tp-phase3az-h26-bounded-replay-20260718.md
- reports/replay/tp-phase3az-h26-bounded-telemetry-comparison-20260718.json
- reports/harness/tp-phase3ay-h26-warmup-alignment-20260718/h26-replay-warmup-surface-outcomes.csv
- reports/replay/tp-phase3az-h26-final-chartdiag-20260718.json
- reports/replay/tp-phase3az-h26-final-cleanup-dryrun-20260718.json
decision_ids:
- decision-20260718104155-patrading-tp-phase3az-h26-bounded-replay-accepted
agent: codex
model: openai-codex
prompt_version: codex-desktop-20260718
source_records:
- branch=codex/trend-pullback-strategy
- commit_before_record=f391fbd
- replay_instance=D:\Trading\SierraChart-Replay\SierraChart_64.exe
- account=Sim2
- symbol=MNQH26_FUT_CME
- start=2026-01-01 00:00:00
- stopped_after_signal=2026-01-08 13:10:22
- corrected_harness_trades=9
- replay_trades=9
- point_residual=0.75
- m26_not_used=true
- paper_live_replay_two_replay_three_not_used=true
retrieved_notes: []
correction_ids: []
supersedes: decision-20260718094152-patrading-tp-phase3ax-h26-warmup-alignment
superseded_by: null
trace_id: local-trace-20260718104155-phase3az
agent_run_id: local-agent-run-20260718104155-phase3az
---

# PATrading TP Phase 3AZ accepts bounded H26 Replay after warmup alignment

## Decision

Phase 3AZ accepts the bounded H26 original-Replay rerun against the corrected Phase 3AY warmup baseline. Corrected bounded harness expected `9` trades, `4` longs, `5` shorts, `5` wins, `4` losses, `55.56%` win rate, `+147.25` points, and `57.25` drawdown.

Replay telemetry produced the same `9` signals with no missing or extra trades, no side mismatches, no win/loss mismatches, `55.56%` win rate, `+148.00` points, and `57.00` drawdown. The `+0.75` point residual is Sierra fill behaviour.

## Boundaries

- Original Replay only: `D:\Trading\SierraChart-Replay\SierraChart_64.exe`.
- Chart #1: `MNQH26_FUT_CME`.
- Account: `Sim2`.
- H2/L2 disabled.
- TP enabled only for the bounded run, then safe-off saved.
- PATrading SQLite/debug disabled; telemetry logger active.
- M26, Paper, Live, Replay Two, and Replay Three were not used.
- Full H26 Replay acceptance is still pending.

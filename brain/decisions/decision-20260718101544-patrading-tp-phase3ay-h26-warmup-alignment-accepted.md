---
id: decision-20260718101544-patrading-tp-phase3ay-h26-warmup-alignment-accepted
decision_id: decision-20260718101544-patrading-tp-phase3ay-h26-warmup-alignment-accepted
title: PATrading TP Phase 3AY accepts H26 harness warmup alignment
decision: Phase 3AY confirms the Phase 3AX extra H26 Replay trade was caused by the harness warmup surface, not TP strategy tuning. Running H26 harness with Replay-equivalent history Start 2025-12-30 23:00:00 and TradeStart 2026-01-01 00:00:00 adds only the 2026-01-02 00:55:00 long in the bounded Jan 1-Jan 9 slice and aligns all-trade points with Replay within the known 0.75 fill residual. The full H26 aligned harness baseline is now 54 trades, 31 longs, 23 shorts, 29 wins, 25 losses, 53.70% win rate, +1220.50 points, and 112.75 drawdown. This supersedes the previous 53-trade H26 harness ledger for Replay comparison only; no TP filters, stops, targets, strategy source, H2, M26, Paper, or Live were touched.
type: decision
domain: patrading
strategy_or_project: patrading-trend-pullback
source_system: codex-local
source_path: D:\Paperclip-codex\workspaces\PATrading\reports\harness\tp-phase3ay-h26-warmup-alignment-20260718\tp-phase3ay-h26-warmup-alignment.md
created_at: '2026-07-18T10:15:44+00:00'
updated_at: '2026-07-18T10:15:44+00:00'
status: accepted
confidence: high
evidence_ids:
- reports/harness/tp-phase3ay-h26-warmup-alignment-20260718/tp-phase3ay-h26-warmup-alignment.md
- reports/harness/tp-phase3ay-h26-warmup-alignment-20260718/tp-phase3ay-h26-warmup-alignment-summary.json
- reports/harness/tp-phase3ay-h26-warmup-alignment-20260718/h26-original-surface-outcomes.csv
- reports/harness/tp-phase3ay-h26-warmup-alignment-20260718/h26-replay-warmup-surface-outcomes.csv
- reports/harness/tp-phase3ay-h26-warmup-alignment-20260718/h26-full-replay-warmup-surface-outcomes.csv
decision_ids:
- decision-20260718101544-patrading-tp-phase3ay-h26-warmup-alignment-accepted
agent: codex
model: openai-codex
prompt_version: codex-desktop-20260718
source_records:
- branch=codex/trend-pullback-strategy
- commit_before_record=8d280c8
- h26_scid=D:\Trading\SierraChart-Replay\Data\MNQH26_FUT_CME.scid
- replay_equivalent_start=2025-12-30 23:00:00
- trade_start=2026-01-01 00:00:00
- end=2026-03-21 00:00:00
- fill_mode=sierra
- target_rr=2.25
- h2_l2_disabled=true
- m26_not_used=true
- paper_live_replay_not_used=true
retrieved_notes: []
correction_ids: []
supersedes: decision-20260718094152-patrading-tp-phase3ax-h26-warmup-alignment
superseded_by: null
trace_id: local-trace-20260718101544-phase3ay
agent_run_id: local-agent-run-20260718101544-phase3ay
---

# PATrading TP Phase 3AY accepts H26 harness warmup alignment

## Decision

Phase 3AY confirms the Phase 3AX extra H26 Replay trade was caused by the harness warmup surface, not TP strategy tuning. Running H26 harness with Replay-equivalent history `Start=2025-12-30 23:00:00` and `TradeStart=2026-01-01 00:00:00` adds only the `2026-01-02 00:55:00` long in the bounded Jan 1-Jan 9 slice and aligns all-trade points with Replay within the known `0.75` fill residual.

The full H26 aligned harness baseline is now `54` trades, `31` longs, `23` shorts, `29` wins, `25` losses, `53.70%` win rate, `+1220.50` points, and `112.75` drawdown. This supersedes the previous `53`-trade H26 harness ledger for Replay comparison only.

## Boundaries

- No TP filters, stops, targets, or strategy source changed.
- H2/L2 stayed disabled.
- M26 was not used.
- Replay, Paper, Live, Replay Two, and Replay Three were not used in Phase 3AY.
- Next validation is a bounded H26 original-Replay rerun against the corrected `54`-trade baseline, not strategy tuning.

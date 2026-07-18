---
id: decision-20260718105945-patrading-tp-phase3ba-controller-target-collision
decision_id: decision-20260718105945-patrading-tp-phase3ba-controller-target-collision
title: PATrading TP Phase 3BA full H26 Replay blocked by controller target ambiguity
decision: Phase 3BA full H26 Replay validation did not start. Preflight initially proved original Replay chart #1 as MNQH26_FUT_CME with controller v0.1.33 and clean studies, but the account diagnostic command with commandId tp-phase3ba-h26-full-pre-account-20260718 returned controllerVersion v0.1.29, selected account Sim1, expected Sim1, and currentChartDateTime 2026-07-17 21:55:00. That response is inconsistent with the target original Replay H26 Sim2 surface and suggests another Sierra/controller instance is watching or responding on the same command/status path. Stop before any mutating Replay start until the command surface is isolated to D:\Trading\SierraChart-Replay\SierraChart_64.exe only.
type: decision
domain: patrading
strategy_or_project: patrading-trend-pullback
source_system: codex-local
source_path: D:\Paperclip-codex\workspaces\PATrading\reports\replay\tp-phase3ba-h26-full-replay-blocked-20260718.md
created_at: '2026-07-18T10:59:45+00:00'
updated_at: '2026-07-18T10:59:45+00:00'
status: blocked
confidence: high
evidence_ids:
- reports/replay/tp-phase3ba-h26-full-pre-chartdiag-20260718.json
- reports/replay/tp-phase3ba-h26-full-pre-studies-20260718.json
- reports/replay/tp-phase3ba-h26-full-pre-account-20260718.json
- reports/replay/tp-phase3ba-h26-full-replay-blocked-20260718.md
decision_ids:
- decision-20260718105945-patrading-tp-phase3ba-controller-target-collision
agent: codex
model: openai-codex
prompt_version: codex-desktop-20260718
source_records:
- branch=codex/trend-pullback-strategy
- commit_before_record=9e2d935
- intended_replay_instance=D:\Trading\SierraChart-Replay\SierraChart_64.exe
- intended_account=Sim2
- intended_symbol=MNQH26_FUT_CME
- unexpected_controller_version=v0.1.29
- unexpected_account=Sim1
- unexpected_chart_time=2026-07-17 21:55:00
- replay_start_not_sent=true
- m26_not_used=true
- paper_live_replay_two_replay_three_not_used_by_codex=true
retrieved_notes: []
correction_ids: []
supersedes: null
superseded_by: null
trace_id: local-trace-20260718105945-phase3ba
agent_run_id: local-agent-run-20260718105945-phase3ba
---

# PATrading TP Phase 3BA full H26 Replay blocked by controller target ambiguity

## Decision

Phase 3BA full H26 Replay validation did not start. Preflight initially proved original Replay chart #1 as `MNQH26_FUT_CME` with controller `v0.1.33` and clean studies, but the account diagnostic command with command ID `tp-phase3ba-h26-full-pre-account-20260718` returned controller `v0.1.29`, selected account `Sim1`, expected `Sim1`, and chart time `2026-07-17 21:55:00`.

That response is inconsistent with the target original Replay H26 `Sim2` surface and suggests another Sierra/controller instance is watching or responding on the same command/status path. Stop before any mutating Replay start until the command surface is isolated to `D:\Trading\SierraChart-Replay\SierraChart_64.exe` only.

## Boundaries

- Full H26 Replay was not started.
- No TP strategy source or settings were changed for a run.
- No M26, Paper, Live, Replay Two, or Replay Three validation was performed by Codex.
- Next step is controller/process isolation, not TP logic work.

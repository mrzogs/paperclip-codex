# Targeted Replay behavior evidence

The CI/CD VWAP candidate lifecycle pins
`contracts/cicd-vwap-targeted-replay-behavior-v1.json` to SHA-256
`8a6cdfacca4c004f88bdf6c1ffde9182d90cfab37caf8754c04bdaa1dd949def`.
The original contract bytes are preserved without Git line-ending conversion.

Paper episodes support as-built diagnostics only. Candidate development uses a
frozen pre-event selector on qualified DISCOVERY data. A frozen candidate then
uses every predeclared eligible independent window. Existing dataset,
exposure, approval, Replay-controller, Paper and Live gates continue to apply.
Passing metadata validation never authorizes a physical run.

## Plan and trusted receipts

`validation-plan` accepts `targeted_replay_plan` for this exact strategy.
`BLOCKED_*` plans remain descriptive and cannot be sealed for execution.
Ready metadata includes cases and independent windows with exact dataset,
source, executable, configuration, interval and expected behavior identities.
Each selector group's complete `match_ids` must correspond to all its case
entries; groups can contain more than one match. Independent window groups
likewise enumerate their complete `eligible_window_ids`. Every case/window
must appear exactly once in the existing validation matrix. Unsupported role
combinations fail closed instead of silently dropping independent windows.

`independent_acceptance` freezes `source_reference`, `source_sha256`,
`max_drawdown`, and `max_largest_winner_share`. The entire targeted plan is
immutable after the first evidence exposure, including before a result passes.

Plan flags and hash-shaped strings leave `authority_status: UNPROVEN`.
The backend separately resolves three existing immutable EVIDENCE artifacts
through `artifactFor`, checks that their authenticated producer is the configured
human operator, and verifies their bytes, candidate/case identity, expiry,
`frozen_case_plan_hash`, and `acceptance_policy_hash`:

- `physical_replay_host_attestation_artifact_id` and its SHA-256 identify a
  `cicd-vwap-physical-replay-host-attestation/v1` receipt for OCEA-55.
- `source_universe_attestation_artifact_id` and its SHA-256 identify a
  `cicd-vwap-source-universe-attestation/v1` receipt for OCEA-89. It independently
  attests qualified causal source, pre-event-only selection, the full match
  universe, and the exact case and independent-window IDs.
- `run_authority_artifact_id` and `run_authority_sha256` identify a
  `cicd-vwap-targeted-replay-run-authority/v1` receipt with scope
  `BOUNDED_REPLAY_TESTS_ONLY`. Its decision ID and approval-binding SHA-256 must
  match a currently valid stored DEVELOPMENT approval for this candidate.

These receipts must already exist through authorized governance. This module
does not manufacture them, change OCEA-89/OCEA-55, or start a Replay. Synthetic
receipts in unit tests prove validation behavior only.

## Result evidence

The `targeted_behavior` result retains all fields listed in the contract's
`required_per_case`. Its `evidence_sha256` references a retained file in the
segment's `source_files`. File bytes must match the hash and parse as a
`cicd-vwap-targeted-replay-trace/v1` document bound to that case, run and config.

Each trace contains `orders`, `fills`, `stops`, `targets`, and `exits`. Events
identify the trade, event, time and action. Each nonzero trade requires events
in all five categories. The explicit `zero_trade_case` marker is true only
when the trade list and sealed ledger count are zero. A trade includes
`trade_id`, `run_id`, `exit_utc`, `exit_sierra_datetime`, `gross_pnl`, `fees`,
`slippage`, and `net_pnl`. Its ID, source exit time, gross P&L, fees and net P&L
must reconcile with the sealed Sierra telemetry SQLite rows. Realized ledger
prices already incorporate execution slippage; the separate slippage amount
is disclosed without subtracting it twice from ledger net P&L.

Expected entry/stop/target/exit behavior and the explicit behavior assessment
are retained with the source trace. Source review and the governed evaluation
must assess their meaning; hashes alone do not prove a market hypothesis.
Costs, skipped winners, avoided losers, counterexamples and run receipts stay
part of every case record.

Independent drawdown and largest-winner share are recomputed from the complete
ordered trade list against the frozen limits. Net profit must remain positive
after removing the largest winner. A smaller loss cannot pass. The final
assessment also combines all independent trade evidence, checking duplicate
identities and aggregate risk.

## Compatibility and release

Historical CI/CD VWAP plans without `targeted_replay` are explicitly quarantined
in read views and result/completion handling. Their artifacts and tasks remain
unchanged. A fresh governed attempt is required before new evidence can support
a benefit conclusion. Other strategies retain the existing payload shape.

The Brain v2 request/response wire contract is unchanged. Targeted assessments
are computed before obtaining a Brain token or making any Brain request.
Independent failures become durable local `BENEFIT_NOT_ESTABLISHED` results,
without creating a contradictory positive Brain record. A required, owned
`CANDIDATE_BRAIN_WRITEBACK` task keeps the missing strategy-memory integration
visible. These completed local assessments cannot enter a retry loop.
Failed assessments use `NO_BENEFIT`; locally passing assessments awaiting
receiver support use `EVIDENCE`. Neither artifact satisfies the evaluation
artifact required to advance toward Paper. The Shadow transition additionally
requires the evaluator's completed, matching `BENEFIT_SUPPORTED` job, successful
independent assessment and stored Brain readback. The case's primary next action
continues to show the required memory integration work.

The deployed Brain receiver also requires a separate compatibility slice for
the new targeted plan/trace evidence. Locally passing targeted assessments
therefore retain the same explicit writeback task instead of sending an
unsupported request. Source identities remain frozen for that integration;
the current PR does not complete autonomous learning. It does not borrow a
development PROJECT credential, call generic reasoning with a TRADING token,
or turn on normal ingestion to work around the missing scoped learning path.
The local completion downgrade remains a further check on any future Brain
response, preserving the actual response rather than silently rewriting it.

The deployment resolver requires both the validator and original contract.
Run the targeted behavior, candidate evaluator and continuation tests plus the
Ocean deployment and Quant Terminal checks before an immutable website release.

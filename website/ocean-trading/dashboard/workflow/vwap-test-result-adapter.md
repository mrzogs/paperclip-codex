# VWAP TEST receipt adapter

`adaptVwapTestResult(input, dependencies)` admits retained originals into
`validateTargetedReplayResultBinding` and `assessIndependentTrades`. Its output
is `{targeted_behavior, adapter_binding}`. Existing dispatch validation must still
validate the complete result artifact before the existing evaluator captures its
job snapshot. This adapter does not enqueue a parallel evaluator or grant any
deployment, Paper, Live, Brain ingestion, or physical execution authority.

The authoritative targeted verdict remains `PASS` / `FAIL`; the existing
`OperationalCandidateEvaluator.effectiveConclusion` retains the stored benefit
conclusion. The adapter's JSON binding is an inspectable intermediate product,
not an authenticated physical receipt or a replacement for the evaluator's
immutable artifact/job/lease pipeline.

## Application-owned dependencies

`evidenceRoot` is an allowlisted retained artifact directory. Artifacts must
remain inside it; symlink/junction components, alternate streams, devices and
directories are rejected. Reads use a regular-file descriptor, allocate only the
validated size and verify size, timestamp, inode and path identity afterward.
`maxArtifactBytes` defaults to 16 MiB per file (maximum 32 MiB), and the aggregate
`maxTotalArtifactBytes` defaults to 64 MiB (maximum 128 MiB). Length and SHA256 are
checked. Admitted trace bytes are retained once and reused through the existing
result validator; no second path read can escape the budget or swap a trace.
Legacy result-validator callers use the same bounded reader by default at
32 MiB per trace and 64 MiB total. Its optional `readTraceArtifact` dependency is
an application-owned retained-byte reader, never a client JSON field.
`now` permits deterministic expiry testing. `evaluatorPrincipalId` must come from
the application's authenticated actor context.

`verifyProtocol` and `verifyPhysicalReceipt` are mandatory synchronous trusted
service adapters. Client JSON cannot supply them. Both receive:

```js
{ artifact, bytes, payload, expected, expected_dependencies }
```

Both must return:

```js
{
  authenticated: true,
  principal_id: 'authenticated-owner',
  payload_sha256: 'sha256:<the exact receipt FILE bytes>',
  trust_policy_sha256: 'sha256:<owner-pinned policy>',
  claims: normalizedClaims,
  verified_dependencies: { // required for physical receipts
    host_attestation_sha256: 'sha256:<original prior receipt FILE>',
    run_authority_sha256: 'sha256:<original prior receipt FILE>'
  }
}
```

The production bridge must authenticate the root
`cicd-vwap-signed-proof/v1` envelope using the external owner-pinned
`TrustedReceiptVerifier` policy. It must verify issuer/key, purpose, freshness,
subject bytes, exact bindings, and prior signed host/authority/start dependencies
before normalizing. A generic signature check or copying `payload.result` into
claims is insufficient. Keep signed payload/envelope fields separate from the
normalized protocol, receipt and originals schemas below. There is intentionally
no fallback authenticator, key selection, service token or signing code here.

`TEST_RUN_START` uses `improvement.test_start`, and `TEST_RUN_TERMINAL` uses
`improvement.test_terminal`. Prior host and run authority proofs use
`improvement.host_attestation` and `improvement.test_authority`. The bridge must
verify native command identity/readbacks and terminal flat/order behavior
readbacks under that external contract. `expected_dependencies` contains the
exact frozen plan's host/authority receipt hashes. Missing or different verified
dependencies fail admission.

## Input and normalization

Input fields are `project_id`, `candidate_hash`, `planBinding`, `test`, `result`,
`protocol_ref`, `case_evidence_ref`, and `physical_runs`. `planBinding`, `test`,
and `result` are the existing Ocean targeted-plan/test/result contract. Each
artifact ref has `{id,path,sha256,byte_length,purpose}`. Purposes are
`FROZEN_PROTOCOL`, `TARGETED_CASE_EVIDENCE`, `PHYSICAL_START`,
`PHYSICAL_TERMINAL`, and `TRADE_ORIGINALS`.

Protocol normalized claims have schema `vwap-independent-protocol/v1`:

- `project_id`, `candidate_hash`, `plan_hash` and `authority_receipt_sha256` bind
  the exact existing plan and its verified authority receipt.
- `test_hashes` maps each scheduled test kind to the complete frozen test hash.
  `windows` enumerates every plan case/window in plan order as
  `{window_id,source_role,source_sha256}`.
- `frozen_at_utc`, `expires_at_utc`, `max_receipt_age_ms` freeze chronology.
- `currency`, `point_value`, `cost_model_sha256`,
  `slippage_accounting:'IN_FILL_PRICES'`, and `exposure_policy` freeze costs.
  Exposure policy is `EQUAL_TOTAL_ENTRY_QUANTITY` or `REPORT_DIFFERENCE`.
- `candidate_author_id`, `independent_reviewer_id`, and
  `independent_evaluator_id` require reviewer/evaluator independence from the
  candidate author. The evaluator must match the trusted actor context.

Each physical run is `{window_id,side,run_id,start_receipt_ref,
terminal_receipt_ref,originals_ref}`. Authenticated normalized start and terminal
claims both contain the exact expected project/candidate/plan/run/window/side,
`source_role`, `dataset_role`, `execution_namespace:'TEST'`, source/config/
strategy-source/strategy-binary/protocol SHA256 values and warmup/start/end/
timezone. The independently assigned dataset role is preserved; it is never
renamed TEST. Both require `physical_test:true`, `simulation:true`, and matching
nonempty `host_id` / `observer_id`. Start requires `status:'STARTED'` and
`started_at_utc`; terminal requires `status:'COMPLETED'`, `completed_at_utc`,
`start_receipt_sha256`, `originals_sha256`, and `trace_sha256`. These last hashes
refer to retained file bytes. Protocol freeze must precede the actual start.

Trade originals have schema `vwap-trade-originals/v1` and bind project,
candidate, plan, run, window, source role/hash, currency and cost model. Each
trade has `trade_id`, `opportunity_id`, `side` (LONG/SHORT), `entry_utc`, `exit_utc`,
`exit_sierra_datetime`, optional `native_exit_sequence`, total entry `quantity`, `gross_pnl`, `fees`, `slippage`,
`net_pnl`, and `fill_ids`. Every fill has `fill_id`, `trade_id`, native `order_id`
and `leg_id`, `at_utc`, ENTRY/EXIT `action`, `quantity`, `price`, `fees`,
`slippage`, `currency`, and any available original `native_sequence`. The authenticated retained trace must contain the
same fill observations and order links. Partial exits and scale-ins use actual
ordered fill quantities and weighted entry cost; every campaign must close flat
inside the scored boundary. Boundary cleanup trades require separate exclusion
before admission. Missing costs or numerical quantities fail; optional unknown
facts such as MFE/MAE retain null/unknown and are never synthesized as zero.

The evaluator orders completed trades by independently verified `exit_utc`.
The original `exit_sierra_datetime` remains inspectable as reported and never
determines drawdown chronology. Each original UTC exit must equal the actual
last exit fill and the retained trace. When UTC exit times tie, distinct native
exit sequences from the same run must resolve the order. Each supplied trade
`native_exit_sequence` must equal its last observed exit fill's `native_sequence`
and the retained trace trade's sequence. Missing sequences, duplicated sequences
or ties across different runs leave chronology unresolved. Trade IDs and run IDs
never break a tie. No timestamp or sequence is synthesized for historical rows.

Both adapter and legacy result validation call the existing
`assessIndependentTrades` calculator with this ordering; its net P&L, peak-equity
drawdown and winner-concentration formulas are unchanged. Legacy callers must
also provide the ledger's independently validated `exit_utc` and matching native
exit sequence when supplied by the trace. Missing UTC or ambiguous ties fail
closed. The shared assessment adds `ordering_proved` and `ordering_blocker`;
unresolved chronology has unknown (`null`) drawdown and the existing `FAIL`
verdict. The adapter rejects unresolved chronology and records successful
ordering metadata in `adapter_binding.ordering`. The immutable legacy verdict
field set and PASS/FAIL enum remain unchanged.

`opportunity_id` must be retained identically on the trade original and the
authenticated trace trade, derived by the production normalizer from the
original opportunity-to-native-order/fill chain. Missing historical identities
cannot be invented from timestamps or current source.

Case evidence has schema `vwap-case-evidence/v1` with project/candidate/plan
binding and `cases`, which are the existing targeted case records plus
`trade_comparisons`. Comparisons must cover every baseline and candidate trade
exactly once, with nullable `baseline_trade_id` / `candidate_trade_id`, a reason,
and MATCHED / CHANGED_FILL / AVOIDED_LOSER / SKIPPED_WINNER / UNKNOWN status.
MATCHED and CHANGED_FILL require the comparison and both original trades to carry
the same verified `opportunity_id`; covering every trade ID alone proves no match.
Known skipped outcomes require an observed baseline result with the claimed
sign, the same native opportunity ID on that baseline trade, and an observed
candidate no-entry with that opportunity ID in the authenticated trace's
`no_entries` array. Each event requires `event_id`, `opportunity_id`, `at_utc`,
`reason`, `run_id`, `window_id`, `project_id`, `candidate_hash`, `plan_hash` and
`source_sha256`. Its time must be inside the scored window, and its run/window/
project/candidate/plan/source must match the admitted candidate run. Unestimable
comparisons remain UNKNOWN. The case's counterexamples must equal the retained
baseline/candidate trace `counterexamples` arrays, preserving even empty arrays
explicitly. Exposure totals are preserved in
`adapter_binding`. Execution slippage is already reflected in observed fill
prices: net equals gross minus fees, and slippage is not subtracted twice.

## Software fixtures and verification

`vwap-test-result-adapter.fixtures.mjs` exports
`makeVwapSoftwareFixture(t,index=2,change=()=>{})` and `makeVwapSoftwarePlan()`.
The fixture `t` supplies `after(cleanup)`. Index 2 is WALK_FORWARD and 3 is
OOS_HOLDOUT. These use explicit `SOFTWARE_FIXTURE_ONLY` mock authenticators.
They establish software admission behavior only and are not host evidence.

```powershell
node --test website/ocean-trading/dashboard/workflow/vwap-test-result-adapter.test.mjs website/ocean-trading/dashboard/workflow/targeted-replay-behavior.test.mjs
```

The genuine remaining proof dependency is the authenticated owner-pinned
production verifier/normalizer and real retained receipts/originals. The fixture
path cannot satisfy that dependency.

# Hermes Brain shared contracts 2.1.0

This directory is the portable, read-only S09 wire-contract release. The JSON
Schemas are normative. This guide explains ownership and intended use; it is not
an API binding and grants no runtime permission.

## Release boundary

- Hermes Brain coordinates versioned analytical profiles and these contracts.
- Ocean Trading owns the operational registry, activation, run/workflow state,
  approval decisions and handoffs.
- Strategy projects own executable strategy rules.
- Telemetry owns source observations and unchanged SQLite ledger semantics.
- Authenticated providers compute permissions. Client-supplied identity, scope,
  learning flags or approval fields never grant authority.
- The existing Library remains read-only and is not part of this release.

Every ID has one role. A display name is never a routing key. Legacy trade ID,
transport event ID, processing run ID, strategy attempt/trade ID, canonical
trade ID, experiment ID, candidate ID and case ID are intentionally separate.

## Strategy identity

`strategy_id` is an opaque, lowercase ASCII identifier. It uses alphanumeric
segments separated by either one hyphen or one underscore. Both established
forms are valid, but consumers must preserve the supplied spelling exactly:
there is no separator conversion, alias, or identity merge.

## Paper release lifecycle

`PAPER_ACTIVE_PENDING_INSTANCE_BINDING` means that an approved release pointer
and release history are present, while the actual Sierra installation, chart,
study, account, producer and loaded DLL still have no verified binding. It
permits neither normal ingestion nor a claim that Paper trading occurred.

`PAPER_OBSERVING` additionally requires a matching active Paper execution
instance. Only an observed source session can produce factual Paper evidence.
`ACTIVE` remains the separate production lifecycle and requires a non-null
production version. Historical release records preserve prior baseline and
evaluation facts without retagging their trades or inventing complete hashes.

## Contract index

| Contract | Purpose | Key rules |
|---|---|---|
| trade-event | Append-only trade lifecycle and evidence | Execution status is separate from WIN/LOSS/BREAK_EVEN/UNKNOWN. Unfilled attempts do not invent prices, excursions or R. |
| strategy-profile | Brain-owned analytical profile | Stable ID/name, immutable hashes, baseline versus nullable production version, source-owned rules, evidence policy and validation plan. |
| strategy-registry | Ocean-owned operational mirror and instance bindings | Activation is Ocean authority. An instance binds installation, chartbook/chart/study, producer, version/config and account. |
| trade-assessment-profile | Strategy-aware review around a trade | Pins profile and Run Context. Technical, visual and synthesis reviews remain distinct; unavailable visuals are explicit. |
| run-context | Immutable run intent and observed source state | HOW, WHY and dataset role are distinct. The server computes learner permission. |
| dataset-manifest | Versioned dataset identity and protection | Source revision, rollover/adjustment rules, hashes, partitions, coverage, gaps and protected intervals. |
| workflow-event | Idempotent workflow/run transition | Expected state/revision, actor role, correlation ID and structured error/quarantine result. |
| artifact-manifest | Immutable artifact registration | Hash, role, known/captured/cutoff times, settings hash and supersession link. |
| approval-decision | Human approval record | Only Wayne through the authorised Ocean UI may author it; the decision binds to an immutable snapshot hash. |
| handoff | Dispatch, acknowledgement, progress and result | Failures are explicit and do not silently advance workflow. |
| candidate-result | Experiment/evaluation result | Metrics carry units/quality. Holdout results are restricted until authorised release. |
| run-completion | Coverage and processing completion | Requested/observed coverage, watermark, unique canonical/process counts, no-trade intervals, gaps, failures and manifest hash remain separate. |
| source-adapter-requirements | Deployed source binding | Exact mappings, identity/environment policies, evidence, fail-closed unknowns and idempotency. |

Named schemas are under schemas/ and resolve into shared-contracts.schema.json.
Consumers import the whole release and verify its manifest; copying one wrapper
without the root schema is invalid.

## Event envelope

Trade and workflow events require schema version, event ID/type, source sequence,
occurred/recorded UTC times, producer and payload hash, exact strategy identity
and hashes, profile identity/version, execution instance, source installation
and session, run identity, Run Context revision and Run Context hash.

An identical retry uses the same event ID and payload hash and returns the prior
receipt. Reuse with a different payload hash is DUPLICATE_CONFLICT and is
quarantined.

## Run and learning matrix

| Environment | Purpose | Partition | Server result |
|---|---|---|---|
| PAPER_FORWARD | LEARNING | FORWARD | SCOPED_LEARNING |
| REPLAY | HISTORICAL_BUILD | DISCOVERY | HISTORICAL_DISCOVERY |
| REPLAY or BACKTEST | DEVELOPMENT_BACKTEST | DEVELOPMENT | EVALUATE_ONLY |
| REPLAY or BACKTEST | RESEARCH_EXPERIMENT | DEVELOPMENT | EVALUATE_ONLY |
| REPLAY or BACKTEST | VALIDATION | VALIDATION | FROZEN_EVALUATION |
| REPLAY or BACKTEST | PROTECTED_HOLDOUT | HOLDOUT | RESTRICTED_EVALUATOR |
| PAPER_FORWARD | SHADOW_FORWARD | FORWARD | FROZEN_EVALUATION |
| Any represented environment | NOT_ELIGIBLE | declared partition | NONE |

Other combinations are invalid. LIVE_REAL has no learning route in this initial
release. Import is transport, not proof of original execution provenance.

## Trade units and nulls

- Price and point fields are points per contract.
- Currency and fee fields are totals in the declared three-letter currency.
- Undefined risk R is null with an explicit reason.
- MFE is favourable-positive and MAE adverse-negative; each declares fidelity,
  position method and measurement window.
- Closed financial trades use WIN, LOSS or BREAK_EVEN. REJECTED, FAILED and
  CANCELLED use financial outcome UNKNOWN.

## Point-in-time evidence

Decision snapshots retain known time, observation time, source/chart hashes,
method version, bar-completion state, gaps and values. Post-outcome material is a
separate immutable artifact/event and cannot change what was knowable at entry.

## Compatibility and examples

Existing Brain v1 trade/assessment schemas and Telemetry Replay 7, Paper 3 and
Live 5 stores remain unchanged. Adapters preserve stored IDs and meanings and
quarantine unknown identity, source purpose or units.

This release does not select a production source, alter VWAP rules, create an
Improvement Case, bind Sierra, or produce a Paper result.

Positive, scenario and negative fixtures cover every contract, paper learning,
historical build, Replay evaluation-only, holdout, frozen forward, unknown
import, unfilled rejection, authority boundaries and duplicate conflicts.

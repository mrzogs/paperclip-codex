# Shared contract 2.1.0 migration plan

## 2.1.0 Paper-onboarding compatibility correction

Release 2.1.0 is a backward-compatible successor to immutable 2.0.1. It keeps
the established identifier grammar: lowercase ASCII alphanumeric segments joined
by one hyphen or one underscore. Existing hyphenated and underscored IDs remain
valid. No identifier is transformed, aliased, or merged: `alpha-beta` and
`alpha_beta` remain distinct identities.

It adds an explicit Paper lifecycle. A release may be designated
`PAPER_ACTIVE_PENDING_INSTANCE_BINDING` without claiming that Sierra, a Paper
account, a chart/study, a producer, or a trade has been observed. The later
`PAPER_OBSERVING` state requires the exact release and an active Paper execution
instance. Production remains separate and nullable.

Release history accepts `PARTIAL_HISTORICAL` records when an old baseline has
reliable version/result evidence but no complete source/DLL hashes. This never
fills missing hashes or becomes a runtime binding.

Consumers must bind to this complete release rather than replacing an
individual schema. The original 2.0.0 and 2.0.1 directories and their receipts
remain immutable and valid for their existing payloads.

## Current compatibility facts

- Brain trade-event 1.0.0 and trade-assessment-profile 1.0.0 remain unchanged.
- Telemetry exposes Replay schema 7, Paper schema 3 and Live schema 5.
- Ocean uses mode-specific read-only bindings and preserves current P/L
  precedence, ordering and unpaired-fill treatment.
- The legacy generic `vwap-wave-pullback` draft remains a separate historical
  record. It is not an alias for the attested
  `vwap_wave_pullback_balanced_nasdaq_v0434` identity.
- Paper designation does not prove a current instance, source session, account,
  telemetry producer, loaded DLL, or a Paper result.

## Additive adoption sequence

1. Each consumer imports the complete 2.1.0 directory read-only and verifies the
   release manifest.
2. The consumer publishes an actual provider binding and adapter acceptance
   receipt. S09 defines wire meaning only; it does not claim endpoints exist.
3. The S10 onboarding export records historical releases and the designated
   Paper release without a runtime instance. The operational registry must add
   an exact active Paper instance before normal ingestion becomes eligible.
4. Telemetry retains legacy tables/IDs and emits v2 envelopes only after its
   installed-mode adapter passes.
5. Brain accepts v1 records unchanged. A v2 projection links to the source and
   adapter receipt; it never rewrites approved evidence.
6. Ocean changes its read model only after v1/v2 parity tests preserve ledger
   values and UI behaviour.
7. Provider activation, history ingestion and production changes require later
   tasks and explicit authority.

## Field migration rules

| Existing | v2 target | Rule |
|---|---|---|
| SQLite/v1 trade_id | legacy_trade_id | Preserve unchanged; not canonical identity. |
| v1 WIN/LOSS | financial_outcome | Direct only for financially closed trades. |
| v1 FAILED/ABORTED/REJECTED | execution_status | Outcome UNKNOWN; no fabricated P/L. |
| v1 realised_points | gross_points_per_contract | Only after producer units are verified. |
| SQLite net_profit_loss | net_currency_total | Preserve S06/S07 semantics and currency. |
| v1 stage snapshots | decision_evidence | Preserve known/captured times and hashes. |
| v1 post-exit snapshot | evidence attachment | Append immutable late evidence. |
| v1 run fields | run-context | Validate v2 matrix; quarantine ambiguity. |

## Rollback

Consumers can stop v2 and continue existing v1/SQLite paths because S09 makes no
runtime or data migration. Remove only the imported read-only snapshot and keep
its receipt. Do not restore, delete or reindex Brain, Library, Qdrant, SQLite or
Ocean data.

## Deferred work

- S10 owns VWAP onboarding and release-history preservation. A separate
  execution-binding task owns factual Paper instance observation.
- Provider routes/auth/runtime acceptance belong to assigned later tasks.
- Historical ingestion, provider activation, production deployment and strategy
  rule changes are outside S09.

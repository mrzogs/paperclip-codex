# S29.2 Ocean Adapters

Extends the existing website on port 3102 and its separate workflow SQLite store.
No trading SQLite, ledger calculation, source-monitor, Brain/Library, or strategy
code is changed. TEST service readiness is not human enrollment or market acceptance.

## Protected Setup

Use the existing `scripts/ocean-workflow-operator.ps1` with native Windows PowerShell.
`Integration-Import -RequestFile <json>` accepts exactly `task_id`, `bundle_path`,
and `bundle_sha256`. It verifies the archive, owner, complete member hashes and
file map before recording the receipt and binding. It does not enroll or widen
an identity. `Integration-Export` reads the persisted bindings and pending facts.
`Setup-Import`, `Setup-Read`, and `Setup-Export` retain their established semantics.
Imported receipt duplicates compare the original owner receipt and bundle hash;
new verifier metadata does not invalidate an identical historical import.

The explicit task map preserves S23/S23.1/S24/S26.1 BLOCKED diagnostics, S23.2
MACHINE_FOUNDATION, literal amendments, and declared sequence through S53.2.
Do not rewrite a diagnostic as PASS, import an unsealed self-result, or use a
receipt as a strategy approval. Verified archives are bounded at 512 MiB compressed,
2 GiB expanded, 512 MiB per member and 10,000 members; member hashes are streamed.

## Dormant Operational API

The additive provider API is `/api/workflow/operational/v1`. Shared wire schemas
remain release 2.1.0, byte-pinned with local Git attributes. Existing TEST identities,
audiences, routes and constraints are unchanged. Operational service scope uses
the separate `Ocean workflow operational v1` audience. LIVE_REAL is denied.

- `GET policy`, `GET pending`: authenticated read-only policy and scoped proposals.
- `POST dataset-manifests`: Brain proposal only. Exact S31.2 sealed receipt/member
  bytes are required. The proposal grants no dataset permission.
- `POST reviews`: Wayne browser only; server recomputes a pinned operational
  review from an observed factual binding, registered profile and pending manifest.
- `POST decisions`: Wayne browser only. New provider-owned
  `ocean-operational-decision/v1` scopes STRATEGY_ONBOARDING, DATASET_RELEASE and
  RUN_RELEASE remain separate. This does not change the shared approval enum.
- `POST decisions/revoke`: Wayne browser only; append-only revocation.
- `POST runs/prepare`: Wayne browser only; all three exact, unexpired, unrevoked
  decisions required. Creates a pinned READY run; does not start Sierra or ingest.
- `POST activate`: Wayne browser only; enables that exact run after rechecking
  decisions, dataset permissions and an actual compatible source handshake.
  No global switch or machine token bypasses this per-run release.
- `GET runs`: operational producer's exact strategy/instance catalog (or human).
- `POST context/resolve`: exact operational Telemetry identity, finite credential,
  factual producer, pins, permission and fresh compatible handshake required.
  Records ACTIVE only after actual observation; never starts the source.
- `POST events`: same checks, immutable idempotent receipt; conflicting event ID
  rejected. Receipt persistence is not dispatch or completed analysis.
- `GET receipts/{receipt_id}`: only the scoped producing operational identity or
  human can read receipt metadata. TEST credentials cannot read operational runs.

`Register-Facts -RequestFile <json>` is protected local operator setup. It accepts
the exact shared executionInstance, code/profile hashes, source observation time,
two sealed owner bundles and explicit JSON Pointer proofs for every factual field.
Source facts must come from Telemetry, code/profile/config facts from Strategy.
Null fields, guessed observations and test- promotion fail closed. It registers
facts only. Separate `Enroll` with namespace OPERATIONAL and factual_binding_hash
is required; renewal cannot change scope. No operational enrollment was performed
during S29.2. Human UI wiring/readback is S33.2; genuine decisions are S40.2 onward.

Full machine-readable requests, exact schema bytes and lineage travel in the
S29.2 result bundle. Consumers must acknowledge the additive v1 provider contract;
S30.2 owns final Telemetry consumer integration. Do not execute that task here.

## Verification And Rollback

Run `s292.test.mjs`, `test-communication.test.mjs`, and `backend.test.mjs` using
the verified result evidence directory in OCEAN_S292_EVIDENCE and verified S19
plan in OCEAN_S20_PLAN_FILE. S292 tests contain explicitly isolated human/source
fixtures; they are not evidence Wayne approved a run. The real site verifies TEST
receipts, cross-caller rejection, browser isolation, protected setup export,
normal-launcher restart persistence and legacy source-table parity.

Migrations 5 and 6 are additive and confined to the workflow DB. Never downgrade
a populated store or remove immutable history to satisfy an older version.
For rollback, disable only workflow through the normal launcher, preserve a fresh
private backup, and reconcile the pre-edit source/database backup with any later
workflow writes before an explicit scoped restore. No trading DB restore is needed.
Keep source-monitor shell children hidden; this change does not replace that fix.

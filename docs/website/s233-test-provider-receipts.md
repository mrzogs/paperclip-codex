# S23.3 Isolated TEST Provider Receipts

S23.3 extends the existing Ocean website. It does not create a replacement site,
change ledger semantics, register physical Sierra instances or enable normal
ingestion. It adds the coexisting `/api/workflow/test-communication/v1` surface.

The provider binds each receipt to the authenticated caller, exact action,
strategy, nonphysical TEST instance and immutable S24.1 declaration hash. It
persists before acknowledging, reauthorizes retries, returns the original
receipt for identical retries and rejects conflicting payloads and cross-caller
access. Isolated migration 004 creates append-only TEST metadata tables; it does
not change the telemetry or ledger databases.

Operator-only `Test-Prepare`, `Test-Export` and `Test-Cleanup` actions manage
bounded fixtures through the existing protected operator facility. Consumers
cannot enroll identities, invent physical instances or approve strategy work.
Finite credentials, revoked tombstones and existing callers remain enforced.

## Evidence And Local Verification

The immutable S23.3 result export contains complete effective bindings and
schemas, the early-consumer capability matrix, fixture operations, literal
forward receipt IDs, compatibility report and classified test evidence. S23.2
remains the immutable machine foundation. Future consumer adoption is distinct
from provider acceptance and is tested by each respective owner.

The already-deployed source is byte-identical to this feature's ten source
files. Fresh GET-only allow/deny and persisted-receipt readback checks support
reuse of the earlier full deployed provider tests; no repeat restart or
credential lifecycle operation is required solely to reconcile Git history.

For isolated tests, use Node with `node:sqlite`, Python with `jsonschema`, and
the hash-verified S24.1 communication declaration and S19 plan from their sealed
owner bundles. Set `OCEAN_S233_DECLARATION`, `OCEAN_S20_PLAN_FILE`, and
`OCEAN_TRADING_PYTHON`, then run:

```text
node --disable-warning=ExperimentalWarning --test website/ocean-trading/dashboard/workflow/test-communication.test.mjs website/ocean-trading/dashboard/workflow/backend.test.mjs
```

Synthetic inputs do not establish real trades, coverage, human enrollment,
strategy approval or live-market readiness. Normal ingestion/Brain submission
stay OFF and LIVE_REAL remains disabled. S23.3 does not execute the next task.

## Git Delivery Boundary

Wayne approved the separate predecessor baseline rooted at published commit
`69a7243e62e2af3633c0a4fc981402ab0c54d644`. This feature targets `develop`, not
local main's unpublished unrelated Brain history. The existing operational
checkout is not switched or deployed from this temporary delivery worktree.
GitHub Actions are suppressed during publication. This PR must not be merged
as part of S23.3.

Patch exports must use explicit newline handling and be application-tested
against their exact pre-edit source. A prior Windows export doubled carriage
returns; its sealed diagnostic is preserved and the corrected delivery patch
is generated from Git with byte-safe output.

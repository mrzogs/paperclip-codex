# Board-owned completion evidence relay

The relay delivers selected accepted evidence between two exact issue UUIDs in
different companies. It writes a destination inbox receipt, original evidence
attachments and a comment in one database transaction. The destination remains
`blocked`; completion is eligible input, never strategy or destination approval.
Brain-root attestation and physical-owner gates remain separate.

## Authority and configuration

There are no default or production mappings. Creation requires an authenticated
Board API key, with explicit active writable memberships in both companies.
Implicit local Board and session identities cannot create or enable mappings.
No bearer secret is stored in the mapping. Delivery rechecks the key ID's owner,
expiry/revocation and both current memberships under transaction locks. An admin
flag alone is insufficient. Agents cannot configure or invoke the relay.

- `POST /api/completion-relays`: validate a binding and create it **disabled**.
- `PATCH /api/completion-relays/:uuid`: `{ "enabled": true|false }`, only by its
  creating Board identity/key. Enabling validates the exact binding again.
- `GET /api/companies/:uuid/completion-relays`: owner-only inspection with current
  active membership in both companies. Session inspection works even after the
  mapping's credential is revoked, making retry/dead-letter action visible.
- Company Settings shows owned mappings, revisions, enabled state, attempt count
  and dead-letter owner/action. Configuration uses the authenticated Board API.

Bindings use the shared `completionRelayMappingSchema`: source project UUID,
domain/strategy, both company/issue UUIDs, exact terminal status/version/assignee,
successful producer run, independent review decision UUID and complete selected
receipt hash (`relayAcceptanceHash`), reviewer identity, selected work product and
attachment UUID/hash pairs, destination gate, monotonic mapping revision and UUID
idempotency key. `authorizeOriginalCopies: true` explicitly authorizes copying
the selected originals, which the Board must have checked contain no secrets.
No real route is authorized merely by committing a binding or configuration.

Bindings are immutable. Disable an old revision and create a corrected revision;
never rebind an idempotency key. Same key with a different binding conflicts.
No competing enabled revision, self-link, chain or cycle may be enabled. A
superseded revision cannot subsequently be enabled.

## Eligibility and receipts

The exact source issue must still be `done`, at the bound version and assignee.
The successful producer run must match the accepted work products. The latest
native review/approval decision must match its bound hash and independent actor,
occur after producer completion, and accept evidence last changed before that
review. Reopening, reassignment, review rejection, missing evidence or receipt
changes block delivery. The destination must still be blocked.

Only the selected artifact bytes and generated receipt fields cross the boundary.
Source issue text, source URLs and filenames are not copied. The service downloads
each original, verifies SHA256/size, writes an independent destination object and
downloads it again to verify SHA256 before inserting destination attachment rows.
Each file is bounded to 10 MiB. A failure yields bounded retry or a precise
dead-letter, never an inaccessible source link masquerading as delivered evidence.

The outbox has a unique row per immutable mapping; the destination inbox has the
same uniqueness constraint. Destination comment, attachment rows, inbox receipt,
outbox delivery state and both-company activity entries commit atomically.
Rollback/crash before commit exposes none of these rows. Storage writes can leave
unreferenced blobs after rollback; blob collection is not part of this candidate.

Startup and 30-second reconciliation scan committed enabled mappings, closing the
source-commit/enqueue gap without relying on an in-memory completion event. Workers
lock mappings and outbox rows; duplicate processing cannot create a second receipt.
Storage/transaction failures retry after 10 and 60 seconds, dead-lettering on the
third failed attempt. Binding/authority mismatches dead-letter immediately. The
creating Board user must inspect the failure and create a corrected revision.

## Required integration proof

Generate the DB migration normally, then exercise an isolated disposable Board API
flow with two synthetic companies: create disabled, explicitly enable, reconcile,
download and hash independent originals, replay duplicates, and verify the
destination remains blocked. Also test crash/restart boundaries, lost enqueue,
revoked key/membership, changed version/evidence/review, out-of-order revisions and
cycle rejection using the actual database. Unit eligibility tests alone are not
durability or API evidence. No production credential borrowing, real routing,
live restart, deployment or trading action is needed for this proof.

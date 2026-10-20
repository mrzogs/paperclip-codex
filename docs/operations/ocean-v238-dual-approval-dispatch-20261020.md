# Ocean v0.6.238 dual-approval dispatch gate — 2026-10-20

## Outcome

Ocean now has a persistent Website monitor for the sealed CICD VWAP v0.6.238 comparator contract. It waits for both exact Paperclip approvals, in either decision order, and wakes only the coordinator bound to OCEA-20. The wake grants one action: `READ_ONLY_PREFLIGHT_ONLY` for the physical comparator, dataset, and STTL2 lineage.

The gate does not authorize a Replay Two write, CICD runtime/output write, run or release materialization, Sierra/Replay start, Paper action, Live action, role mutation, or automatic approval. After the read-only preflight, the coordinator must request or derive the exact TEST-only Replay Two/runtime/output write/start scope separately.

## Bound authority

- Contract: `cicd-vwap-v238-sep2025-z25-discovery-20261020-r1`
- Contract hash: `sha256:26520c8bcd372ebef56d62a95d51bf477d4cefb61ca65d13f10d06f2edfd8014`
- Document hash: `sha256:33233134255ba77ef893f3b61ab32c9608fb4529d71cbafb4eea00bb7c532a0c`
- Run: `cicd-vwap-v238-discovery-20250913-20251001-z25-20261020-r1`
- Context hash: `sha256:d6282a2e3fbbaf4dcdd698a4e3ff2302a161de20d34adabed362800bac5616d7`
- Dataset/physical approval: `d2710454-1cc5-4058-b219-1bfae717042a`
- RUN_RELEASE approval: `f3b264eb-f081-4b51-b105-6a09c2b42860`
- Issue: `OCEA-20` / `2b41e5a2-faac-4790-b0e7-79abc6718bf9`
- Coordinator: `CICD VWAP Recovery Coordinator` / `75618a1a-a7ba-44bd-b391-48d58617433c`

## Safety and idempotency

The monitor verifies the sealed contract and approval payloads, exact issue/project/workspace/assignee binding, coordinator model/root/metadata, read-only external filesystem grants, and non-Live safety fields. A persistent state file and exclusive lock live outside immutable releases. Before and inside the lock, the monitor searches Paperclip heartbeat history for the deterministic issue/wake-reason pair. This prevents duplicate dispatch after a process restart or a release change.

A queued wake receipt is not success. Ocean polls the returned Paperclip heartbeat run and records dispatch only after readback proves a non-queued run with `startedAt`, the exact OCEA-20 issue ID, and the deterministic wake reason. A queued-only timeout or mismatched readback remains `ATTENTION_REQUIRED`.

## Verification

- Focused workflow/browser suite: `52/52` passed.
- Dual-approval dispatch suite: `9/9` passed, including one pending, rejection, changed contract hash, changed context hash, order-independent approval, restart-safe no-duplicate dispatch, queued-only refusal, issue binding, coordinator write-grant refusal, and an HTTP queued-to-running readback.
- Quant terminal suite: `130/130` passed; integration host test `1/1` passed.
- Ocean deployment resolver contract: passed.
- Live Paperclip readback before deployment: both approvals `PENDING`; persistent gate state `WAITING_FOR_BOTH_APPROVALS`; `dispatched=false`.
- Repository-wide opportunistic `node --test` was stopped after unrelated existing workflow/outbox failures and a long no-output period. Those failures were not in the focused changed paths and are not represented as passing.

No Replay, Paper, or Live instance was started, configured, written, or deployed during this work.

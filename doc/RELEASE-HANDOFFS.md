# Scoped VWAP release handoffs

The Ocean Trading VWAP release owner uses `scripts/paperclip-release-handoff.mjs`
when delegating review or release work across issue owners. This is an opt-in
project workflow, not a global recovery switch. It uses the caller's ordinary
Paperclip API permissions. Installing this file does not activate a service or
change existing agent instructions.

Freeze and upload the available inputs on the source issue first. The manifest
contains attachment IDs and SHA256 digests, never credentials or local artifact
paths. The helper reads attachment metadata and bytes before creating work.

```json
{
  "version": 1,
  "flow": "vwap-release",
  "companyId": "00000000-0000-0000-0000-000000000001",
  "projectId": "00000000-0000-0000-0000-000000000002",
  "sourceIssueId": "00000000-0000-0000-0000-000000000003",
  "assigneeAgentId": "00000000-0000-0000-0000-000000000004",
  "handoffKey": "review-patch-v1",
  "mode": "ready",
  "title": "Independently review the frozen release patch",
  "instructions": "Check the patch and evidence. Record acceptance or rejection before integration.",
  "artifacts": [
    {
      "attachmentId": "00000000-0000-0000-0000-000000000005",
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }
  ]
}
```

From the reviewed checkout, with the normal injected `PAPERCLIP_API_URL`,
`PAPERCLIP_API_KEY`, and `PAPERCLIP_RUN_ID`:

```powershell
node scripts/paperclip-release-handoff.mjs <private-manifest.json> <absolute-private-state-directory>
node --test scripts/paperclip-release-handoff.test.mjs
```

Use one durable private state directory per release-owner installation, outside
Git, on a persistent local filesystem. Keep it through process and host restarts.
The journal binds the API origin and canonical manifest digest. A changed input
requires a new `handoffKey` and explicit reconciliation of the old blockers.
Do not run this handoff concurrently from multiple machines or different state
directories: local locking is not a distributed exactly-once guarantee.

## Execution contract

- `ready` creates the child explicitly as `todo`, with all frozen links in the
  initial POST. It never depends on a later creator PATCH to another owner's task.
- `awaiting_inputs` requires a nonempty `missingInputs` string array. It creates
  the parked deliverable as `backlog` and an immediately actionable `todo`
  activation task assigned to that same deliverable owner. Both become source
  blockers. The owner gathers inputs and activates their own task using normal
  permissions, or opens a required board interaction. Activation-task completion
  must include actual child run readback or an explicit obsolete-blocker disposition.
- To recover an existing parked child, use `mode: "awaiting_inputs"`,
  `existingBacklogIssueId`, and `missingInputs`. If activation actually returned
  403, include `activationErrorStatus: 403` as evidence. The helper never retries
  that PATCH, impersonates the board, changes permissions, or promotes the child.
- Only the source issue is PATCHed; existing blocker relations are preserved.
  Run from the checked-out source's heartbeat and serialize source mutations.
  The public blocker-replacement API has no compare-and-swap; a board edit racing
  between read and PATCH must be reconciled by the source owner.
- Dispatch means a returned `queued` or `running` run ID for the exact company,
  assignee, and next issue. Status `todo`, a historical successful run, an intent
  JSON object, and a comment are not dispatch proof. The next issue may be the
  activation task; this does not claim the parked deliverable is executing.
- Exit 0 means dispatch observed or deliverable completed; exit 2 means no live
  dispatch was observed and names the assignee action. The source remains blocked
  on owned work. Exit 1 means a specific validation/HTTP/transport error; the
  heartbeat must record it and leave a named owner/action or first-class blocker.
  Missing dispatch is not repaired by repeatedly creating more recovery issues.
- A later source continuation can rerun the same manifest/journal to observe the
  same issues. There is no polling loop or implicit daemon. Normal blocker wakes
  own completion. A deployment requiring unattended timed checks must separately
  provision an approved bounded routine and verify its actual wake/admission.

## Restart and failure recovery

Every create intent is journaled before POST. A stable source/key/stage marker
allows the next process to recover a committed create whose response was lost.
Repeated invocations reuse that issue and reject changed frozen descriptions.
Duplicate matches fail closed. An uncertain or rejected create with no match is
not blindly retried: the authorized owner inspects API/audit state and reconciles
the journal before continuing. A 403 never grants additional authority.

Issue-list descriptions are previews, so reconciliation fetches full issue records
before matching a marker or frozen input. Search is restricted to the exact project
and source parent, requests 21 rows and accepts at most 20 candidates. A saturated
result fails closed before creation rather than assuming an unseen page is empty.

A process crash can leave a `.lock` file. Verify the recorded host/PID/run has
ended and no writer remains before an authorized operator removes that exact lock.
Do not automatically steal it. Preserve the journal. Cross-host failover requires
exclusive custody transfer of the state directory. Backups must include it.

The focused suite uses a disposable HTTP fixture and fresh Node CLI processes to
prove restart persistence and lost-response recovery without touching production.
It does not prove a live Paperclip server restart, production actor authorization,
or deployed scheduler behavior.

## Deployment and live acceptance

1. Obtain independent review of the exact commit and local results. Integrate only
   into `develop` through the reviewed PR. Do not merge main or dispatch hosted CI.
2. From the resulting immutable source, validate the existing release gates.
   Adopt this command in the VWAP release owner's deployment instructions and
   provide a private persistent journal directory. Keep graph-wide auto-recovery
   disabled; do not change Gmail review or unrelated project recovery settings.
3. For a real approved ready handoff, record the manifest digest, artifact hashes,
   initial `todo` creation, source blocker relation, and exact assignee run ID.
4. For an approved intentionally parked or existing 403 handoff, show one parked
   deliverable, one same-owner activation task, and that task's queued/running
   run. Have that authorized owner activate the child and record the child's run
   before closing activation work. Do not manufacture an unauthorized PATCH.
5. Stop and restart the bounded helper process against the same journal. Confirm
   unchanged issue IDs and no extra activation tasks. A separate supervised
   Paperclip restart, if the release requires one, needs its own authorization and
   before/after admission evidence; no restart is needed to load this CLI helper.
6. Verify unrelated Gmail review issues and the global recovery setting are
   unchanged. Record any missing admission as a named owner/action, not success.

Rollback is to stop invoking the helper and restore the prior owner instructions.
Keep existing owned child tasks/blocker relations and reconcile them explicitly;
do not delete the journal or cancel another team's work. Brain holds governance
and evidence only. No Stage, Replay, Paper, Live, baseline/LIVE_REAL, real routing,
order paths, credentials, or trading authority are changed by this contract.

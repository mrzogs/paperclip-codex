# Ocean VWAP current-action and request responsiveness repair

This changes the Ocean website read model, not Sierra or trading authority.

## Verified problem

The r2 supervisor retired unresponsive website PID 59288 after four consecutive
liveness failures on 20 October at 17:18:52–17:19:49 UK, then started PID 48476.
Empty child stderr is not proof of health. Short successful probe series did not
establish sustained continuity.

A 45-second profile while opening the actual strategy page measured 3,044 ms
inside `probeReplayTwoRuntime` -> `spawnSync`. Its two-second cache expired before
the three-second PowerShell observation finished. The HTTP thread therefore
repeated this blocking work on page refresh. The profile also identified repeated
run-summary JSON parsing. A read-only comparison on the current workflow ledger
(`cicd-vwap-discovery-20260101-20260301-v011`, 147 closed pins) returned identical
summary JSON in 40 ms before and 1 ms after the linear lookup change.

These are measured blocking paths. They do not by themselves establish the full
cause of the earlier minute-long stall; deployment must be observed across longer
page-refresh and monitor intervals.

## Resulting behavior

- The default strategy-page process/status probe runs in one bounded background
  subprocess. HTTP reads return pending or recent observations. Expired and failed
  observations withdraw verified state. This supplies no launch capability.
- Run summaries parse each evidence row once and use a trade-ID set. Completion,
  duplicate, conflict, missing-pin and open-pin semantics are preserved.
- A live, bounded Paperclip blocker traversal identifies the current leaf job and
  its owner. Completed prerequisite edges no longer conceal the review. Active
  recovery actions name the recovery owner rather than the failed assignee.
- Worker readback binds run ID, issue, company, owner and effective project
  workspace. Queued/finished heartbeats are not running/deliverable proof.
- The top-level human staging decision stays in Paperclip. Automatic work appears
  next to it, with freshness, recovery and eligible-evidence status. Instance/host
  admission, each run manifest, any future TEST standing policy, and Paper/Live
  promotion are distinct disclosed scopes.
- Matching local stage-receipt content remains authority-unverified. A historical
  comment cannot establish current exclusive booking. The separate Ocean source
  chat owns the booking registry; this branch adds no registry or reservation API.
- The workflow module URL changes so a browser does not reuse an older release's
  JavaScript under the same cache key.

## Local verification

Focused Node tests cover the read model, dispatch, monitor eligibility, browser
wording, background probe and real in-memory SQLite summary semantics. Quant
Terminal tests and the deployment-resolver contract are also required.

The legacy S21 run-manager harness was attempted but could not run because its
external S19 consumer snapshot is absent. `pnpm -r typecheck` was attempted but
pnpm tried to reinstall/purge the existing dependency directory and aborted for
lack of a TTY. Dependencies were preserved; broad monorepo checks are not claimed.
The website is an independently tested package; no Paperclip core code changes.

## Remaining boundaries

At the inspected state OCEA-29 is an offline candidate only. OCEA-30's reviewer
failed with `adapter_failed`: its `gpt-5.4-mini` configuration was rejected by the
account. A successful recovery-coordinator turn is not a completed review.
The current issue's effective workspace was the correct CICD root. A supported,
issue-scoped model configuration and real review readback remain owner work.
Staging approval `9f8cd5c6-948a-4818-9fad-5bd56d00cb23` remains pending.
No standing TEST policy, physical staging, measurement start, Paper/Live
deployment, or learning eligibility is inferred.

## r3 deployed follow-up: historical case hydration

Release `ocean-3635828-20261020-vwap-continuity-r3` fixed the displayed approval
source and exposed fresh Sim1 trades, but sustained testing still found liveness
timeouts. Do not report r3 as a complete responsiveness fix. A second deployed
45-second CPU profile during real browser refresh measured 16,548 ms in SQLite
`get` below continuation `forCase`/`backend.one`, and 12,804 ms below research
`statusForCase`. The strategy overview eagerly called full `readCase` for up to
200 cases, repeatedly loading and validating historical research artifacts.

The follow-up makes that strategy navigation list a bounded metadata-only
projection. Every row explicitly says to open case details for current evidence
and next action; it supplies no verified research or authority claims. Full case
detail and all protected action validation paths remain unchanged. Two real
in-memory SQLite/source-contract regression tests cover bounds, strategy isolation,
no artifact access, non-mutating behavior and retention of full detail checks.

Paperclip OCEA-30 was independently read back as `done`; its reviewer run
`54b4b5c7-3d17-4c79-a539-45a1b123fb51` succeeded at 16:49:44.539Z following an
issue-only supported command/model/workspace override. This is an offline review
completion, not host-integration, staging, Replay, Paper or Live authority.

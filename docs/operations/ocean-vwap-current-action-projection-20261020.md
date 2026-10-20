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

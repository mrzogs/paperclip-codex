# Fresh onboarding projections

The strategy-list and strategy-detail HTTP views await a fresh file projection in
one persistent read-only worker per backend. This removes synchronous source and
auxiliary file reads, hashing, JSON parsing and projection from the HTTP event
loop. The initial strategy identity is also read off-thread. Existing database
queries remain on the backend connection; the worker never opens a database,
constructs a backend or starts a native/Sierra observer.

The worker runs a fixed adjacent module with empty environment and `execArgv`,
96 MiB old-generation / 16 MiB young-generation heap limits, and no report-selected
code. The parent resolves every operator-configured/default source path before
sending it. Context is limited to 256 KiB; each regular file to 4 MiB; all reads
in a job to 16 MiB and 16 calls; result JSON to 2 MiB. Limits reject the entire
HTTP projection with an explicit error, rather than truncating or treating a
caught partial read as qualified evidence.

There is one active job and at most two queued jobs. Identity and projection
share a single absolute 20-second deadline, including queue time. Strategy-view
browser refreshes allow 25 seconds; other browser requests retain 12 seconds.
Client disconnect cancels the work. Timeout/cancellation reject the interrupted
job while preserving independent queued reads. Worker exit/error reject pending
jobs. Fresh reads wait within the same bounded queue and their original deadline
while a worker retires; a successor cannot start until termination has completed.
A termination failure never grants permission to create another worker. Backend close rejects
all work and terminates the worker. Each browser request retains its own deadline
even when navigation supplies an external cancellation signal; companion session,
dashboard and public improvement-status requests retain 12 seconds.

No projection/result cache or last-good approval fallback is used. The existing
pure `loadStrategyOnboarding` implements both paths. Existing synchronous action
validation keeps the original filesystem behavior. File hashes, modification
times, missing/invalid states and null values retain their existing meaning.
Strategy identity is rechecked after the asynchronous gap. Only the existing
informational runtime cache is observed in the parent; one shared merge function
sets `replay_runtime` and `activation.actual_source_started`. No gate is inferred
from that observation, and `DEGRADED_READ_ONLY` mutation gates remain unchanged.

Unexpected source-projection exceptions keep the original sanitized HTTP 500
`WORKFLOW_INTERNAL_ERROR` contract, without forwarding source messages or stacks.
Deliberately public `WorkflowError` status/code/message contracts are transported
as that type. Newly introduced resource-budget and availability failures remain
explicit HTTP 503 errors. Source invalid/missing states caught by the existing
parsers retain their original projection semantics.

Focused software verification:

```text
node --test workflow/onboarding-projection-reader.test.mjs workflow/onboarding-read-timing.test.mjs request-timing.test.mjs workflow/runtime-probe-cache.test.mjs
```

These fixtures establish software behavior only, not production latency or
physical strategy acceptance. A reviewed successor still needs one bounded
actual strategy-view observation with independent HTTP liveness.

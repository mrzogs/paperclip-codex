# Bounded diagnostic entry markers — runtime activation on HOLD

This is diagnostic source and software-fixture verification only. It neither
fixes a stall nor establishes broader reliability, trading authority or a CPU
root cause. Historical passing availability windows remain historical evidence.

The default is OFF. There is no diagnostic listener, endpoint, global monkeypatch,
dynamic stack capture, Inspector profiler, credential/body/SQL/argument capture,
worker replacement, cache change, deadline change, restart policy or trading action.
Quant uses a local optional observer, default no-op, and remains standalone.

The [Node 24 Worker documentation](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html#new-workerfilename-options)
limits `resourceLimits` to its JavaScript engine; external buffers and total
process memory need separate accounting. The [Node 24.16 Inspector CPU-profiler
example](https://nodejs.org/download/release/v24.16.0/docs/api/inspector.html#cpu-profiler)
returns the profile on `Profiler.stop`. This design does not infer a hard raw
profile-buffer bound or a same-thread stop deadline from that API, and uses no
CPU profiler. These are implementation limits, not evidence of an incident cause.

## Operator configuration and process binding

Existing `OCEAN_WEBSITE_CONTROL_ROOT` selects the one optional startup file
`sync-stall-capture.json`, outside the immutable release manifest. No HTTP/report
value selects a file, code, budget or scope. The async read is bounded to 8 KiB,
32 path components, and a one-second **logical admission** decision. Missing,
unreadable, invalid, aliased, expired or late configuration latches OFF for the
process, retains an internal `DISABLED` state, and cannot fail HTTP startup.
The production state observer is a no-op: lifecycle states do not emit stderr or
other output outside the single budgeted artifact. Software fixtures may inject
an observer; the controller's internal status retains pending ownership.
Underlying startup I/O remains owned until it actually settles; `config_pending`
does not claim that a timed-out native read has completed. There is no retry or
config poll. Absolute monotonic checks reject late config even if timer delivery
was delayed. No shared memory or worker is admitted on an OFF decision.

The exact six-key schema is:

```json
{
  "schema_version": "ocean-sync-stall-capture/v1",
  "enabled": true,
  "expected_source_commit": "<exact loaded 40-hex commit>",
  "expected_manifest_sha256": "<exact loaded 64-hex deployment manifest pin>",
  "expires_at_utc": "<future UTC ISO timestamp, at most 30 minutes away>",
  "duration_ms": 1800000
}
```

Both pins must exactly equal the existing validated deployment environment.
Duplicate/extra keys are rejected. The effective window is the smaller of
duration and remaining expiry. The header binds source, manifest, actual original
configuration SHA256, fixed catalogue SHA256, PID, process start and capture window.
No runtime configuration or production output is provisioned by the source tests.

## Hard structural bounds and ownership

ROOT-approved bounds: 8 KiB shared memory, 16 selected synchronous frames, 64
recent events, 250 ms watchdog polling, five-second stale threshold, at most
30 minutes of NEW work, 64 emission attempts and 128 KiB aggregate attempted
output bytes. The header counts. Every full buffer is reserved **before** a
single write; partial and failed attempts retain their full charge. There is no
preallocation/rewrite accounting shortcut, write retry, backlog, rotation or
automatic deletion. An oversized record ends emission rather than truncating it.

One fixed adjacent Worker uses an empty environment and `execArgv`, with a 32 MiB
old-generation V8 limit. This is **not** a total RSS/native-memory cap. The parent
never performs synchronous diagnostic filesystem I/O. After canonical-root checks,
the worker exclusively creates `diagnostics/sync-stall-capture.jsonl` with `wx`.
An existing artifact prevents arming, overwriting or rearming across replacement
PIDs and is preserved. Valid configuration may admit one shared buffer and worker
before the exclusive open discovers the existing artifact; no replacement is made.
This name is distinct from the protected stop-consumer files. The worker arms
only after its header write succeeds within the original window.

Only one owned write may be pending. The worker starts its independent expiry
check before awaiting output open. Every main marker and heartbeat admission also
checks the original monotonic deadline and UTC expiry, even if watchdog polling
was delayed. Frame cleanup remains bounded, without new post-window ring events.
Expiry/cancel stops new work independently of a blocked main event loop. It does
not guarantee OS open/write/close completion
or force a worker exit. Pending I/O/cleanup retains ownership and reports PENDING;
there is no replacement worker. Late header completion cannot arm an expired or
stopped session. No filesystem operation is claimed clean merely because its
caller reached a logical deadline. Output may be partial after failure: preserve
the original file and state, without rewriting it to look complete.

## Interpretation and coverage

Markers are published before explicit owned sync calls and restored in `finally`.
They preserve receiver, argument evaluation order, return value, exact thrown
objects and immediate Promise-return scope exit. Normal asynchronous waits are
not labelled as synchronous unfinished operations. Shared snapshots use at most
three seqlock attempts; results explicitly include UNKNOWN, INCONSISTENT or
OVERFLOW. The watchdog separately reports its own sampling gap and the main
heartbeat age. A frame identifies an **unfinished instrumented entry site**, not
an actual sampled JavaScript/native stack or proof that its operation caused a
stall. Uninstrumented computation, GC, native work and OS descheduling remain
blind spots. A long-lived `/quant-terminal/` response is not causal evidence.

The frozen catalogue maps numeric IDs to existing timing labels and source-site
families: process-control rename/read/acknowledgement/unlink/receipt write;
manifest poll and metadata stat/exists; shared JSON read/parse and static-file
reads; workflow authentication/session DB reads; Quant alert condition evaluation
and store serialize/write/rename/fallback/cleanup/custom-list sites. Quant files
import no host module. `sync-stall-catalogue.mjs` is the source-controlled map;
unknown labels/IDs record numeric zero, never caller strings. The map hash binds
the artifact to the candidate source for offline interpretation.

## Required packet before any runtime GO

Independent frozen source review and software tests; exact candidate source and
deployment-manifest pins; the reviewed raw operator config and SHA; catalogue SHA;
existing process/source identity evidence; approved fixed artifact location and
30-minute/64-attempt/128-KiB budget; stop/expiry/PENDING interpretation; preservation
of previous incident originals. Root must approve and provision that concrete
packet before any production config, rollout or diagnostic capture. No automatic
rearm or broader availability acceptance follows from the software tests.

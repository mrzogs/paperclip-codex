# Fresh async monitor status

The monitor and public VWAP status GETs, calendar-freshness/open-trades read-only
snapshots, and manifest-freshness poll use this shared reader. Synchronous startup
and monitor start/stop/reconcile semantics remain unchanged. Each accepted read
opens and reads the server-owned status file afresh;
there is no TTL, result cache, or last-good healthy fallback.

The reader uses asynchronous descriptor open/stat/read/close operations, capped at
4 MiB (the existing onboarding file-read ceiling). It has one active I/O task,
at most two queued reads, and a ten-second deadline including queue time, within
the existing twelve-second public companion request budget. Cancellation and
timeout settle the HTTP caller promptly but retain the active slot until actual
I/O completion. New queued requests cannot create unbounded native file work.
Shutdown rejects pending reads; client disconnect cancels its request.
An in-flight OS open/read/close cannot be forcibly interrupted by this helper:
logical cancellation retains its slot until it actually settles. At most one
such native task exists, even after repeated caller timeouts. Shutdown does not
claim that a pending OS operation has finished; its eventual descriptor is closed.

The freshness poll has an in-flight guard and always releases it in `finally`.
Manifest mtime, source-change and existence inputs retain their original order;
the existing rebuild predicate receives the fresh monitor status. No rebuild is
scheduled after shutdown. Unrelated stat/buildManifest/existsSync operations are
unchanged and this correction makes no claim about their latency.

Ordinary missing/unreadable/invalid JSON retains the existing stopped fallback.
JSON values and the managed/external process projection retain their existing
semantics, including null and unexpected projection errors. New size, queue,
deadline and lifecycle errors return explicit HTTP 503. Unexpected errors on the
monitor and public VWAP status routes return a sanitized 500; calendar and
open-trades snapshots retain their existing route-specific 500 error payloads.
No route substitutes a stale healthy status. The process observation is unchanged.
No trading or database authority is granted by this descriptive status.

The existing `workflow.companion.monitor-read` label now measures only bounded
JSON parsing on the HTTP thread. Descriptor I/O is awaited asynchronously; its
wait is reflected in total request latency. Do not compare this parse-only span
with the preceding diagnostic release's combined synchronous exists/read/parse
span as though both measured complete file-I/O latency.

Software verification uses disposable files and process/I/O doubles. The HTTP
fixture executes the actual read-only server route branches and poll without importing or
starting the source server, and proves independent HTTP liveness while monitor
reads remain pending. Production availability still requires independent review
and a bounded actual observation after an authorized immutable release.

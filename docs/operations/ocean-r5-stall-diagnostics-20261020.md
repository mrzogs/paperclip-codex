# Ocean r5 request-timing diagnostic

The r4 trade/approval display repair remains valid, but its 22-minute
responsiveness check failed: PID 36080 survived with seven supervisor probe
failures, including three consecutive failures. A later HTTP 200 or absence of
restart is not stability proof. Ocean Brain correction
`reasoning/reasoning-20261020171946-e7139ec9.md` was directly retrieved under
`ocean-trading-website / software`; it is not a CICD VWAP project receipt.

## Measurement, not a speculative fix

Branch `bugfix/ocean-r5-stall-diagnostics` adds bounded request/loop timing and
named synchronous spans. Logs contain route families, process/request counters,
elapsed times and aggregate call counts only. No query strings, dynamic IDs,
headers, bodies, credentials, SQL, filesystem arguments or response content.
Logging is capped at 120 events per minute; tracking is bounded and logging
errors cannot alter request results. No inspector is needed for these timings.

The measurements distinguish the manifest SQLite child, whole manifest build,
workflow views, per-run learning projection and telemetry qualification. A
separate monitor process cannot directly block the website event loop. Shared
I/O contention and a server-path synchronous child remain candidates, not proved
causes merely because their activity overlaps a timeout.

## Deployment boundaries

Build from the merged diagnostic commit and CAS-check the active deployment
manifest before promotion. Keep the exact prior manifest for rollback. Restart
only Website through the managed controller; do not restart Monitor, Paperclip,
bridges or Sierra. Keep the existing monitor PID and live state coherent: the
diagnostic release's excluded mutable `data` directory may be a validated
junction to the previous release's live `data` directory. Archive the diagnostic
copy first, check both absolute paths are the intended website release paths,
and never delete or rename the prior live target. Do not archive that previous
release while the monitor still owns it. Code/configuration files are never
replaced from an older release.

The file manifest fallback follows the resolved mutable-data publisher too.
Windows file symlinks may require administrator privileges; none are required
or created here. Ordinary/non-aliased deployments retain their existing path.

This diagnostic grants no approval, booking, staging, Replay, Paper, Live or
order authority. Databases, physical binding and Quant Terminal state remain
unchanged. Once a blocking call is measured, replace only that path with a
tested asynchronous/cached equivalent preserving freshness and error semantics,
then perform a fresh undebugged sustained check of the final fix.

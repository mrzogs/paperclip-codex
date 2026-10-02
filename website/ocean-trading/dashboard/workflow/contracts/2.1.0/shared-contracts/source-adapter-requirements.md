# Source adapter requirements

An adapter is a versioned provider binding, not permission to modify the source.
It names the installed source/schema, target release, exact field mappings,
identity/environment rules, permission scope and compatibility evidence.

Required behaviour:

1. Preserve source IDs and meanings. Never turn a legacy trade ID into a
   canonical identity without sufficient evidence.
2. Resolve strategy and execution instance through authenticated registry
   bindings; symbol or display name alone is insufficient.
3. Keep import transport separate from original execution provenance.
4. Preserve Replay, Paper and Live source-specific query/filter behaviour.
5. Map lifecycle failures to execution status and use UNKNOWN financial outcome
   where no closed financial trade exists.
6. Preserve unknown values as null/UNKNOWN and quarantine ambiguity.
7. Return the prior receipt for an identical retry; quarantine conflicting ID
   reuse.
8. Let the destination provider enforce authenticated scope and server-derived
   learner permission.
9. Publish local positive, negative and legacy fixtures plus a hashed provider
   binding. A similar filename is not compatibility evidence.
10. Treat Paper designation as configuration only. Emit Paper-forward evidence
    only after the registry resolves the exact active Paper instance, version,
    source session and observed source state.

The included Telemetry and legacy Brain adapters are declarative. Neither
performs migration or rewrites stored records.

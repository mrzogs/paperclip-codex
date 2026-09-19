# Facts-only qualification v1

This additive Register-Facts reference union breaks a prerequisite cycle. It does
not change Setup-Import, its task map, completion receipts, shared contracts 2.1.0,
or operational approvals. A qualification is never a completed S30.2 result.

The six existing Register-Facts request keys and all 14 proof keys are unchanged.
Each bundles.source/strategy is either the existing three-field task reference or
the qualificationReference in factual-qualification-v1.schema.json. The native
protected operator selects each exact independently supplied owner ZIP hash.
There is no HTTP upload or service self-attestation authority. Hashes establish
integrity against that operator-selected owner receipt, not a new signing system.

For each actual instance, the source owner seals a source qualification and VWAP
seals a strategy qualification. Filename is <qualification_id>.zip. Required root
members: receipt.json, report.md, file-map.json, checksums.sha256. No task_id is
allowed in the qualification receipt. file-map.json has qualification_id and files
with bundle_path/sha256; every artifacts/ member must be mapped and all members
except checksums.sha256 hashed. No duplicate paths, traversal, symlinks or secrets.

artifacts/facts.json is a flat object with exactly the role's field names:

- Source: instance.execution_instance_id, instance.source_installation_id,
  instance.chartbook_id, instance.chart_id, instance.source_study_instance_id,
  instance.telemetry_producer_id, instance.account_alias, instance.capabilities,
  source_observed_at_utc.
- Strategy: instance.strategy_id, instance.version_binding, instance.config_hash,
  strategy_code_hash, profile_hash.

All values must equal the Register-Facts request. Existing proofs point to these
literal keys, e.g. /instance.chart_id. No null, empty or synthetic facts. Each
receipt binds target_execution_instance_id and the two roles must agree. The
source observation time must equal its attestation time. The strategy attestation
must concern the actual loaded code/config/profile at that same exact instance.
artifacts/observation-evidence.json follows the attestation schema and names
checksummed artifacts/observations/ evidence records. Preserve actual observations,
methods and observer identity; fixture records never qualify physical sources.
Date-times use the generated RFC3339 subset: uppercase T/Z, seconds 00-59
(no leap-second literals), explicit Z or numeric offset with hours 00-23 and
minutes 00-59. Optional jsonschema date-time extras are not required: the provider
registers its own strict checker and rejects malformed, naive and future observations.

The source baseline must be S25.1 with SHA256
bc46d3b3824873d86dd4d89abbd91e3b98acb769971de14e156ccc811f9cf657.
The strategy baseline must be S27.2 with SHA256
fed8efa5914deeab4a35308828f078d8ab18001749e16570090aba2b3571235c.
Both existing bundles are independently verified including maps and members.
Later approved source repair evidence can be carried as observations; a baseline
reference alone does not assert that its historical code was actually loaded.
No reference to a future full S30.2 result is required or permitted as baseline.

Register-Facts still creates immutable VERIFIED_FACTS_ONLY, operational_enabled=false
bindings. Read-Facts -IdentityId <execution_instance_id> returns the binding and
hash from protected registered state, not from caller-supplied JSON. It includes
the installation/chartbook/chart/study/producer/account/capability/time and
strategy/version/config/code/profile pins. Capabilities are not an observed run
environment or a compatible live-source handshake; those remain separate run gates.
Brain must invoke the protected readback and compare every pin, not accept a
copied hash alone. No new Ocean HTTP caller is needed for this local operator read.

Qualification PASS means only the specified facts were evidenced by that owner.
It cannot enroll an identity, grant dataset permission, release a run, start Sierra,
enable ingestion or approve trading. A mismatched existing instance remains a
conflict, not an overwrite. Full S30.2 subsequently references these earlier hashes.

Readback routes, finite capacity and the unchanged closed handoff envelope are in
provider-lifecycle-v1.json. Consumer acknowledgement is required before adoption.

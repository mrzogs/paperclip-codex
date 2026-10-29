# VWAP evidence integration

The existing candidate jobs, leases, result artifacts and profit/risk evaluator
remain authoritative. This integration adds authenticated evidence admission
and diagnostic reporting; it grants no Sierra, Replay, Paper or Live action.

## Diagnostic reports

Set `OCEAN_VWAP_IMPROVEMENT_REPORT_CONFIG` in the protected Website startup
environment to an operator-owned absolute JSON file. The shared reader accepts
`ocean-vwap-improvement-report-reader/v1`, the exact registered project/domain/root,
a fixed evidence root, a publication path and SHA256, schema bindings, required
report kinds, freshness and byte limits. Neither HTTP parameters nor report JSON
can select another root or supply a verifier.

For managed Website releases, the optional deployment-manifest field
`vwap_improvement_report_config` owns that location. Pass
`-VwapImprovementReportConfig` to the immutable release builder for its initial
binding; subsequent releases retain the validated active location unless an
operator supplies another. The resolver requires a canonical local, regular,
nonempty JSON file of at most 64 KiB without reparse points or path aliases. It
inspects metadata only; Node validates the contents and evidence scope.

The Website supervisor copies this validated property into its own process/child
environment. Missing bindings clear ambient values and remain unconfigured.
The service manager registers only the Website task against the release's
hash-bound supervisor script, preserving legacy and prior-release stop recovery.
It neither changes user/machine environment settings nor overwrites the dirty
canonical checkout or other components' tasks.

The diagnostic publisher currently supplies four genuine kinds:
`collector_health`, `cohort`, `exit_reconciliation`, `improvement_liveness`.
Missing `discovery_admission` and `learning_rows` remain missing. Integrity-only
publication can display current collection diagnostics, but cannot qualify
Discovery or complete an improvement gate. A later publication and its config
pin must be updated together by the trusted publisher. Old pins and stale or
changed bytes are rejected.

The existing public status URL remains
`GET /api/vwap-improvement-monitor/status`. It preserves legacy fields and adds
whitelisted diagnostics. Cohort chart dates and excluded open trades accompany
cohort counts/net, which need not match all-time account totals. Unknown currency
and missing economics remain unknown.

Raw report downloads use
`GET /api/workflow/vwap-improvement-monitor/reports/:kind?publication_sha256=...`.
They require the existing HUMAN browser session. Automatic local access still
opens the landing page directly. Anonymous and service requests cannot download
the originals; the old public download path is unavailable. Only the exact
single publication-hash query is permitted, without relaxing other workflow
query restrictions. Downloads revalidate the publication and exact original
bytes and use attachment, sandbox, no-store and nosniff headers.

## Discovery and current physical results

Discovery admission verifies the original manifest, source/config identity,
complete signed custody and exact derived learning rows using an independently
pinned policy. A signature on a diagnostic wrapper does not qualify the source.
Synthetic evidence remains software-only. Private admission capabilities do not
survive JSON serialization. Observed rows with incomplete or unknown pre-event
mechanism evidence remain ledger observations, with research eligibility false.

Admission also reruns the authoritative Python Discovery intake asynchronously.
The separate Website-owned descriptor is selected by the paired manifest fields
`vwap_discovery_semantic_config` and `vwap_discovery_semantic_config_sha256`, or
the corresponding supervisor environment values
`OCEAN_VWAP_DISCOVERY_SEMANTIC_CONFIG` and
`OCEAN_VWAP_DISCOVERY_SEMANTIC_CONFIG_SHA256`. The immutable release builder
accepts `-VwapDiscoverySemanticConfig` and
`-VwapDiscoverySemanticConfigSha256` together; both-null clears them. Omission
retains an existing validated pair. The publisher's reader configuration cannot
select admission policy, active source/config identity, interpreter or code.

The descriptor pins the approved interpreter, fixed bootstrap, local module
closure, 21-contract index, W0 package, HMM decoder and independent public-key
policy. A bounded child process invokes the existing intake and report publisher;
Ocean independently rereads its exact output report and learning rows and checks
them against the authenticated originals. Missing, changed, mismatched or
ineligible outputs fail closed. Four diagnostic reports never construct this
adapter or launch Python. A software contract descriptor remains explicitly
unqualified and cannot admit market evidence. No production descriptor or
authority is provisioned by this code change.

The intake-package hash is retained in private admission and monitor state.
Changing it invalidates the unchanged-database shortcut without treating a
repeated semantic report timestamp as new market evidence.

The signed pre-outcome freeze must satisfy
`frozen_at <= authenticated issued_at < outcome_access`. Actor identities,
market/source issuer independence, freshness and all original byte bindings are
checked separately.

The typed physical result envelope is documented in
`vwap-test-result-adapter.md` and `vwap-targeted-brain-client.md`. Backend wiring
uses the trusted third constructor argument for `targetedReplayVerification`
and `targetedBrainClient`; ordinary JSON configuration cannot turn these into
functions. Default Website boot leaves both absent.

Dispatch shares one fixed-root bounded reader across initial source references,
boundary proof and the W6 adapter. Verified internal results retain exact trace
references so the existing evaluator can reread and reauthenticate all four
frozen tests after persistence. Serialized adapter bindings cannot stand in for
this verification. Drawdown uses verified UTC exit order, with native sequence
required for ties; unresolved ordering cannot pass.

The separate targeted Brain sender remains off until the owner verifies the
deployed route/schema/source, policy, exact TRADING scope, full signed bundle
and authenticated transport. The PROJECT development-memory credential cannot
enable this path. Source tests or an offline wire check do not establish
production receiver compatibility or physical qualification.

## Local verification and release

One recognized physical preflight failure,
`OPERATIONAL_TELEMETRY_MODULE_HASH_CONFLICT`, now preserves authenticated
monitoring as `DEGRADED_READ_ONLY`. It does not alter the Replay binding or accept
the installed DLL as qualified. The exact blocker is latched for the process
lifetime; workflow mutations and mutating background workers remain disabled.
Only the explicitly allowed read projections, report downloads and session
lifecycle remain available. Other startup errors retain their fatal behavior.

Website start/wait checks accept this explicit read-only state only for the
exact loaded release, source, manifest and schema. Full operational health
continues to require `READY`. The supervisor can therefore preserve a usable
monitor without reporting that physical execution is ready. An operator must
resolve the original physical binding through its approved route and start a
new process before that workflow can regain mutation authority.

Run the relevant `workflow/vwap-*.test.mjs`, targeted evaluator/continuation tests,
and disposable browser suites. `vwap-targeted-dispatch-integration.test.mjs`
exercises dispatch through stored artifacts into current evaluator verification.
`vwap-improvement-download-auth.test.mjs` exercises the real backend/auth boundary.
Browser suites require the repository's Playwright dependency and a compatible
Chromium installation; record any external test-only dependency loader used.

Before release, also run `npm run test:quant` and
`scripts/ocean-deployment.test.ps1`, then check the rendered Codex browser.
Publish an immutable release from the reviewed committed source after integration
with current `develop`. Compare the active deployment manifest immediately
before switching, coordinate the Website service change, retain its rollback
manifest and preserve all external data/Quant Terminal state and physical
bindings. New startup configuration requires the same controlled restart; this
source document does not activate it.

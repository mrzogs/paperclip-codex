# Targeted evaluation delivery

The separate sender supports `/trading/learning/targeted-candidate-evaluation`
and `ocean-targeted-candidate-evaluation-request/v1`. Its authoritative schema is
`Brady - Optimization/onboarding/contracts/vwap-improvement-v1/targeted-candidate-evaluation-request.schema.json`,
SHA256 `D1CC46A0C0578CBC2CF0C80BCA53A17B64C4CF2CAECD80B372289FC3D53CDBA3`.
The receiver source contract is
`D:\Paperclip-codex\worktrees\brain-vwap-targeted-receiver-20261029\docs\vwap-targeted-receiver-20261029.md`.
Legacy candidate-evaluation v2 remains separate and unchanged.

The sender is OFF by default. No JSON `enabled` property, PROJECT token,
serialized adapter binding or local passing math enables it. The backend's
trusted third constructor argument may supply `targetedReplayVerification` and
`targetedBrainClient`; ordinary configuration cannot create functions.

Every targeted benefit reruns `adaptVwapTestResult` on all four frozen tests.
Project/candidate come from the captured case, and plan/test come from the frozen
captured plan. Source artifact bytes must match their recorded hashes. The
internal persisted result retains exact trace refs and:

```js
targeted_physical_evidence: {
  schema_version: 'ocean-vwap-targeted-physical-evidence/v1',
  protocol_ref, case_evidence_ref, physical_runs
}
```

Missing current authenticated protocol, originals, physical/host/run authority,
actor or window evidence blocks positive conclusions. Raw losing or passing
math can remain an `UNVERIFIED_LOCAL_DIAGNOSTIC`, with no remote call or claim of
physical qualification.

`VwapTargetedBrainClient` requires application-owned dependencies:

- `receiverSourceSha256` and `trustPolicySha256`: owner-pinned exact deployment
  and policy identities, obtained independently of the submitted evidence.
- `verifyCompatibility(expected)`: returns current verified exact route, request
  schema/version/hash, deployed source/policy hashes, project/domain/registered
  root, verified/expiry timestamps, and authenticated TRADING principal with the
  exact single-strategy grant. `authentication.credential_source` must be
  `OCEAN_OPERATIONAL_LEARNING_BRAIN_TOKEN_FILE`.
- `evidenceBundleProvider(context)`: produces bounded immutable raw originals and
  signed receipt envelopes in the authoritative typed request. It must preserve
  original bytes and never manufacture signing keys, custody or runtime facts.
- `verifyEvidenceBundle({request,context})`: independently authenticates the whole
  original/RS256 receipt chain under the pinned owner policy, returning
  `{verified:true,trust_policy_sha256,assessment_sha256,input_sha256}`. The input
  hash is SHA256 of canonical sorted compact UTF-8 request JSON. This dependency
  must verify receiver-equivalent source, actor, expiry, namespace/role, window,
  host/authority/start/terminal and verdict requirements; a JSON flag or generic
  signature-only check does not implement it.
- `transport({route,request,principal_id})`: the authenticated bounded transport.
  It may obtain the existing OperationalLearning credential only after the
  compatibility and local bundle gates. The sender never reads a token itself.

The assessment original uses `vwap-targeted-evaluation-assessment/v1`, all six
receiver bindings, ordered `window_ids`, complete original/terminal hash sets,
`verdict:'PASS'`, and `ocean_assessment` equal to the current existing Ocean
calculator's exact output. Monetary/risk values are not recalculated by this
client. Every request artifact/receipt carries exact UTF-8 bytes and a bare
64-hex SHA256. Per-item content is at most 1 MB, original content totals at most
8 MB, and the complete canonical request is also capped at 8 MB to fit the
receiver's retained response bound.

The evaluator reuses its existing job, lease, request/response/readback columns
and event lineage. It fences the current case/plan/completion before delivery,
persists the exact request before a POST, verifies the receiver's exact new
response schema and immutable content, then repeats the same idempotent request
for matching stored readback. Same-job changed bytes conflict before another
send. A superseding lifecycle blocks delivery. No new queue or historical job
version is introduced.

The code and software HTTP stubs do not establish receiver deployment, owner
policy provisioning, an authenticated live TRADING principal, a production W6
normalizer, complete real signed bundles or physical qualification. Those
remain external prerequisites. Normal ingestion, candidate approval and Paper
or Live authorization remain false.

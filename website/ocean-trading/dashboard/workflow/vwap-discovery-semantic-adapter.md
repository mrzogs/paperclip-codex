# Discovery semantic subprocess contract

`createVwapDiscoverySemanticAdapter({descriptorPath, expectedDescriptorSha256})`
returns a frozen asynchronous callable. Both arguments come from protected
Website startup configuration. Neither a publication nor an HTTP request can
choose them. Construction verifies the descriptor and its pins; invocation
rechecks them before and after the child exits. The four diagnostic reports do
not construct or invoke this adapter.

The callable accepts only:

```js
await adapter({
  pack_ref: {id, path, sha256, byte_length},
  expected: {
    manifest_sha256, run_id, source_sha256, config_sha256,
    learning_rows_sha256,
  },
});
```

References use bare 64-hex SHA256 values and exact byte lengths. Input pack and
published output references have exactly four keys. The pack path is an
absolute regular local file beneath the configured evidence root. Original
artifact paths within the pack retain the authoritative Python relative-path
semantics. The published report retains `verified_originals` entries with
`id`, `role`, `sha256`, `byte_length`; its `original_artifacts` retain those
relative references. `pack_artifact` and `learning_rows_artifact` are absolute
four-field references.

The callable exposes frozen owner bindings as `adapter.admissionBinding`:
`evidence_root`, `trust_policy_file`, `trust_policy_sha256`, `baseline_sha256`,
`config_sha256`. `adapter.intakePackageSha256` identifies the pinned interpreter,
bootstrap, module closure, contract index, W0 artifact and decoder together.
Publisher configuration cannot replace these owner bindings.

The returned object has schema `ocean-vwap-discovery-semantic-result/v1`:

```js
{
  schema_version, verified, qualified, status,
  report_ref: {id, path, sha256, byte_length},
  learning_rows_ref: {id, path, sha256, byte_length},
  manifest_sha256, pack_sha256, learning_rows_sha256,
  intake_package_sha256,
}
```

Production admission requires `verified: true`, `qualified: true` and
`status: 'QUALIFIED_DISCOVERY'`. The downstream proof verifier independently
reads these exact output bytes and compares scope, run, source/config, original
references, opportunity rows and learning records with its authenticated input.
A callback object or serialized result alone cannot grant admission.

## Operator descriptor

The exact descriptor keys are:

```text
schema_version = ocean-vwap-discovery-semantic-config/v1
project = cicd-vwap-pull-back-strategy
domain = trading-strategy
project_root = C:\Users\wayne\OneDrive\Documents\Brady - Optimization
execution_class = AUTHENTICATED_SYSTEM | SOFTWARE_CONTRACT_TEST
python = {path, sha256}
bootstrap_sha256
modules = [{module, relative_path, sha256, byte_length}]
contract_index = {id, path, sha256, byte_length}
w0_package = {id, path, sha256, byte_length}
hmm_decoder = {id, path, sha256, byte_length}
policy = {id, path, sha256, byte_length}
evidence_root, output_root, baseline_sha256, config_sha256
limits = {timeout_ms, stdout_bytes, stderr_bytes, evidence_bytes}
fixture_clock_utc = SOFTWARE_CONTRACT_TEST only
```

The interpreter and HMM decoder paths are fixed approved D: paths in source;
the descriptor must pin their bytes. The bootstrap is the adjacent fixed Python
file, with no configurable bootstrap path. Modules are registered-root
`scripts.NAME` files; the four required authoritative modules are contracts,
proofs, discovery intake and discovery pack builder. Every imported local
`scripts.*` module must be in the pinned closure. The fixed 21-schema index and
each schema's byte reference are rechecked. W0 is an independently pinned
artifact under the registered root; this adapter does not invent a W0 metadata
schema or interpret its bytes as authority. Its current hash joins the package
hash and is rechecked with the other pins.

Descriptor and public-key policy must be outside the evidence root. Output is
a strict descendant of the evidence root. The public policy must bind the same
project/domain/root and the descriptor's evidence class. Production forbids a
clock override. No tokens, private keys, commands, source paths from reports,
Python path injection or service addresses are accepted.

Limits cap timeout at 120 seconds, stdout/stderr at 64 KiB each, individual files
at 32 MiB and aggregate evidence at 128 MiB. The child runs asynchronously with
`shell: false`, hidden, fixed argv `-I -B -S` and a minimal Windows environment.
It bypasses `.pth`/startup hooks, retains verified local source bytes before
import, and executes those bytes through a restricted local-module loader.
The actual intake supplies HMM/native/fee and economic checks. Its public-key
verifier supplies custody authentication. A Windows process job kills decoder
descendants on child termination; the audit hook permits only the fixed decoder
and confines writes to the operator output directory.

## Software evidence and remaining production requirements

The focused test generator creates SYNTHETIC originals and six RSA receipts
using private test keys held only in process memory. The actual authoritative
intake evaluates the originals, and the actual verifier checks all six signed
purposes. `SOFTWARE_CONTRACT_TEST` additionally permits an explicit fixture
clock. It always returns `verified: false`, `qualified: false`,
`SOFTWARE_FIXTURE_VALIDATED`, with inspectable report/learning references.
Changing this descriptor to production while retaining a SYNTHETIC policy is
rejected. The software fixture's W0 pin is explicitly the approved plan document
as a software stand-in, not a production package claim.

Run `node --test workflow/vwap-discovery-semantic-adapter.test.mjs` on the
approved Windows interpreter host. Seven focused tests cover actual intake/RSA
interop, asynchronous yield, valid custody with invalid economics, pin/scope
conflicts, changed originals/signatures, path/code/clock injection, child timeout
and stdout/stderr/evidence budgets. On other hosts the runtime-dependent suite
skips rather than inventing compatibility. An eighth contract test uses a tiny
reader double to prove the remaining aggregate allowance is passed as the
authoritative reader's `max_bytes` before any artifact read, preserves a stricter
caller cap, and rejects exhaustion without calling the reader.

No production descriptor, authenticated market evidence, host approval, service
configuration or runtime action is supplied by these tests. Production remains
dependent on the owner-pinned W0/package/policy configuration and genuine
authenticated source originals. Offline software smoke cannot satisfy those
requirements.

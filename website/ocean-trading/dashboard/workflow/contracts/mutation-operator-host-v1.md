# Trusted Core Mutation Operator Host

This bounded S30.2 owner repair certifies the existing named operator in Windows
PowerShell Core 7.5 or newer. It is source-only, not a production installation.
Use the exact script and contract hashes in its immutable owner receipt.

The previous Core branch forwarded mutation commands to native Windows PowerShell
with an unconditional policy override. The repaired branch remains in the trusted
Core host, preserves JSON timestamp strings throughout the protected operation,
and uses the supported Core ACL API only when creating a new protected root.
The Node issuer, store, request validation and publication sequence are unchanged.

## Invocation After Separate Adoption

Invoke the named trusted executable with `-NoProfile -NonInteractive -File`, the
verified operator path, the action and explicit protected root. Do not add any
execution-policy argument. Verify local executable trust and exact source pins
first. Use only independently verified facts and a separately authorized identity
request for actual Register-Facts or Enroll. No example in this document grants
that operational authority.

Runtime is an internal captured-output action, not a console command for showing
state. Its output contains credentials. Status is the sanitized operator view.
Fixture helpers and qualification fixtures are test tools only, never a supported
production reader, issuer or physical source attestation.

## Evidence Boundaries

All new mutation tests use disposable private owned fixture roots. Positive and
negative HTTP checks reach a real local server and SQLite, but are classified as
ISOLATED_REAL_SOFTWARE, not deployed-site or actual market tests. Existing schema
fixtures contain synthetic qualification shapes; they do not observe Sierra.

The native host has effective Restricted policy here. Full native script execution
is NOT_RUN_POLICY_RESTRICTED. Direct built-in DPAPI encryption/decryption of a
public fixture sentinel demonstrates CurrentUser ciphertext interoperability only;
it is not full native operator coverage, an inline operator or a policy workaround.
The legacy native branches remain unchanged. Genuine human setup is NOT_RUN.

The immutable reader repair and its contract remain preserved. Its reader behavior
is regression-tested here. The new contract supersedes only the statement that
Core mutation forwarding is retained, and only for consumers that adopt this new
version and its pins. No source in the canonical installed tree is changed.

## Adoption and Recovery

Coordinator acknowledgement of the exact contract and source bytes is mandatory.
Actual installation, production registration/enrollment and deployment checks
remain a separate reviewed action. Do not rewrite a sealed receipt to imply they
happened. Installation must preserve a verified paired backup and all intervening
credential/database state; never restore an old protected database as a rollback
shortcut. Stop before an operation if host trust, pins, facts or authority disagree.

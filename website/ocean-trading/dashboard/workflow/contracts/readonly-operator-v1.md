# Protected Read-Only Operator v1

This S30.2 bounded Ocean repair adds a supported PowerShell Core 7.5+ path to the
existing operator. It does not replace the website, authentication, registry or
enrollment contract. Use the adjacent machine contract and its receipt-pinned hash.

## Invocation

```powershell
& 'C:\Users\wayne\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe' -NoProfile -NonInteractive -File 'D:\Paperclip-codex\scripts\ocean-workflow-operator.ps1' -Action Status
```

Read-Facts uses the same command with `-Action Read-Facts -IdentityId` followed by
the independently verified, exact execution-instance ID. It fails closed when
the instance is absent. Never invent an instance just to get a passing readback.

Runtime retains its existing internal captured-output contract. Capture it only
in the authorized process and emit aggregate counts or non-secret findings.
Never print, save or export its environment or credential values. No direct
DPAPI reader, alternate endpoint, password or browser session is needed.

## Read-Only Guarantees

The Core reader preserves ISO date strings, validates root/file ACLs and DPAPI,
rejects reparse files and mismatched database roots, and acquires the existing
operator lock without creating it. It opens an existing SQLite store with
`readOnly: true` and connection-local `query_only=ON`. It does not create a
directory, database, lock, WAL or SHM file, perform schema migrations, start a
write transaction, or change audit/identity/application records.

WAL mode requires existing WAL/SHM sidecars. An offline checkpointed store without
those files fails closed; the read command does not initialize it. Default store
construction and the legacy native Windows PowerShell startup path are unchanged.

Normal SQLite readers can update transient SHM read marks. This is reader
coordination, not a database-record write. Record SHM before/after separately,
including differing offsets in isolated tests. Compare DB/WAL/DPAPI/lock bytes
and logical results independently. Concurrent legitimate service writes must be
reported as observed changes, never hidden or attributed to the reader without
evidence. Do not use `immutable=1` against active WAL or clone protected databases.
See [SQLite WAL format](https://www.sqlite.org/walformat.html) and
[read-only WAL requirements](https://www.sqlite.org/wal.html#read_only_databases).

## Unchanged Mutation Boundary

Bootstrap, maintenance, enrollment, renewal, rotation, revocation, registration,
setup import and transfer are not changed or exercised on protected state.
Core calls for these actions retain the legacy WinPS forwarding behavior. Under
an explicit no-ExecutionPolicy-Bypass restriction, enrollment therefore remains
unverified and requires separate owner repair/authorization. This read-only
repair must not be cited as evidence that enrollment is no-Bypass compatible.

No restart is needed to load the operator child files. The running website is
not restarted or reconfigured. Operational ingestion remains OFF; no human or
strategy approval is granted. This component receipt is not full S30.2 acceptance.

## Verification

`readonly-operator.test.mjs` uses private disposable fixtures, actual DPAPI/ACL
and trusted Core processes without policy flags, plus real SQLite read-only
queries. Fixtures are not operational identities or proof of market activity.
Legacy tests requiring `-ExecutionPolicy Bypass` are not executed under this task.
The default JavaScript lifecycle tests can be run independently using a test-name
filter. Keep actual deployed readback evidence separate from fixture results.

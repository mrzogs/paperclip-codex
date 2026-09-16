# Ocean Website Git Baseline

On 2026-09-16 Wayne approved establishing `develop` from the existing published
`main` commit `69a7243e62e2af3633c0a4fc981402ab0c54d644` and reconciling the
previously untracked Ocean implementation separately from the S23.3 change.

This baseline imports the verified 89-file pre-S23.3 source snapshot and 23
unchanged existing dashboard source dependencies. It does not import the local
main ancestry, unrelated Brain notes, credentials, databases, generated trading
data, operational configuration, logs or other project changes.

Pre-S23.3 snapshot SHA-256:
`45c03553f8d2682b60d380cec01e850837b6f657de7394b514ffd99122954fd2`.
The provenance inventory is in the S23.3 delivery receipt's
`artifacts/evidence/git-repair/baseline-file-inventory.json`.

The installed website remains the existing service on port 3102. This Git
reconciliation does not start a replacement service or provision a fresh host.
Machine-local configuration, protected DPAPI state, SQLite files and the
existing Paperclip/market-data integrations remain external dependencies at
their established locations. They must never be committed as source.

S23.3 is a subsequent, separate feature commit and PR into this baseline's
`develop`. Neither branch promotion nor merging is implied by that receipt.
GitHub Actions must be suppressed for the approved delivery and its prior
setting recorded and restored after publication. Tests run locally against the
exact selected code; no cloud CI pass may be fabricated.

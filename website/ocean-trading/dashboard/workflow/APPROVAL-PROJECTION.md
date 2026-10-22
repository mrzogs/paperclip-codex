# Strategy approval projection

The strategy detail GET rereads each referenced Paperclip approval with
`cache: no-store`. The frontend displays these request results rather than
replacing them with the monitor's last decision snapshot. Refresh repeats the
read, including after a pending-to-approved transition.

Company identity comes from the validated VWAP dispatch configuration. Comparator
decisions must also match the strategy, TEST namespace, contract ID/hash, context
hash, run ID and decision scope. RUN_RELEASE additionally binds its output root.
The reader never borrows dispatch credentials or changes Paperclip authorization.

HTTP 401/403 is `SCOPED_ACCESS_DENIED`; unsuccessful reads are `UNAVAILABLE`.
Successful reads with a different company or binding become `COMPANY_MISMATCH`
or `CONTRACT_MISMATCH`. These states are non-authoritative and cannot request
execution. A verified approved coordinator is a hiring gate, not run authority.

An available program's nonempty `next_action` leads CURRENT ACTION, alongside
the separate comparator RUN_RELEASE gate. Contract corruption still takes
precedence. Source completion does not satisfy physical admission, booking,
post-staging evidence, Stage, Replay START, Paper or Live gates.

Local regression commands, from the dashboard directory:

```powershell
node --test workflow/paperclip-approval-status.test.mjs workflow/onboarding-ui.test.mjs workflow/vwap-physical-comparator-contract.test.mjs workflow/vwap-continuity-projection.test.mjs
```

The browser test uses disposable fixture state and a local Chrome instance.
`OCEAN_PROJECTION_EVIDENCE` optionally saves screenshots of each approval state.
`OCEAN_PROJECTION_BEFORE_UI` optionally identifies the base revision's UI module
for a controlled before screenshot. These are fixture receipts, not evidence of
deployment to the supervised service on port 3102. Deployment requires a reviewed
source commit, immutable release preparation and the separate service promotion gate.

# Ocean website changes

Brain project is `ocean-trading-website`, domain `software`, strategy null.
Use the protected Ocean development identity described in `BRAIN-ONBOARDING.md`
in the registered checkout; never borrow another project's token. Brain is
development memory, not a trading-runtime dependency.

## Preserve the embedded terminal

Read `QUANT-TERMINAL-DEPLOYMENT.md` before changing navigation, server startup,
release packaging, the deployment resolver or the website supervisor.
Quant Terminal must remain in the same Ocean Node listener on port 3102 at
`/quant-terminal/`, with **Quant Terminal** in the primary banner. No second
service or proxy. Keep its user data outside releases via `QT_DATA_DIR`.

Before shipping, run `npm run test:quant` here and
`scripts/ocean-deployment.test.ps1` from the release source. Check the rendered
browser interaction. Do not remove the terminal deployment invariant to make a
release pass. Use the current merged `develop` source, not the dirty legacy
checkout. Do not overwrite concurrent changes; compare the active deployment
manifest hash immediately before promotion. A missing terminal is a failed
release even when Ocean's homepage and workflow health return HTTP 200.

Do not change trading accounts, physical bindings, workflow/ledger databases,
other service components or live order routing as part of website repair.

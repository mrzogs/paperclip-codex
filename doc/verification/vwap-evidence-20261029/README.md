# VWAP evidence UI comparison

Both images use disposable software strategy/session fixtures, not production
trade results or physical qualification.

- `before.jpg`: the tracked workflow UI from deployed base
  `42f31738f43ada06994006424170c1f191461130`, served without source modification.
- `after.jpg`: the reviewed UI from `88b1e4bf112b2424920948cc6ca02535a701f3db`.
  The diagnostic report is explicitly software-only and the improvement gate
  remains stalled/unproved. Cohort dates and open-trade exclusions make the
  displayed counts' scope explicit.

Captured in the Codex in-app browser. The previews use real disposable
WorkflowBackend/OceanAuth sessions, with action APIs disabled. Browser checks
also verified the protected report download, exact byte hash, tamper blocking,
recovery and automatic local access without a login banner.

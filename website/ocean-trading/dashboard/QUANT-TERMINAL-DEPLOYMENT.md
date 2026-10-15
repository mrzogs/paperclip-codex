# Quant Terminal release invariant

Quant Terminal is part of Ocean, not a separate service: the Ocean Node process
on port 3102 mounts `/quant-terminal/`. The main banner label is **Quant Terminal**.
Do not add another port, iframe proxy, listener or scheduled task for this app.

## Regression cause — 15 October 2026

The original integration existed only in the dirty `D:\Paperclip-codex` working
checkout. The supervisor subsequently used immutable Git-based release directories,
which did not contain those uncommitted/untracked files. A healthy Ocean homepage
therefore concealed missing terminal routes. Refreshing the browser could not fix it.

## Required delivery checks

- Include the tracked `quant-terminal/` application and licenses in every release.
- Preserve the server mount, startup/close lifecycle and banner link when merging.
- Run `node --test quant-terminal-integration.test.mjs` in the dashboard directory,
  the terminal's `npm test`, and `scripts/ocean-deployment.test.ps1` before promotion.
- The deployment resolver rejects missing/unhashed terminal assets and missing
  integration. Keep this gate in the operational `scripts/ocean-deployment.ps1`.
- Never edit a running release or copy an old complete `server.mjs`/`app.js` over
  newer workflow changes. Build a new release from the merged commit.
- `scripts/new-ocean-website-release.ps1` builds and validates an immutable release
  from an exact committed revision. It requires the observed active-manifest hash,
  includes all tracked terminal files, and never activates a candidate itself.
- Before switching the deployment pointer, compare its original SHA-256 again.
  Abort if another publisher changed it; rebuild from the newer release instead.
- Restart only the Website component using the service manager. Check the banner,
  terminal HTML/assets and `/quant-terminal/api/health`, not just homepage HTTP 200.

## Durable user state

The supervisor pins `QT_DATA_DIR` to `D:\OceanTradingData\website\quant-terminal`.
Layouts, watchlists, drawings, alerts and paper accounts must never be shipped in
Git or placed under a disposable release. Preserve existing files on migration.
Keep the existing website/workflow databases, physical binding and other services
unchanged. No live trading connection is authorized by this integration.

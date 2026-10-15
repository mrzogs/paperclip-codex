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
User-authored indicators use `QT_CUSTOM_DIR` under that persistent data directory,
not the immutable bundled `custom/` directory. This also prevents ordinary editor
saves from invalidating the release's source hashes. Bundled examples seed only
a newly created external custom directory; existing user files are not overwritten.
Keep the existing website/workflow databases, physical binding and other services
unchanged. No live trading connection is authorized by this integration.

## Delayed futures chart feed

NQ=F, ES=F and GC=F use Yahoo's public delayed futures chart data. Yahoo's
coverage page identifies CME delayed data and ICE Data Services as its provider:
https://help.yahoo.com/kb/finance/article-exchanges-data-delays-sln2310.html
This is not TradingView's feed, a paid real-time API or a production execution
feed. The API returns `marketData.kind=delayed` and `executionEligible=false`;
the chart shows DELAYED / RESEARCH ONLY, the contract name and last provider
trade timestamp. Never silently relabel it as live data or use generic rolling
Yahoo symbols as actual broker execution contract identifiers.

Keep Yahoo requests identified as `QuantTerminal/1.0`, not fabricated browser
headers. The old Chrome header set reproducibly returned HTTP 429 on the long
futures requests while the identified client succeeded. Respect genuine chart
429 cooldowns; an autocomplete 429 must not disable otherwise working candles.
Polling requests use bounded history, delayed panes refresh once per minute,
failed initial loads retry after one minute, and failed updates are visible.
The public endpoint has no availability guarantee: licensed real-time account
access and feed/execution validation remain separate requirements for live money.

Run `test/yahoo.test.js` (included in `npm run test:quant`) and verify actual
NQ/ES/GC candles in the browser after promotion. Preserve user chart state.

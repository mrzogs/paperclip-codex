# Local Release Setup

Paperclip validation and publishing run locally. The repository contains no remote workflow definitions, and maintainers must not dispatch hosted automation for this project.

## One-Time Setup

1. Install Node.js 20+ and pnpm 9+.
2. Configure a Git remote with permission to push release tags.
3. Obtain npm maintainer access for every package listed by `scripts/release-package-manifest.json`.
4. Authenticate locally with `npm login` immediately before publishing.

Never commit npm credentials or store them in repository configuration.

## Before Every Release

```bash
pnpm install --frozen-lockfile
pnpm -r typecheck
pnpm test:run
pnpm build
pnpm test:release-registry
```

Run `pnpm test:release-smoke` when the release changes onboarding, packaging, authentication, browser behavior, or Docker delivery.

## Evidence

Record:

- exact commit SHA
- package version and dist-tag
- local commands and exit results
- browser or Docker smoke result when applicable
- tag and release-entry URLs for stable releases

See [RELEASING.md](RELEASING.md) for the release sequence.

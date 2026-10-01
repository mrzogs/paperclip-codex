# Releasing Paperclip

Maintainer runbook for local-only Paperclip releases. Remote workflow execution is not part of this repository's release process.

## Versioning

Paperclip uses calendar versions that fit semver syntax:

- stable: `YYYY.MDD.P`
- canary: `YYYY.MDD.P-canary.N`

Examples:

- first stable on March 18, 2026: `2026.318.0`
- fourth canary for that line: `2026.318.0-canary.3`

## Required Local Validation

Run these commands from the exact commit being released:

```bash
pnpm install --frozen-lockfile
pnpm -r typecheck
pnpm test:run
pnpm build
```

Run the relevant browser smoke test locally as well:

```bash
PAPERCLIPAI_VERSION=canary ./scripts/docker-onboard-smoke.sh
pnpm test:release-smoke
```

Record the commands, commit SHA, and results in the release evidence.

## Canary

Preview and publish a canary locally:

```bash
./scripts/release.sh canary --dry-run
./scripts/release.sh canary
```

The maintainer must already be authenticated with npm. The release script verifies the published dist-tag and internal package dependencies.

## Stable

1. Select and locally verify the exact source commit.
2. Resolve the target version:

```bash
./scripts/release.sh stable --date "$(date +%F)" --print-version
```

3. Create or update `releases/vYYYY.MDD.P.md` on that source commit.
4. Authenticate locally with npm.
5. Preview and publish:

```bash
./scripts/release.sh stable --dry-run
./scripts/release.sh stable
```

6. Push the stable tag and create the release entry:

```bash
git push public-gh refs/tags/vYYYY.MDD.P
PUBLISH_REMOTE=public-gh ./scripts/create-github-release.sh YYYY.MDD.P
```

Stable releases publish the npm dist-tag `latest`. Canaries use `canary` and do not create release entries.

## Rollback

Rollback moves `latest` to a previous stable without unpublishing versions:

```bash
./scripts/rollback-latest.sh 2026.318.0 --dry-run
./scripts/rollback-latest.sh 2026.318.0
```

Then fix forward with a new stable version.

## Related Files

- [`scripts/release.sh`](../scripts/release.sh)
- [`scripts/release-package-map.mjs`](../scripts/release-package-map.mjs)
- [`scripts/create-github-release.sh`](../scripts/create-github-release.sh)
- [`scripts/rollback-latest.sh`](../scripts/rollback-latest.sh)
- [`doc/PUBLISHING.md`](PUBLISHING.md)
- [`doc/LOCAL-RELEASE-SETUP.md`](LOCAL-RELEASE-SETUP.md)

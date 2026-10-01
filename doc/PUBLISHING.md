# Publishing to npm

Low-level reference for how Paperclip packages are prepared and published to npm.

For the maintainer workflow, use [doc/RELEASING.md](RELEASING.md). This document focuses on packaging internals.

## Current Release Entry Points

Use these scripts:

- [`scripts/release.sh`](../scripts/release.sh) for canary and stable publish flows
- [`scripts/create-github-release.sh`](../scripts/create-github-release.sh) after pushing a stable tag
- [`scripts/rollback-latest.sh`](../scripts/rollback-latest.sh) to repoint `latest`
- [`scripts/build-npm.sh`](../scripts/build-npm.sh) for the CLI packaging build

Paperclip no longer uses release branches or Changesets for publishing.

## Why the CLI needs special packaging

The CLI package, `paperclipai`, imports code from workspace packages such as:

- `@paperclipai/server`
- `@paperclipai/db`
- `@paperclipai/shared`
- adapter packages under `packages/adapters/`

Those workspace references are valid in development but not in a publishable npm package. The release flow rewrites versions temporarily, then builds a publishable CLI bundle.

## `build-npm.sh`

Run:

```bash
./scripts/build-npm.sh
```

This script:

1. runs the forbidden token check unless `--skip-checks` is supplied
2. runs `pnpm -r typecheck`
3. bundles the CLI entrypoint with esbuild into `cli/dist/index.js`
4. verifies the bundled entrypoint with `node --check`
5. rewrites `cli/package.json` into a publishable npm manifest and stores the dev copy as `cli/package.dev.json`
6. copies the repo `README.md` into `cli/README.md` for npm metadata

After the release script exits, the dev manifest and temporary files are restored automatically.

## Package discovery and versioning

Public packages are discovered from:

- `packages/`
- `server/`
- `ui/`
- `cli/`

The version rewrite step now uses [`scripts/release-package-map.mjs`](../scripts/release-package-map.mjs), which:

- finds all public packages
- sorts them topologically by internal dependencies
- rewrites each package version to the target release version
- rewrites internal `workspace:*` dependency references to the exact target version
- updates the CLI's displayed version string

Those rewrites are temporary. The working tree is restored after publish or dry-run.

## `@paperclipai/ui` packaging

The UI package publishes prebuilt static assets, not the source workspace.

The `ui` package uses [`scripts/generate-ui-package-json.mjs`](../scripts/generate-ui-package-json.mjs) during `prepack` to swap in a lean publish manifest that:

- keeps the release-managed `name` and `version`
- publishes only `dist/`
- omits the source-only dependency graph from downstream installs

After packing or publishing, `postpack` restores the development manifest automatically.

### Manual first publish for `@paperclipai/ui`

If you need to publish only the UI package once by hand, use the real package name:

- `@paperclipai/ui`

Recommended flow from the repo root:

```bash
# optional sanity check: this 404s until the first publish exists
npm view @paperclipai/ui version

# make sure the dist payload is fresh
pnpm --filter @paperclipai/ui build

# confirm your local npm auth before the real publish
npm whoami

# safe preview of the exact publish payload
cd ui
pnpm publish --dry-run --no-git-checks --access public

# real publish
pnpm publish --no-git-checks --access public
```

Notes:

- Publish from `ui/`, not the repo root.
- `prepack` automatically rewrites `ui/package.json` to the lean publish manifest, and `postpack` restores the dev manifest after the command finishes.
- If `npm view @paperclipai/ui version` already returns the same version that is in [`ui/package.json`](../ui/package.json), do not republish. Bump the version or use the normal repo-wide release flow in [`scripts/release.sh`](../scripts/release.sh).

If the first real publish returns npm `E404`, check npm-side prerequisites before retrying:

- `npm whoami` must succeed first. An expired or missing npm login will block the publish.
- For an organization-scoped package like `@paperclipai/ui`, the `paperclipai` npm organization must exist and the publisher must be a member with permission to publish to that scope.
- The initial publish must include `--access public` for a public scoped package.
- npm also requires either account 2FA for publishing or a granular token that is allowed to bypass 2FA.

## Version formats

Paperclip uses calendar versions:

- stable: `YYYY.MDD.P`
- canary: `YYYY.MDD.P-canary.N`

Examples:

- stable: `2026.318.0`
- canary: `2026.318.1-canary.2`

## Publish model

### Canary

Canaries publish under the npm dist-tag `canary`.

Example:

- `paperclipai@2026.318.1-canary.2`

This keeps the default install path unchanged while allowing explicit installs with:

```bash
npx paperclipai@canary onboard
```

The release script now verifies two things after a canary publish:

- the `canary` dist-tag resolves to the version that was just published
- every published internal `@paperclipai/*` dependency referenced by that manifest exists on npm

It also treats `latest -> canary` as a failure by default, because npm metadata can otherwise leave the default install path pointing at an unreleased canary dependency graph. Only pass `./scripts/release.sh canary --allow-canary-latest` when that `latest` behavior is explicitly intended.

### Stable

Stable publishes use the npm dist-tag `latest`.

Example:

- `paperclipai@2026.318.0`

Stable publishes do not create a release commit. Instead:

- package versions are rewritten temporarily
- packages are published from the chosen source commit
- git tag `vYYYY.MDD.P` points at that original commit

## Publishing authentication

Publishing is a local maintainer operation. Authenticate immediately before a release with `npm login` or a short-lived credential supplied through the maintainer's local environment. Never commit or store an npm credential in this repository.

See [doc/LOCAL-RELEASE-SETUP.md](LOCAL-RELEASE-SETUP.md) for the local release setup.

## Release enrollment for new public packages

Paperclip does not publish every non-private workspace package.
Release publishing is controlled by [`scripts/release-package-manifest.json`](../scripts/release-package-manifest.json).

When you add a new public package:

1. add it to the manifest and decide whether the release script should publish it immediately
2. if it should publish, bootstrap the package on npm before merge
3. if it should not publish yet, keep `"publishFromCi": false`
4. only enable `"publishFromCi": true` after the package has been bootstrapped and local publish access has been verified

Run `pnpm test:release-registry` locally after changing release-enabled package manifests. That catches a missing first-publish bootstrap before the change reaches `master`.

### One-time bootstrap sequence for a new package

The first publish of a brand-new package needs one human maintainer with npm write access. Later canary and stable publishes use the same local maintainer process.

Example for `@paperclipai/adapter-acpx-local` from the repo root:

```bash
# safe preview
pnpm run release:bootstrap-package -- @paperclipai/adapter-acpx-local

# one-time first publish from an authenticated maintainer machine
pnpm run release:bootstrap-package -- @paperclipai/adapter-acpx-local --publish --otp 123456
```

The helper script:

- checks that the package does not already exist on npm
- builds the target package unless `--skip-build` is passed
- runs `npm pack --dry-run` in the package directory
- only runs the real `npm publish --access public` when `--publish --otp <code>` is provided

For the real `--publish` step, the maintainer machine must already be authenticated to npm.
If `npm whoami` returns `401`, first run `npm logout --registry=https://registry.npmjs.org/` to clear any stale local auth, then run `npm login` or `npm adduser` locally as an npm org member, and finally rerun the helper.
Use local human authentication for the bootstrap and later releases, and never store that credential in the repository.
The helper now requires `--otp <code>` up front for `--publish`, so it fails before the real publish attempt if the one-time password is missing.

After that first publish succeeds:

1. verify the package with `npm view @paperclipai/adapter-acpx-local version`
2. optionally enable `Require two-factor authentication and disallow tokens` in the package's npm publishing settings
3. keep `publishFromCi: true` in [`scripts/release-package-manifest.json`](../scripts/release-package-manifest.json); the field name is retained for manifest compatibility and is honored by the local release scripts

Future canary and stable publishes for that package remain explicit local maintainer operations.

## Rollback model

Rollback does not unpublish anything.

It repoints the `latest` dist-tag to a prior stable version:

```bash
./scripts/rollback-latest.sh 2026.318.0
```

This is the fastest way to restore the default install path if a stable release is bad.

## Related Files

- [`scripts/build-npm.sh`](../scripts/build-npm.sh)
- [`scripts/generate-npm-package-json.mjs`](../scripts/generate-npm-package-json.mjs)
- [`scripts/generate-ui-package-json.mjs`](../scripts/generate-ui-package-json.mjs)
- [`scripts/release-package-map.mjs`](../scripts/release-package-map.mjs)
- [`cli/esbuild.config.mjs`](../cli/esbuild.config.mjs)
- [`doc/RELEASING.md`](RELEASING.md)

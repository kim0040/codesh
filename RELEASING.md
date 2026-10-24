# Releasing codesh

A release is a `vX.Y.Z` tag on `main`. GitHub Actions does the rest; everything it uses (Actions on a
public repository, GHCR public packages, releases, attestations) is free. Operators see the release
in the admin console within about 12 hours and install it with `./update.sh` (docs/OPERATIONS.md §15).

## Version numbers

[Semantic Versioning](https://semver.org/): `X.Y.Z` with

- **patch** (`1.2.3` → `1.2.4`): fixes only. Automatic updates with `--policy patch` install these.
- **minor** (`1.2.4` → `1.3.0`): new features, compatible settings and data. `--policy minor` installs these.
- **major** (`1.3.0` → `2.0.0`): anything an operator must act on: a removed or renamed setting, a data
  migration that cannot be rolled back, a collab protocol change that needs every tab reloaded.
  `update.sh` asks for `--allow-major` and automatic updates never install it. Say what to do in the
  CHANGELOG.
- **pre-release** (`1.3.0-rc.1`): a suffix after a hyphen. Published as a GitHub pre-release; only
  installations with `UPDATE_CHANNEL=prerelease` are told about it, and image tags `X.Y`, `X` and
  `latest` do not move.

## Steps

1. On a branch, set the version in **two** places:
   - `package.json` (root) `"version"`;
   - `deploy/.env.example` `CODESH_VERSION=`.
2. In `CHANGELOG.md`, rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`, add a new empty
   `## [Unreleased]` above it and update the links at the bottom. Write for operators: what changed
   for them, and under a `### Upgrade notes` heading anything they must do. This section becomes the
   release notes, and the admin console shows its first 4000 characters as plain text.
3. Check: `node scripts/release.mjs check vX.Y.Z` and `pnpm check`. CI runs the first one too.
4. Merge to `main` once CI is green, then tag the merge commit and push the tag:
   ```sh
   git switch main && git pull
   git tag -a vX.Y.Z -m "codesh X.Y.Z"
   git push origin vX.Y.Z
   ```
5. Watch the **Release** workflow (about 30-60 minutes, mostly the arm64 builds).

## What the release workflow does

`.github/workflows/release.yml`:

1. **verify**: `scripts/release.mjs check` with the tag; it fails if the tag, `package.json`,
   `deploy/.env.example` and the CHANGELOG section disagree.
2. **images** (api, collab, web, mdns in parallel): build for linux/amd64 and linux/arm64 with
   `CODESH_VERSION=X.Y.Z` (the Dockerfiles refuse a mismatch), push to
   `ghcr.io/kim0040/codesh-<name>` as `X.Y.Z`, `X.Y`, `X` and `latest` (only `X.Y.Z` for a
   pre-release), and attach a build provenance attestation to the image in the registry.
3. **bundles** (amd64 and arm64 runners): `deploy/bundle.sh` with `BUNDLE_SOURCE=registry` pulls the
   pushed images and writes `codesh-X.Y.Z-linux-<arch>.tar.gz` (images included, for hosts without
   internet) and `codesh-deploy-X.Y.Z.tar.gz` (compose file, scripts and the `IMAGES` digest list, for
   `update.sh`), each with a `.sha256`. `bundle.sh` fails when an archive would exceed the 2 GiB
   release asset limit. The archives get provenance attestations too.
4. **release**: `SHA256SUMS` over all archives, then `gh release create vX.Y.Z` with the CHANGELOG
   section plus update instructions as notes, and the archives, their `.sha256` files and
   `SHA256SUMS` as assets. Marked `--latest`, or `--prerelease` for a suffix version.

A failed run publishes no release. Fix the cause and re-run the failed jobs; to rebuild from a
different commit, delete the tag (`git push --delete origin vX.Y.Z`) and the images' new versions in
the package settings, then tag again.

## Verify a release

```sh
gh release view vX.Y.Z --repo kim0040/codesh
gh release download vX.Y.Z --repo kim0040/codesh -p SHA256SUMS -p 'codesh-deploy-*' && sha256sum -c --ignore-missing SHA256SUMS
gh attestation verify codesh-deploy-X.Y.Z.tar.gz --repo kim0040/codesh
gh attestation verify oci://ghcr.io/kim0040/codesh-api:X.Y.Z --repo kim0040/codesh
docker buildx imagetools inspect ghcr.io/kim0040/codesh-api:X.Y.Z    # linux/amd64 and linux/arm64
```

Then on a test installation: `./update.sh --check` lists the new version, `./update.sh --yes`
updates, and the admin console shows "Up to date".

## First release (1.0.0)

The repository is public and the version is already 1.0.0 with a dated CHANGELOG section.

1. Push `main` and wait for CI.
2. Repository **Settings → Actions → General**: leave "Workflow permissions" at read-only. Each job
   asks for exactly what it needs in its `permissions:` block (`packages: write` for the images,
   `contents: write` only for the release job), and that works with the read-only default.
3. `git tag -a v1.0.0 -m "codesh 1.0.0" && git push origin v1.0.0`.
4. The bundles job pulls the new images with the workflow token, so it works while the packages are
   still private. After the run, make each package public once: **github.com/kim0040?tab=packages** →
   `codesh-api`, `codesh-collab`, `codesh-web`, `codesh-mdns` → **Package settings → Change
   visibility → Public**, and under **Manage Actions access** check that `kim0040/codesh` has write
   access. New versions of a public package stay public.
5. Check anonymously that images can be pulled: `docker logout ghcr.io && docker pull ghcr.io/kim0040/codesh-api:1.0.0`.
6. Optionally link each package to the repository (Package settings → Connect repository) so it shows
   on the repository page. The `org.opencontainers.image.source` label usually does this already.

## Dependency updates

Dependabot opens grouped pull requests every Monday for npm, Dockerfiles, `deploy/docker-compose.yml`
and the workflow actions. Actions are pinned by commit SHA with the version in a comment; Dependabot
keeps both. `pnpm check` runs the licence allowlist (docs/ARCHITECTURE.md §13): a pull request that
brings in a new licence fails CI and must not be merged. Keep exact versions.

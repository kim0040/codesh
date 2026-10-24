# Contributing to codesh

Thank you for helping. Bug reports, fixes and improvements are welcome; for a larger change please
open an issue first so we can agree on the direction.

## Set up

Follow the **Development** section of the [README](README.md): Node.js 22 or newer, pnpm 9.15 and
Docker, then `pnpm install`, `pnpm services:up` and `pnpm dev`. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
describes the packages and the data model.

## Before you open a pull request

- Run `pnpm check` (Biome, TypeScript, Vitest and the licence check). It must pass.
- Add or update tests for what you change. Browser behaviour is covered by the Playwright specs in
  `apps/web/e2e`.
- Keep the diff small and in the style of the code around it; TypeScript is strict everywhere.
- Do not add anything that makes a request to another host at runtime: no CDN scripts, web fonts,
  analytics or third-party widgets. Fonts and assets are self-hosted.
- New dependencies need a licence on the allowlist (`pnpm check` enforces it, see
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §13). Keep exact versions.
- User-facing text exists in Korean and English (`packages/i18n`); update both.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/), as in the history:
`feat(web): …`, `fix(collab): …`, `perf: …`, `deploy: …`, `docs: …`, `test: …`, `ci: …`, `chore: …`. One logical change per commit,
with the reason in the body when it is not obvious.

## Licence

codesh is released under the [MIT License](LICENSE). By contributing you agree that your
contribution is licensed under the same terms (inbound = outbound).

Security problems go through [SECURITY.md](SECURITY.md), not through issues.

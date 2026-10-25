# Contributing to gachipad

Thank you for helping. Bug reports, documentation updates, and improvements are welcome; for a
larger change, please open an issue first so we can agree on the direction.

## Set up

Follow the **Development** section of the [README](README.md): Node.js 22 or newer, pnpm 9.15, and
Docker, then run:

```sh
pnpm install
pnpm services:up
pnpm dev
```

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) describes the monorepo packages and data models.

## Before you open a pull request

- Run `pnpm check` (Biome, TypeScript, Vitest, and the licence check). It must pass.
- Add or update automated tests for your changes. Browser workflows are covered by Playwright specs in
  `apps/web/e2e`.
- Keep the diff focused and in the style of surrounding code; TypeScript strict mode is enabled everywhere.
- Do not add anything that makes an outbound request at runtime: no CDN scripts, web fonts, analytics,
  or third-party widgets. Fonts and assets are self-hosted.
- New dependencies must have a licence on the allowlist (`pnpm check` enforces it; see
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §13). Always pin exact versions.
- User-facing copy exists in Korean and English (`packages/i18n`); update both locales.

## Commits

Follow [Conventional Commits](https://www.conventionalcommits.org/), as used throughout the git history:
`feat(web): …`, `fix(collab): …`, `perf: …`, `deploy: …`, `docs: …`, `test: …`, `ci: …`, `chore: …`.
Keep one logical change per commit, and explain the motivation in the commit body when not obvious.

## Licence

gachipad is released under the [MIT License](LICENSE). By contributing, you agree that your
contribution is licensed under the same terms (inbound = outbound).

Security problems go through [SECURITY.md](SECURITY.md), not through public issues.

# Security policy

## Supported versions

Security fixes go into the latest minor release (for example 1.0.x while 1.0 is the newest). Older
releases are not patched: update with `./update.sh` (see [RELEASING.md](RELEASING.md) and
[docs/OPERATIONS.md](docs/OPERATIONS.md) §15).

## Reporting a vulnerability

Please report it privately through
[GitHub Security Advisories](https://github.com/kim0040/codesh/security/advisories/new). Do not open a
public issue or pull request for a vulnerability.

Please include:

- the codesh version (the admin console and `GET /api/version` show it) and how it is deployed;
- what you found and what an attacker gains (read or change someone's code, bypass a PIN or the
  waiting room, see deleted text, run script in another user's browser, and so on);
- steps to reproduce, or a small proof of concept;
- anything you already know about a fix.

You will get an answer as soon as the maintainer can read the report, and a fix or a decision
afterwards. Reports are handled by one person in their own time, so there is no fixed response time.
Once a fix is released the advisory is published, and you are credited unless you prefer not to be.

There is no bug bounty.

## Scope

In scope: this repository and the images and bundles built from it (`ghcr.io/kim0040/codesh-*`,
release archives). Out of scope: issues in third-party software that codesh only runs unmodified
(MongoDB, Valkey, Caddy, Node.js; report those upstream), and findings that need an already
compromised server or administrator token.

# Security policy

## Supported versions

Security fixes go into the latest minor release stream (for example 1.0.x while 1.0 is the newest).
Older releases are not patched: update with `./update.sh` (see [RELEASING.md](RELEASING.md) and
[docs/OPERATIONS.md](docs/OPERATIONS.md) §15).

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/kim0040/codesh/security/advisories/new). Do not open a
public issue or pull request for a vulnerability.

Please include:

- The codesh version (shown in the admin console and `GET /api/version`) and how it is deployed;
- What you found and what an attacker gains (e.g. read or modify another participant's code, bypass a
  PIN or the waiting room, see deleted text, or execute scripts in another user's browser);
- Steps to reproduce, or a minimal proof of concept;
- Any details you already know regarding a potential fix.

You will receive an initial answer as soon as the maintainer can review the report, followed by a fix
or remediation decision. Reports are handled by one maintainer in personal time, so there is no fixed
response window. Once a fix is released, the advisory is published and you will be credited unless you
prefer not to be.

There is no bug bounty program.

## Scope

- **In scope**: This repository and the images and bundles built from it (`ghcr.io/kim0040/codesh-*`,
  release archives).
- **Out of scope**: Vulnerabilities in upstream third-party software that codesh runs unmodified
  (MongoDB, Valkey, Caddy, Node.js; please report those upstream), and findings requiring an already
  compromised server or administrator token.

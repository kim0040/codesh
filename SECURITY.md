# Security policy

## Supported versions

Security fixes go into the latest minor release stream (for example 1.0.x while 1.0 is the newest).
Older releases are not patched: update with `./update.sh` (see [RELEASING.md](RELEASING.md) and
[docs/OPERATIONS.md](docs/OPERATIONS.md) §15).

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/kim0040/gachipad/security/advisories/new). Do not open a
public issue or pull request for a vulnerability.

Please include:

- The gachipad version (shown in the admin console and `GET /api/version`) and how it is deployed;
- What you found and what an attacker gains (e.g. read or modify another participant's code, bypass a
  PIN or the waiting room, see deleted text, or execute scripts in another user's browser);
- Steps to reproduce, or a minimal proof of concept;
- Any details you already know regarding a potential fix.

You will receive an initial answer as soon as the maintainer can review the report, followed by a fix
or remediation decision. Reports are handled by one maintainer in personal time, so there is no fixed
response window. Once a fix is released, the advisory is published and you will be credited unless you
prefer not to be.

There is no bug bounty program.

## Public network threat model and residual risks

Public network deployments (`GACHIPAD_NETWORK=public`) harden internet exposure by enforcing HTTPS and HSTS, restricting administrative endpoints to loopback and private CIDRs by default, isolating client discovery groups to prevent implicit LAN or shared-NAT leaks, disabling mDNS, applying strict per-client and per-IP rate limits, and throttling distributed 6-digit join-code scanning using a fleet-wide Valkey failure budget (300 failures/min). Residual risks remain that operators must evaluate: 6-digit join codes are an entry convenience rather than an authentication secret, and distributed scan attacks can exhaust the shared failure budget to temporarily pause code lookups (returning HTTP 429), while direct share URLs (`/<id>`), established sessions, and normal API operations remain accessible (protect sensitive shares using PINs, waiting-room approval, or sign-in). Furthermore, guest document creation is permitted by default; per-IP creation quotas and upload caps reduce automated churn but do not provide an absolute fleet-wide ceiling on database and document growth across distributed botnets (operators of closed sites should set `guestAllowed=false` in the admin console and configure OIDC or LDAP). Application rate limits cannot protect against link saturation or volumetric network DDoS, and Valkey restarts reset ephemeral per-address held-upload reservations while the persistent global storage ceiling continues to apply.

## Scope

- **In scope**: This repository and the images and bundles built from it (`ghcr.io/kim0040/gachipad-*`,
  release archives).
- **Out of scope**: Vulnerabilities in upstream third-party software that gachipad runs unmodified
  (MongoDB, Valkey, Caddy, Node.js; please report those upstream), and findings requiring an already
  compromised server or administrator token.

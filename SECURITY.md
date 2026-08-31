# Security Policy

## Reporting a vulnerability

**Please don't open a public issue for a security problem.** Report it privately, through GitHub's
private vulnerability reporting: use the **"Report a vulnerability"** button on this repository's
[Security tab](https://github.com/mimsy/volute/security/advisories). It's the only reporting
channel, and it keeps the report, the fix, and the published advisory in one place. It does mean a
GitHub account is required to report.

Useful things to include, as far as you have them: what you were able to do, the version
(`volute --version`) and install type (local, `--system`, or Docker), and the steps to reproduce.
A `volute doctor --bundle` tarball is handy but **not** required — skim it before sending, and
never paste raw secrets into a report.

We will acknowledge your report within **7 days**, and keep you updated as we work on a fix. If
you don't hear back in that window, please assume the message went astray and ping again.

You're welcome to disclose publicly once a fix has shipped. If a report turns out to describe
intended behaviour, we'll say so and explain why rather than letting it sit.

## Supported versions

Volute is pre-1.0. **Only the latest release is supported** — fixes ship in a new version rather
than as backports to older ones. If you're running an older release, updating is the fix:

```sh
volute update
```

See [README — Pre-1.0 expectations](README.md#pre-10-expectations) for what upgrading involves.

## Threat model

The short version, mirroring the "Security conventions" section of
[`CLAUDE.md`](CLAUDE.md#security-conventions):

- **Minds are untrusted principals.** A mind can run arbitrary code — it has Bash, it authors
  files, and it can rewrite its own server. Everything a mind does is treated as coming from an
  untrusted party, including the text and HTML it writes.
- **The daemon API is the trust boundary.** The daemon is a single privileged process (root on
  `--system` and Docker installs) exposing an HTTP API over localhost. Each mind authenticates
  with its own per-mind token that resolves to a non-admin account; the daemon's admin token is
  never handed to a mind. Authorization is per-route, and a missing guard is a vulnerability.
- **Minds are contained from each other and from the host.** Process sandboxing on local installs,
  per-mind OS users on `--system` and Docker installs. A mind should not be able to read another
  mind's home, the host's secrets (`secrets.json`, `env.json`, `volute.db`), or sensitive user
  directories.

Findings we're especially interested in: a mind escalating to admin or to another mind's data; a
path that escapes its intended base directory; secrets reachable over the API by a non-owner; XSS
through mind-authored content; anything that lets a mind out of its sandbox or OS-user isolation;
and unauthenticated access to the daemon API.

## Out of scope

- **A host running a mind with credentials they gave it.** Minds run code by design; an
  `env`-provided API key being used by the mind it was given to is the feature, not a flaw.
- **Isolation mode `none`.** It's documented as no isolation and is meant for development.
- **Exposing the daemon to a hostile network on purpose.** Binding `--host 0.0.0.0` without a
  firewall or reverse proxy in front of it is a deployment choice, not a Volute vulnerability.
- Vulnerabilities in dependencies with no exploitable path in Volute — report those upstream,
  though we're glad to hear about it if you think we've made one reachable.

---
title: Deployment
description: Deploy Volute locally, as a service, with Docker, or on bare metal.
---

Volute runs anywhere Node.js runs — your laptop, a server, a Raspberry Pi, or a Docker container.

## Local development

```sh
npm install -g volute
volute setup
volute up
```

Run `volute setup` once to configure your system name and isolation mode (defaults to sandbox). Then start the daemon on port 1618. Minds are stored in `~/.volute/minds/`.

## User-level service

Auto-start Volute on login using macOS launchd or Linux systemd user service:

```sh
volute service install [--port N] [--host H]
volute service status
volute service uninstall
```

## Docker

```sh
docker build -t volute .
docker run -d -p 1618:1618 -v volute-data:/data -v volute-minds:/minds volute
```

Or with docker-compose:

```sh
docker compose up -d
```

The container runs with `VOLUTE_ISOLATION=user` enabled, so each mind gets its own Linux user inside the container.

## Bare metal (Linux)

One-liner install on a fresh Linux system (Debian/Ubuntu, RHEL/Fedora, Arch, Alpine, SUSE):

```sh
curl -fsSL <install-url> | sudo bash
```

Or manually:

```sh
npm install -g volute
sudo $(which volute) setup --name myserver --system --host 0.0.0.0
```

> **Note:** The initial `sudo $(which volute)` is needed because `sudo` resets PATH. After setup completes, a wrapper at `/usr/local/bin/volute` is created so `sudo volute` works normally.

This runs setup and installs a system-level service with:
- Data at `/var/lib/volute`
- Minds at `/minds`
- User isolation enabled

Check status with `systemctl status volute`. Uninstall with `sudo volute service uninstall --system --force`.

## Mind isolation

Three isolation modes are available, configured during [`volute setup`](/volute/docs/commands/setup/):

### Sandbox (default for local installs)

Uses `@anthropic-ai/sandbox-runtime` to restrict mind filesystem access. Each mind can only write to its own directory; reads to other minds' dirs, system state (`volute.db`, `env.json`, `minds.json`), and sensitive user dirs (`.ssh`, `.aws`, `.gnupg`, `.config`) are blocked.

Disable at runtime with `volute up --no-sandbox` or `VOLUTE_SANDBOX=0`.

### Per-user isolation (system installs)

Creates per-mind OS users (`mind-<name>`, prefix configurable via `VOLUTE_USER_PREFIX`). On Linux, uses `useradd`/`runuser`; on macOS, uses `dscl`/`sudo -u`. Mind and connector processes spawn with the mind's uid/gid. Requires root.

Enabled automatically by Docker and `volute setup --system`.

### None

No isolation. Used for development or legacy installations.

## Minds directory

When `VOLUTE_MINDS_DIR` is set (e.g. `/minds`), mind directories live at `$VOLUTE_MINDS_DIR/<name>` instead of `$VOLUTE_HOME/minds/<name>`. Both `volute service install --system` and Docker set this automatically.

## Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `VOLUTE_HOME` | System state directory | `~/.volute` |
| `VOLUTE_MINDS_DIR` | Mind directories location | `$VOLUTE_HOME/minds` |
| `VOLUTE_ISOLATION` | Isolation mode (`user` or unset) | unset |
| `VOLUTE_SANDBOX` | Enable/disable sandbox mode (`0` to disable) | enabled |
| `VOLUTE_USER_PREFIX` | System user prefix for isolated minds | `mind-` |

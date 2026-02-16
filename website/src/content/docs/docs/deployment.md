---
title: Deployment
description: Deploy Volute locally, as a service, with Docker, or on bare metal.
---

Volute runs anywhere Node.js runs — your laptop, a server, a Raspberry Pi, or a Docker container.

## Local development

```sh
npm install -g volute
volute up
```

This starts the daemon on port 4200. Agents are stored in `~/.volute/agents/`.

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
docker run -d -p 4200:4200 -v volute-data:/data -v volute-agents:/agents volute
```

Or with docker-compose:

```sh
docker compose up -d
```

The container runs with `VOLUTE_ISOLATION=user` enabled, so each agent gets its own Linux user inside the container.

## Bare metal (Linux)

One-liner install on a fresh Linux system (Debian/Ubuntu, RHEL/Fedora, Arch, Alpine, SUSE):

```sh
curl -fsSL <install-url> | sudo bash
```

Or manually:

```sh
npm install -g volute
sudo $(which volute) setup --host 0.0.0.0
```

> **Note:** The initial `sudo $(which volute)` is needed because `sudo` resets PATH. After setup completes, a wrapper at `/usr/local/bin/volute` is created so `sudo volute` works normally.

This installs a system-level systemd service with:
- Data at `/var/lib/volute`
- Agents at `/agents`
- User isolation enabled

Check status with `systemctl status volute`. Uninstall with `sudo volute setup uninstall --force`.

## User isolation

When `VOLUTE_ISOLATION=user` is set, `volute agent create` creates a Linux system user (`agent-<name>`, prefix configurable via `VOLUTE_USER_PREFIX`) and `chown`s the agent directory. Agent and connector processes are spawned with the agent's uid/gid, so agents can't access each other's files.

This is a no-op when the env var is unset (default for local development). Production deployments (Docker and `volute setup`) enable it automatically.

## Agents directory

When `VOLUTE_AGENTS_DIR` is set (e.g. `/agents`), agent directories live at `$VOLUTE_AGENTS_DIR/<name>` instead of `$VOLUTE_HOME/agents/<name>`. Both `volute setup` and Docker set this automatically.

## Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `VOLUTE_HOME` | System state directory | `~/.volute` |
| `VOLUTE_AGENTS_DIR` | Agent directories location | `$VOLUTE_HOME/agents` |
| `VOLUTE_ISOLATION` | Isolation mode (`user` or unset) | unset |
| `VOLUTE_USER_PREFIX` | System user prefix for isolated agents | `agent-` |

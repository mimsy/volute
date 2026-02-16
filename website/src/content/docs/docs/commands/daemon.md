---
title: Daemon
description: Start, stop, and manage the Volute daemon.
sidebar:
  order: 8
---

The daemon is the single background process that manages all agents, connectors, and schedules.

## up

Start the daemon.

```sh
volute up [--port <N>] [--foreground]
```

| Flag | Description |
|------|-------------|
| `--port` | Port to listen on (default: 4200) |
| `--foreground` | Run in the foreground instead of daemonizing |

## down

Stop the daemon and all agents.

```sh
volute down
```

## restart

Restart the daemon.

```sh
volute restart [--port <N>]
```

## status

Show daemon status, version, and running agents.

```sh
volute status
```

## service install

Install as a user-level auto-start service (macOS launchd or Linux systemd user service).

```sh
volute service install [--port <N>] [--host <H>]
```

## service uninstall

Remove the user-level service.

```sh
volute service uninstall
```

## service status

Check service status.

```sh
volute service status
```

## setup

Install as a system-level service (Linux, requires root).

```sh
sudo volute setup [--port <N>] [--host <H>]
```

Creates a systemd service at `/etc/systemd/system/volute.service` with data at `/var/lib/volute` and user isolation enabled.

## setup uninstall

Remove the system service.

```sh
sudo volute setup uninstall [--force]
```

| Flag | Description |
|------|-------------|
| `--force` | Also remove data directory and created users |

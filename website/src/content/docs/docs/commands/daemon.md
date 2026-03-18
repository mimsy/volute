---
title: Daemon
description: Start, stop, and manage the Volute daemon.
sidebar:
  order: 8
---

The daemon is the single background process that manages all minds, bridges, and schedules.

## up

Start the daemon.

```sh
volute up [--port <N>] [--foreground] [--no-sandbox] [--tailscale]
```

| Flag | Description |
|------|-------------|
| `--port` | Port to listen on (default: 1618) |
| `--foreground` | Run in the foreground instead of daemonizing |
| `--no-sandbox` | Disable sandbox isolation for this session (also `VOLUTE_SANDBOX=0`) |
| `--tailscale` | Enable Tailscale HTTPS with automatic TLS certificates |

## down

Stop the daemon and all minds.

```sh
volute down
```

## restart

Restart the daemon.

```sh
volute restart [--port <N>]
```

## status

Show daemon status, version, and running minds.

```sh
volute status
```

## service status

Check service status.

```sh
volute service status
```

:::note
Service installation and uninstallation are handled by `volute setup`. See [setup](/volute/docs/commands/setup/) for details.
:::

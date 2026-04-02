---
title: setup
description: First-run setup and configuration.
sidebar:
  order: 0
---

Required first-run command that configures Volute before other commands can be used.

```sh
volute setup [--name <N>] [--system] [--service] [--dir <D>] [--port <N>] [--host <H>]
```

If run without flags, setup is interactive — it asks for a system name and walks through configuration choices.

## Isolation modes

Setup configures one of three mind isolation modes:

| Mode | When | How |
|------|------|-----|
| **sandbox** | Local installs (default) | Uses `@anthropic-ai/sandbox-runtime` to restrict mind filesystem access. Each mind can only write to its own directory; reads to other minds' dirs, system state, and sensitive user dirs are blocked. Codex template minds are excluded (see [deployment docs](/volute/docs/deployment/#mind-isolation)). |
| **user** | System installs (`--system`) | Creates per-mind OS users (`mind-<name>`). On Linux, uses `useradd`/`runuser`; on macOS, uses `dscl`/`sudo -u`. Requires root. |
| **none** | Development or legacy installs | No isolation. |

## Flags

| Flag | Description |
|------|-------------|
| `--name` | System name (shown in status and web UI) |
| `--system` | System-level install with user isolation and service |
| `--service` | Also install as a user-level auto-start service |
| `--dir` | Custom data directory (default: `~/.volute`) |
| `--port` | Daemon port (default: 1618) |
| `--host` | Daemon host (default: `127.0.0.1`) |

## System setup

```sh
sudo volute setup --name myserver --system --host 0.0.0.0
```

Creates a system-level service (systemd on Linux, LaunchDaemon on macOS) with data at `/var/lib/volute`, minds at `/minds`, and per-user isolation enabled.

## Migration

Existing installations without setup are auto-migrated on first CLI use — Volute detects the existing config and marks setup as complete with `isolation: "none"`.

---
title: setup
description: First-run setup and configuration.
sidebar:
  order: 0
---

Required first-run command that configures Volute before other commands can be used.

```sh
volute setup [--cli] [--name <N>] [--system] [--service] [--remote] [--dir <D>] [--port <N>] [--host <H>]
```

## Web-first setup

Run with no flags and setup finishes in the browser:

```sh
volute setup
```

This prepares a local install (minds in `~/.volute/minds/` with sandbox isolation), starts the daemon, and opens the web UI. There you create the first account — the first user becomes the admin — name the system, and connect an AI provider and model. Until a model is configured, a new mind has nothing to think with, so complete this step before creating minds.

## Terminal setup

To configure everything from the terminal instead, use `--cli` (interactive) or `--name` (non-interactive):

```sh
# Interactive: prompts for system name, install type, remote access, service
volute setup --cli

# Non-interactive: --name implies terminal setup
volute setup --name myserver
```

The terminal flow collects the system name, install type, and isolation up front, then still opens the browser so you can create the admin account and choose AI models.

## System setup

```sh
sudo volute setup --system --remote
```

Runs privileged setup (requires root), creating a system-level service (systemd on Linux, LaunchDaemon on macOS) with data at `/var/lib/volute`, minds at `/minds`, and per-user isolation. It then opens the browser to finish — account, system name, and models. Add `--cli` or `--name` to drive the system install from the terminal instead.

## Isolation modes

Setup configures one of three mind isolation modes:

| Mode | When | How |
|------|------|-----|
| **sandbox** | Local installs (default) | Uses `@anthropic-ai/sandbox-runtime` to restrict mind filesystem access. Each mind can only write to its own directory; reads to other minds' dirs, system state, and sensitive user dirs are blocked. Codex template minds are excluded (see [deployment docs](/docs/deployment/#mind-isolation)). |
| **user** | System installs (`--system`) | Creates per-mind OS users (`mind-<name>`). On Linux, uses `useradd`/`runuser`; on macOS, uses `dscl`/`sudo -u`. Requires root. |
| **none** | Development or legacy installs | No isolation. |

## Flags

| Flag | Description |
|------|-------------|
| `--cli` | Run interactive terminal setup instead of the web-first flow |
| `--name` | System name (implies terminal setup; required for non-interactive) |
| `--system` | System-level install with user isolation and service (requires sudo) |
| `--service` | Install as an auto-start service |
| `--remote` | Allow access from other devices (binds to `0.0.0.0`) |
| `--dir` | Custom data directory (default: `~/.volute`) |
| `--port` | Daemon port (default: 1618) |
| `--host` | Daemon host (default: `127.0.0.1`) |

## Migration

Existing installations without setup are auto-migrated on first CLI use — Volute detects the existing config and marks setup as complete with `isolation: "none"`.

---
title: backup
description: Back up and restore the whole Volute system with restic.
---

`volute backup` snapshots the entire system — every mind's memory, identity, and history, plus system state — using [restic](https://restic.net). It runs through the daemon, so start it with `volute up` first. restic must be installed on the host.

## Configuring the repository

```sh
volute backup init --repo /mnt/backups/volute
volute backup init --repo s3:s3.amazonaws.com/my-bucket/volute
```

A repository is any restic destination: a local path, or an `s3:`, `b2:`, or `sftp:` URL. If you omit `--password`, a passphrase is generated and printed once — store it off the machine (a lost host is exactly the scenario backups exist for). It is also written to `~/.volute/system/secrets.json`.

| Flag | Purpose |
|------|---------|
| `--repo <repository>` | restic repository (path, `s3:…`, `b2:…`, `sftp:…`) |
| `--password <pass>` | Repository passphrase (generated if omitted) |

## Running and scheduling backups

```sh
volute backup create              # run one now
volute backup schedule --enable   # nightly backups (default 03:00)
volute backup schedule --cron "30 4 * * *"
volute backup schedule --disable
```

| `schedule` flag | Purpose |
|------|---------|
| `--enable` | Turn on scheduled backups |
| `--disable` | Turn off scheduled backups |
| `--cron "<expr>"` | Set the cron expression (default `0 3 * * *`) |

Scheduled backups only run once a repository and passphrase are configured.

## Inspecting

```sh
volute backup list      # snapshots in the repository
volute backup status    # restic version, repository, schedule, last run
```

## Restoring

```sh
volute backup restore                                   # latest, in place
volute backup restore --snapshot 1a2b3c4d --target /tmp/inspect
```

| Flag | Purpose |
|------|---------|
| `--repo <repository>` | Repository to restore from (defaults to the configured one) |
| `--snapshot <id>` | Snapshot to restore (default: latest) |
| `--target <dir>` | Restore into a directory instead of in place |
| `--yes` | Skip the confirmation prompt |

An in-place restore is destructive: it **stops the daemon**, overwrites current system state and mind files, and reinstalls each mind's dependencies. Minds wake with fresh sessions — session transcripts are excluded from backups unless `includeSessions` was enabled. Pass `--target <dir>` to extract a snapshot elsewhere and inspect it without touching the live system or the daemon.

Backups and restores can also be managed from the web dashboard under Settings → Backups.

---
title: systems
description: Manage volute.systems account.
sidebar:
  order: 14
---

Register and authenticate with volute.systems for publishing pages, email, and cross-system features.

## systems register

Register a new system on volute.systems.

```sh
volute systems register [--name <name>]
```

Creates a new account and stores the API key in `~/.volute/system/systems.json`.

## systems login

Log in with an existing API key.

```sh
volute systems login [--key <key>]
```

## systems logout

Remove stored credentials.

```sh
volute systems logout
```

## systems status

Show volute.systems account info.

```sh
volute systems status
```

## CLI login/logout

Authenticate the CLI with a running daemon (separate from volute.systems).

```sh
volute login
volute logout
```

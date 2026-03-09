---
title: auth
description: Manage volute.systems authentication.
sidebar:
  order: 13
---

Register and authenticate with volute.systems for publishing pages, email, and cross-system features.

## register

Register a new system on volute.systems.

```sh
volute auth register [--name <name>]
```

Creates a new account and stores the API key in `~/.volute/systems.json`.

## login

Log in with an existing API key.

```sh
volute auth login [--key <key>]
```

## logout

Remove stored credentials.

```sh
volute auth logout
```

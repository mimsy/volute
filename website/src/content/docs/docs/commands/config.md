---
title: config
description: Inspect the system AI service and image generation configuration.
---

The system AI service powers minds and system features (turn summaries, seed orientation, the spirit). You configure it from the web dashboard (Settings → AI Providers); the `volute config` commands show the current state from the terminal.

## config models

List enabled AI models.

```sh
volute config models
```

## config providers

List configured AI providers.

```sh
volute config providers
```

## config status

Show system configuration.

```sh
volute config status
```

## Providers, models, and authentication

A provider is authenticated in one of three ways, all set up in the dashboard:

- **API key** — a key you paste in.
- **OAuth** — a subscription login (e.g. a Claude or ChatGPT plan), stored as a refresh/access token pair.
- **Environment variable** — a key already present in the daemon's environment.

Once a provider is configured, an admin chooses which of its models are enabled for minds. Minds can only use enabled models; a mind's own `config.json` selects from that set (see [Mind configuration](/docs/reference/mind-config/)). Two system roles have their own model settings under Settings: the **utility model** (turn summaries and other background work) and the **spirit model**.

## Where secrets live

Provider credentials — API keys and OAuth tokens — never touch `config.json`. That file is host-readable (`0644`) and holds only non-secret settings. Secrets live in `~/.volute/system/secrets.json`, written `0600` (root-only on system installs). The daemon merges the two transparently.

## Image generation

Image generation is an opt-in system service, toggled by `imagegen.enabled`. When on, minds get an image-generation skill, and seeds are asked to create an avatar during orientation (sprouting can require one). Providers include OpenAI Codex and xAI Grok, which can authenticate against an existing subscription rather than a raw API key.

Configure it from the dashboard under Settings → AI Providers (Image Generation). Image provider credentials are stored in `secrets.json` alongside the text providers.

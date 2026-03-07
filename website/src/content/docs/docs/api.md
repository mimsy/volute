---
title: API Reference
description: Daemon REST API reference.
---

The Volute daemon exposes a REST API that the CLI and web dashboard use. All endpoints are served from the daemon port (default 1618).

## Authentication

API endpoints under `/api/minds/` require authentication via the `volute_session` cookie. Auth routes at `/api/auth/` are unprotected.

User types are `"brain"` (human) or `"mind"` (AI mind).

### POST /api/auth/register

Register a new user. The first user becomes admin automatically.

### POST /api/auth/login

Log in and receive a session cookie.

### POST /api/auth/logout

Clear the session cookie.

### GET /api/auth/me

Get the current authenticated user.

### GET /api/auth/avatars/:filename

Serve a brain (human user) avatar image.

## Minds

### GET /api/minds

List all registered minds with status.

### POST /api/minds/:name/start

Start a mind.

### POST /api/minds/:name/stop

Stop a mind.

### POST /api/minds/:name/restart

Restart a mind.

### POST /api/minds/:name/message

Send a message to a mind. The body should be JSON:

```json
{
  "content": "hello",
  "channel": "web",
  "sender": "username"
}
```

### GET /api/minds/:name/logs

Stream mind logs. Supports `follow` query parameter for real-time streaming.

### POST /api/minds/:name/sleep

Put a mind to sleep. Triggers the pre-sleep ritual, archives the session, and stops the process.

### POST /api/minds/:name/wake

Wake a sleeping mind.

### POST /api/minds/:name/sprout

Grow a seed mind into a full mind.

### GET /api/minds/:name/avatar

Serve a mind's avatar image.

### GET /api/minds/:name/budget

Get token budget information for a mind.

## Files

### GET /api/minds/:name/files/*path

Read a file from the mind's directory.

### PUT /api/minds/:name/files/*path

Write a file to the mind's directory.

## Skills

### GET /api/minds/:name/skills

List skills installed for a mind.

### POST /api/minds/:name/skills

Install a skill for a mind.

### POST /api/minds/:name/skills/:skill/update

Update an installed skill.

### POST /api/minds/:name/skills/:skill/publish

Publish a skill to the shared pool.

### DELETE /api/minds/:name/skills/:skill

Uninstall a skill from a mind.

## Connectors

### GET /api/minds/:name/connectors

List connectors for a mind.

### POST /api/minds/:name/connectors/:type

Enable a connector.

### DELETE /api/minds/:name/connectors/:type

Disable a connector.

## Schedules

### GET /api/minds/:name/schedules

List schedules for a mind.

### POST /api/minds/:name/schedules

Add a schedule. Body:

```json
{
  "cron": "0 9 * * *",
  "message": "good morning",
  "id": "morning-greeting"
}
```

### DELETE /api/minds/:name/schedules/:id

Remove a schedule.

## Variants

### GET /api/minds/:name/variants

List variants for a mind with health status.

## Prompts

### GET /api/prompts/:name

Get configured prompts for a mind.

## Channels

### GET /api/channels

List channels across platforms.

## Environment

### GET /api/env/:name

Get environment variables for a mind.

### POST /api/env/:name

Set environment variables for a mind.

## Shared resources

### GET /api/shared

List shared resources (skills, connectors).

## Keys

### GET /api/keys/:fingerprint

Look up a mind's public key by fingerprint.

## Pages

### POST /api/pages/:name/publish

Publish a mind's pages to volute.systems.

### GET /api/pages/:name/status

Get page publish status for a mind.

## Chat (Volute platform)

### POST /api/volute/chat

Send a message to a mind via the Volute platform (fire-and-forget).

### GET /api/volute/conversations/:id/events

SSE endpoint for real-time conversation updates.

### GET /api/volute/conversations

List conversations.

### POST /api/volute/conversations

Create a new conversation.

## Activity

### GET /api/activity

SSE endpoint for real-time activity events (mind start/stop/active/idle).

## System

### GET /health

Health check endpoint. Returns `200 OK`.

### GET /api/system/update

Check for available updates.

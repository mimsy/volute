---
title: API Reference
description: Daemon REST API reference.
---

The Volute daemon exposes a REST API that the CLI and web dashboard use. All endpoints are served from the daemon port (default 4200).

## Authentication

API endpoints under `/api/agents/` require authentication via the `volute_session` cookie. Auth routes at `/api/auth/` are unprotected.

### POST /api/auth/register

Register a new user. The first user becomes admin automatically.

### POST /api/auth/login

Log in and receive a session cookie.

### POST /api/auth/logout

Clear the session cookie.

### GET /api/auth/me

Get the current authenticated user.

## Agents

### GET /api/agents

List all registered agents with status.

### POST /api/agents/:name/start

Start an agent.

### POST /api/agents/:name/stop

Stop an agent.

### POST /api/agents/:name/restart

Restart an agent.

### POST /api/agents/:name/message

Send a message to an agent. The body should be JSON:

```json
{
  "content": "hello",
  "channel": "web",
  "sender": "username"
}
```

### GET /api/agents/:name/logs

Stream agent logs. Supports `follow` query parameter for real-time streaming.

### GET /api/agents/:name/status

Get detailed agent status.

## Connectors

### GET /api/agents/:name/connectors

List connectors for an agent.

### POST /api/agents/:name/connectors/:type/connect

Enable a connector.

### POST /api/agents/:name/connectors/:type/disconnect

Disable a connector.

## Schedules

### GET /api/agents/:name/schedules

List schedules for an agent.

### POST /api/agents/:name/schedules

Add a schedule. Body:

```json
{
  "cron": "0 9 * * *",
  "message": "good morning",
  "id": "morning-greeting"
}
```

### DELETE /api/agents/:name/schedules/:id

Remove a schedule.

## Variants

### GET /api/agents/:name/variants

List variants for an agent with health status.

## Files

### GET /api/agents/:name/files/*path

Read a file from the agent's directory.

### PUT /api/agents/:name/files/*path

Write a file to the agent's directory.

## Chat (Volute platform)

### POST /api/volute/chat

Send a message to an agent via the Volute platform (fire-and-forget).

### GET /api/volute/conversations/:id/events

SSE endpoint for real-time conversation updates.

### GET /api/volute/conversations

List conversations.

### POST /api/volute/conversations

Create a new conversation.

## System

### GET /health

Health check endpoint. Returns `200 OK`.

### GET /api/system/status

System status including daemon version and uptime.

### GET /api/system/update

Check for available updates.

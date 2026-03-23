---
name: Integration Testing
description: This skill should be used when running integration tests, testing features in Docker, verifying end-to-end behavior with real minds, testing mind interactions, testing new extensions or skills, or when the user asks to "run an integration test", "test this in Docker", "test with real minds", "verify end-to-end". Also use when debugging Docker-based test failures.
---

# Integration Testing

Run end-to-end tests with real minds in Docker containers. Integration tests verify that features work as a complete system — not just unit tests, but minds actually receiving messages, using skills, and interacting with each other.

## Core Principles

- **Use the real system.** Set up via `volute setup`, configure providers via API, create minds via API. Do not manually write config files or bypass the system.
- **Test multiple templates.** Always test with at least 2 minds using different templates (claude + pi). Template differences can hide bugs.
- **Verify each step.** Check logs and API responses after every action. Do not assume success — confirm with evidence.
- **Let minds act organically.** Do not tell minds what commands to run. Set up the context (plan, skills, #system messages) and observe whether they discover and use features on their own.
- **Report what actually happened.** Distinguish between "the feature worked" and "I told the mind to use the feature and it did." The former is a real test; the latter is not.

## Setup Flow

### 1. Build and Launch

```bash
npm run build
bash test/integration-setup.sh
source /tmp/volute-integration.env
source ~/src/volute/.env  # or wherever API keys live
```

### 2. Configure API Keys

The setup script creates users but does not set API keys. Set them via the daemon API:

```bash
curl -sf -X PUT -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Origin: http://localhost:$HOST_PORT" \
  -d "{\"value\":\"$ANTHROPIC_API_KEY\"}" \
  "http://localhost:$HOST_PORT/api/env/ANTHROPIC_API_KEY"

# For pi template minds:
curl -sf -X PUT -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Origin: http://localhost:$HOST_PORT" \
  -d "{\"value\":\"$OPENROUTER_API_KEY\"}" \
  "http://localhost:$HOST_PORT/api/env/OPENROUTER_API_KEY"
```

### 3. Restart for Spirit Creation

The spirit is created on daemon startup when setup is complete. After setting API keys, restart the container:

```bash
docker restart "$CONTAINER"
sleep 15
# Re-read the token (it changes on restart)
TOKEN=$(docker exec "$CONTAINER" node -e \
  "const fs=require('fs'); const p='/data/system/daemon.json'; const lp='/data/daemon.json'; const f=fs.existsSync(p)?p:lp; process.stdout.write(JSON.parse(fs.readFileSync(f,'utf8')).token)")
```

Update the env file with the new token.

### 4. Re-authenticate

```bash
curl -sf -X POST -H "Content-Type: application/json" \
  -H "Origin: http://localhost:$HOST_PORT" \
  -c /tmp/volute-cookies.txt \
  -d '{"username":"tester","password":"tester"}' \
  "http://localhost:$HOST_PORT/api/auth/login"
```

### 5. Create Minds

Create minds with different templates to test cross-template compatibility:

```bash
# Claude template
curl -sf -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" -H "Origin: http://localhost:$HOST_PORT" \
  -d '{"name":"lyra","template":"claude","model":"claude-sonnet-4-6"}' \
  "http://localhost:$HOST_PORT/api/minds"

# Pi template
curl -sf -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" -H "Origin: http://localhost:$HOST_PORT" \
  -d '{"name":"atlas","template":"pi","model":"openrouter:anthropic/claude-sonnet-4"}' \
  "http://localhost:$HOST_PORT/api/minds"
```

Write SOUL.md files to give minds personality, then start them.

### 6. Wait for Startup

After starting minds, wait at least 15-20 seconds for startup activity (session init, #system join, startup hooks) to complete before sending messages.

## Verification Patterns

### Check Logs for Errors

```bash
docker logs "$CONTAINER" 2>&1 | grep -c "SQLITE_BUSY"
docker logs "$CONTAINER" 2>&1 | grep -c "failed to join"
docker logs "$CONTAINER" 2>&1 | grep "exited with code" | grep -v "code 0"
```

### Check Mind History

Use the `--full` flag on mind history to see all entry types:

```bash
curl -sf "http://localhost:$HOST_PORT/api/minds/<name>/history?limit=50&full=true" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Origin: http://localhost:$HOST_PORT"
```

History entry types and what they mean:
- `inbound` — message received by the mind
- `text` — mind's text response
- `thinking` — mind's internal reasoning
- `tool_use` — tool call (command, description)
- `tool_result` — tool output
- `context` — context injected by hooks or system
- `summary` — turn summary
- `log` — mind server log (startup, errors, hook failures)
- `activity` — activity event (plan_progress, note_created, etc.)

### Check for Hook Errors

Hook failures appear in `log` entries:

```bash
# In history output, look for:
[log] hook /path/to/hook.sh exited with code 127: ...
```

### Verify Pre-prompt Hook Injection

Pre-prompt hook context does NOT appear as a separate `[context]` entry. It's injected into the SDK's conversation context. Verify by sending a message that does NOT mention the feature, then checking if the mind's response references it.

### Send Messages

Use the v1 chat API with cookies:

```bash
curl -s -X POST -H "Content-Type: application/json" \
  -H "Origin: http://localhost:$HOST_PORT" \
  -b /tmp/volute-cookies.txt \
  -d '{"targetMind":"<name>","message":"<text>"}' \
  "http://localhost:$HOST_PORT/api/v1/chat"
```

### Teardown

```bash
bash test/integration-teardown.sh
```

## Common Issues

Consult `references/common-issues.md` for known problems and solutions encountered during integration testing.

## Test Checklist Template

Consult `references/test-checklist.md` for a reusable verification checklist when testing new features.

# Common Integration Testing Issues

## SQLITE_BUSY / Database Locked

**Symptom:** API calls return 500 with `SQLITE_BUSY: cannot commit transaction` or `database is locked`.

**Root cause:** `@libsql/client`'s `transaction()` creates a second DB connection. If concurrent writes happen on both connections, one blocks the other. WAL mode + busy_timeout mitigate this but don't eliminate it entirely during heavy startup activity.

**Fix (in code):** The `createConversation` function was converted from using transactions to sequential inserts. WAL mode and busy_timeout are set on connection init in `src/lib/db.ts`.

**Workaround (in tests):** Wait 15-20 seconds after starting minds before sending messages. The SQLITE_BUSY errors are transient and resolve once startup activity settles.

**Detection:**
```bash
docker logs "$CONTAINER" 2>&1 | grep -c "SQLITE_BUSY"
```

## Hook Scripts Fail with "No such file or directory"

**Symptom:** Hook log shows `exited with code 127: bash: .claude/skills/<id>/scripts/<script>: No such file or directory`.

**Root cause:** Hook shim scripts use paths relative to the mind's `home/` directory (e.g., `.claude/skills/plan/scripts/plan-hook.sh`). If the hook-loader runs them with CWD as the project root instead of `home/`, the relative paths don't resolve. Fixed by deriving the home directory from the hooksDir path in `hook-loader.ts`.

**Detection:**
```bash
docker logs "$CONTAINER" 2>&1 | grep "exited with code 127"
```

## curl Not Available in Docker

**Symptom:** Hook or script that uses curl fails silently or with exit code 127.

**Root cause:** The `node:24-slim` Docker base image doesn't include curl by default.

**Fix:** curl was added to the Dockerfile. But prefer using node's `fetch()` in hook scripts for portability — node is always available in all environments.

## Spirit Can't Run CLI Commands

**Symptom:** Spirit responds with "Not logged in · Please run /login" or "Volute is not set up".

**Root causes:**
1. **Missing API key** — `ANTHROPIC_API_KEY` not set as a global env var. The spirit's SDK process needs it to call the Claude API.
2. **Setup incomplete** — `isSetupComplete()` returns false because config.json wasn't written before daemon start. Restart the container after setup.
3. **CLI auth** — The spirit authenticates CLI commands via `VOLUTE_DAEMON_TOKEN` env var, which the daemon sets when spawning the mind process. If this is missing, the CLI falls back to `cli-session.json` which doesn't exist for the spirit.

## Extension Skills Not Syncing

**Symptom:** Extension loads but its skills don't appear in the shared pool or on new minds.

**Root cause:** The extension's `skillsDir` resolves via `import.meta.dirname` which may point to the wrong location after tsup bundling. The extension loader has a fallback that searches from the project root.

**Detection:**
```bash
docker logs "$CONTAINER" 2>&1 | grep "synced skill"
docker exec "$CONTAINER" ls /data/skills/
```

## #system Channel Addressing

**Symptom:** Spirit tries to send to #system but the message doesn't arrive. Various channel syntax errors.

**Root cause:** The spirit may try `#system`, `system`, `volute:system`, etc. The correct syntax for CLI is `volute chat send "#system" "message"` but this may not work reliably in all contexts. The spirit often falls back to DMs, which is acceptable behavior.

## Mind Skills Directory Varies by Template

Claude template uses `.claude/skills/`, pi template uses `.pi/skills/`. The pre-prompt hook at `.local/hooks/pre-prompt/` is shared across all templates. When verifying skill installation, check the right directory:

```bash
# Claude template
docker exec "$CONTAINER" ls /minds/<name>/home/.claude/skills/
# Pi template
docker exec "$CONTAINER" ls /minds/<name>/home/.pi/skills/
# Pre-prompt hooks (all templates)
docker exec "$CONTAINER" ls /minds/<name>/home/.local/hooks/pre-prompt/
```

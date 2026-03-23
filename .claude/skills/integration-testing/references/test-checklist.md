# Integration Test Verification Checklist

Reusable checklist for verifying new features end-to-end.

## Infrastructure

- [ ] Container healthy (`/api/health` returns 200)
- [ ] Zero SQLITE_BUSY errors in logs
- [ ] Zero "failed to join" errors in logs
- [ ] Extensions loaded (check daemon logs for `loaded extension: <name>`)
- [ ] Skills synced to shared pool (check `ls /data/skills/`)
- [ ] Spirit created with correct skills
- [ ] Minds created with correct skills (different per template)
- [ ] Pre-prompt hooks installed and executable

## Feature Under Test

- [ ] Feature API endpoints respond correctly
- [ ] CLI commands work from inside mind process (check tool_use/tool_result in history)
- [ ] Pre-prompt hook injects context (verify via mind's organic response, not explicit [context] entry)
- [ ] Spirit can discover and use the feature
- [ ] Minds on claude template can use the feature
- [ ] Minds on pi template can use the feature
- [ ] Activity events published (check `/api/activity/events`)

## Mind Behavior (Organic)

- [ ] Mind references feature without being told about it (proves hook injection)
- [ ] Mind uses feature CLI commands organically (proves skill documentation works)
- [ ] Mind-to-mind interaction occurs (proves communication works)
- [ ] Minds build on each other's work (proves content is shared/visible)

## What NOT to Count as Passing

- Telling a mind to run a specific command and it does → proves CLI works, NOT that the feature is discoverable
- Manually setting up state that the system should create → proves the API works, NOT that the system works
- Testing only one template → does not prove cross-template compatibility

#!/usr/bin/env bash
set -euo pipefail

# Docker end-to-end integration test for Volute
# Validates: image build, daemon startup, mind creation with user isolation,
# mind lifecycle, and (when a real key is present) a real Claude message exchange.
#
# Requirements: docker. ANTHROPIC_API_KEY is optional — when set, Phase 6/7
# exercise a real Claude round-trip; when absent, those phases skip loudly.
# The key is picked up from a repo-root .env if present (see below).
#
# Usage: bash test/docker-e2e.sh

# Source .env from repo root if it exists (for API keys), matching
# integration-setup.sh — otherwise Phase 6/7 silently skip when you forget to
# export ANTHROPIC_API_KEY.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if [[ -f "$REPO_ROOT/.env" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$REPO_ROOT/.env"
  set +a
fi

if ! command -v docker &>/dev/null; then
  echo "Error: docker is required" >&2
  exit 1
fi

# Build dist if needed
if [[ ! -f dist/daemon.js ]]; then
  echo "Building project (dist/daemon.js not found)..."
  npm run build
fi

CONTAINER="volute-e2e-$$"
IMAGE="volute-e2e-$$"
HOST_PORT=11618
PASS=0
FAIL=0
TOKEN=""

cleanup() {
  echo ""
  echo "Cleaning up..."
  docker rm -f "$CONTAINER" 2>/dev/null || true
  docker rmi "$IMAGE" 2>/dev/null || true
}
trap cleanup EXIT

pass() { ((PASS++)) || true; printf "  ✓ %s\n" "$1"; }
fail() { ((FAIL++)) || true; printf "  ✗ %s\n" "$1"; }

assert_eq() {
  local got=$1 expected=$2 label=$3
  if [[ "$got" == "$expected" ]]; then
    pass "$label"
  else
    fail "$label (got: $got, expected: $expected)"
  fi
}

assert_contains() {
  local haystack=$1 needle=$2 label=$3
  if echo "$haystack" | grep -q "$needle"; then
    pass "$label"
  else
    fail "$label (output does not contain: $needle)"
  fi
}

assert_not_empty() {
  local val=$1 label=$2
  if [[ -n "$val" ]]; then
    pass "$label"
  else
    fail "$label (value is empty)"
  fi
}

api() {
  local method=$1 path=$2
  shift 2
  curl -sf -X "$method" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Origin: http://127.0.0.1:1618" \
    -H "Content-Type: application/json" \
    "http://localhost:$HOST_PORT/api$path" "$@"
}

# Allow non-zero exit from curl (used in checks where we handle failure)
api_raw() {
  local method=$1 path=$2
  shift 2
  curl -s -X "$method" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Origin: http://127.0.0.1:1618" \
    -H "Content-Type: application/json" \
    "http://localhost:$HOST_PORT/api$path" "$@"
}

poll_until() {
  local timeout_s=$1
  shift
  local deadline=$((SECONDS + timeout_s))
  while (( SECONDS < deadline )); do
    if "$@" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

mind_is_running() {
  local name=$1
  local status
  status=$(api_raw GET "/minds/$name" | node -e "
    process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).status || 'unknown');
  ")
  [[ "$status" == "running" ]]
}

# ─── Phase 1: Build & start container ────────────────────────────────────────

echo "Phase 1: Build & start container"

docker build -t "$IMAGE" . >/dev/null 2>&1
pass "Docker image built"

# Pass the API key through only when present, so the suite is usable without one.
RUN_ENV=()
[[ -n "${ANTHROPIC_API_KEY:-}" ]] && RUN_ENV+=(-e "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY")

docker run -d --name "$CONTAINER" \
  -p "$HOST_PORT:1618" \
  ${RUN_ENV[@]+"${RUN_ENV[@]}"} \
  "$IMAGE" >/dev/null
pass "Container started"

health_check() { curl -sf "http://localhost:$HOST_PORT/api/health" >/dev/null; }

if poll_until 30 health_check; then
  pass "Daemon healthy"
else
  fail "Daemon did not become healthy within 30s"
  echo "Container logs:"
  docker logs "$CONTAINER" 2>&1 | tail -20
  exit 1
fi

# ─── Phase 2: Read daemon token ──────────────────────────────────────────────

echo ""
echo "Phase 2: Read daemon token"

# Since PR #354 the admin token lives in its own 0600 file (plain token) and
# daemon.json moved under /data/system/. Read the token file directly.
TOKEN=$(docker exec "$CONTAINER" sh -c "cat /data/system/daemon-token" | tr -d '[:space:]')

assert_not_empty "$TOKEN" "Daemon token is non-empty"

# Verify token works
health_resp=$(api GET /health)
assert_contains "$health_resp" '"ok":true' "Token authenticates successfully"

# ─── Phase 3: Create two minds ───────────────────────────────────────────────

echo ""
echo "Phase 3: Create two minds"

# The container entrypoint never runs `volute setup`, but CLI commands are now
# gated on setup completion. Write the setup config the container path expects
# (system install, per-mind user isolation — matching VOLUTE_ISOLATION=user).
docker exec "$CONTAINER" sh -c \
  'mkdir -p /data/system && printf %s "{\"setup\":{\"type\":\"system\",\"isolation\":\"user\"},\"setupCompleted\":true}" > /data/system/config.json'
pass "Setup config written"

# CLI commands proxy through the daemon and need an operator session. Register
# `root` (the container's OS user, so @-target sends resolve the right sender) as
# the first user — auto-admin, auto-approved — then log in and drop its session
# where the CLI looks for it.
curl -sf -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:$HOST_PORT" \
  -d '{"username":"root","password":"root"}' \
  "http://localhost:$HOST_PORT/api/auth/register" >/dev/null
LOGIN_RESP=$(curl -sf -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:$HOST_PORT" \
  -d '{"username":"root","password":"root"}' \
  "http://localhost:$HOST_PORT/api/auth/login")
SESSION_ID=$(echo "$LOGIN_RESP" | node -e "
  process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).sessionId || '');
")
assert_not_empty "$SESSION_ID" "Operator session established"
docker exec "$CONTAINER" sh -c \
  "mkdir -p /root/.volute && printf '%s' '{\"sessionId\":\"$SESSION_ID\",\"username\":\"root\"}' > /root/.volute/cli-session.json && chmod 600 /root/.volute/cli-session.json"

if create_out=$(docker exec "$CONTAINER" node dist/cli.js mind create alice 2>&1); then
  pass "Mind alice created"
else
  fail "Mind alice creation failed"
  echo "$create_out"
  exit 1
fi

if create_out=$(docker exec "$CONTAINER" node dist/cli.js mind create bob 2>&1); then
  pass "Mind bob created"
else
  fail "Mind bob creation failed"
  echo "$create_out"
  exit 1
fi

minds_resp=$(api GET /minds)
assert_contains "$minds_resp" '"name":"alice"' "alice in mind list"
assert_contains "$minds_resp" '"name":"bob"' "bob in mind list"

alice_status=$(echo "$minds_resp" | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const a = d.find(x => x.name === 'alice');
  process.stdout.write(a?.status || 'unknown');
")
assert_eq "$alice_status" "stopped" "alice status is stopped"

bob_status=$(echo "$minds_resp" | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const a = d.find(x => x.name === 'bob');
  process.stdout.write(a?.status || 'unknown');
")
assert_eq "$bob_status" "stopped" "bob status is stopped"

# ─── Phase 4: Verify user isolation ──────────────────────────────────────────

echo ""
echo "Phase 4: Verify user isolation"

if docker exec "$CONTAINER" id mind-alice >/dev/null 2>&1; then
  pass "mind-alice user exists"
else
  fail "mind-alice user does not exist"
fi

if docker exec "$CONTAINER" id mind-bob >/dev/null 2>&1; then
  pass "mind-bob user exists"
else
  fail "mind-bob user does not exist"
fi

alice_owner=$(docker exec "$CONTAINER" stat -c '%U' /minds/alice)
assert_eq "$alice_owner" "mind-alice" "/minds/alice owned by mind-alice"

bob_owner=$(docker exec "$CONTAINER" stat -c '%U' /minds/bob)
assert_eq "$bob_owner" "mind-bob" "/minds/bob owned by mind-bob"

# Creation-time writes (skills, SOUL.md/MEMORY.md, git objects) must also be
# handed to the mind, not just the top-level dir — the chown has to run AFTER
# all of them. Any root-owned path here means a creation-time write escaped the
# ownership fixup and the mind can't modify its own files.
alice_root_owned=$(docker exec "$CONTAINER" find /minds/alice -user root -print -quit 2>/dev/null)
if [[ -z "$alice_root_owned" ]]; then
  pass "no root-owned files under /minds/alice"
else
  fail "root-owned file under /minds/alice: $alice_root_owned"
fi

alice_skills_owner=$(docker exec "$CONTAINER" stat -c '%U' /minds/alice/home/.claude/skills 2>/dev/null || echo missing)
assert_eq "$alice_skills_owner" "mind-alice" "/minds/alice skills dir owned by mind-alice"

# ─── Phase 5: Start minds ────────────────────────────────────────────────────

echo ""
echo "Phase 5: Start minds"

api POST /minds/alice/start >/dev/null
pass "alice start requested"

api POST /minds/bob/start >/dev/null
pass "bob start requested"

# Poll until running (60s timeout — first start may be slow)
if poll_until 60 mind_is_running alice; then
  pass "alice is running"
else
  fail "alice did not reach running status within 60s"
fi

if poll_until 60 mind_is_running bob; then
  pass "bob is running"
else
  fail "bob did not reach running status within 60s"
fi

# ─── Phase 6: Chat with minds ────────────────────────────────────────────────

echo ""
echo "Phase 6: Chat with minds"

# A real chat round-trip needs a real Claude key. Run it when present; skip
# loudly (non-fatal) when absent so the suite stays useful in both environments.
CHAT_TESTED=false
if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "  ⚠ SKIPPED: ANTHROPIC_API_KEY not set — no real Claude round-trip."
  echo "  ⚠ Set ANTHROPIC_API_KEY to exercise Phases 6 & 7."
else
  # Send a DM via the current chat flow (volute chat send @mind) and wait for the
  # mind's reply, which the CLI prints to stdout.
  alice_reply=$(docker exec "$CONTAINER" node dist/cli.js \
    chat send @alice "Reply with only the word pong" --wait --timeout 90000 2>/dev/null || true)
  assert_not_empty "$alice_reply" "alice replied to message"

  bob_reply=$(docker exec "$CONTAINER" node dist/cli.js \
    chat send @bob "Reply with only the word ping" --wait --timeout 90000 2>/dev/null || true)
  assert_not_empty "$bob_reply" "bob replied to message"

  # Check history (full preset returns raw mind_history rows tagged with `mind`)
  alice_history=$(api GET "/minds/alice/history?full=true")
  alice_msg_count=$(echo "$alice_history" | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    process.stdout.write(String(d.length));
  ")
  if (( alice_msg_count >= 1 )); then
    pass "alice history has messages ($alice_msg_count)"
  else
    fail "alice history is empty"
  fi

  bob_history=$(api GET "/minds/bob/history?full=true")
  bob_msg_count=$(echo "$bob_history" | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    process.stdout.write(String(d.length));
  ")
  if (( bob_msg_count >= 1 )); then
    pass "bob history has messages ($bob_msg_count)"
  else
    fail "bob history is empty"
  fi

  CHAT_TESTED=true
fi

# ─── Phase 7: Cross-mind independence ─────────────────────────────────────────

echo ""
echo "Phase 7: Cross-mind independence"

if [[ "$CHAT_TESTED" != "true" ]]; then
  echo "  ⚠ SKIPPED: depends on Phase 6 chat round-trip (no ANTHROPIC_API_KEY)."
else
  # alice and bob both have messages in their own histories
  # Verify they don't share message stores
  alice_minds_in_history=$(echo "$alice_history" | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    const minds = new Set(d.map(m => m.mind));
    process.stdout.write([...minds].join(','));
  ")
  assert_eq "$alice_minds_in_history" "alice" "alice history only contains alice messages"

  bob_minds_in_history=$(echo "$bob_history" | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    const minds = new Set(d.map(m => m.mind));
    process.stdout.write([...minds].join(','));
  ")
  assert_eq "$bob_minds_in_history" "bob" "bob history only contains bob messages"
fi

# ─── Phase 7b: Variant lifecycle (split → dialogue → join) ────────────────────
#
# Exercises the variant train under real auth and user isolation — the config
# where #652 (variant event authz), #653 (worktree .mind ownership), and #654
# (stale verify port) all bit while the unit suites stayed green. Needs real
# turns, so it's gated on the same key as Phase 6.

echo ""
echo "Phase 7b: Variant lifecycle"

if [[ "$CHAT_TESTED" != "true" ]]; then
  echo "  ⚠ SKIPPED: depends on Phase 6 chat round-trip (no ANTHROPIC_API_KEY)."
else
  if split_out=$(docker exec "$CONTAINER" node dist/cli.js \
    mind split alice-var --from alice --purpose "docker e2e: prove the variant lifecycle works" 2>&1); then
    pass "variant alice-var split from alice"
  else
    fail "variant split failed"
    echo "$split_out"
  fi

  if poll_until 60 mind_is_running alice-var; then
    pass "alice-var is running"
  else
    fail "alice-var did not reach running status within 60s"
  fi

  # #653: the variant's .mind (absent from the worktree, created at spawn) must
  # belong to the mind user, or session writes EACCES and every turn dies.
  var_mind_owner=$(docker exec "$CONTAINER" stat -c '%U' /minds/alice/.variants/alice-var/.mind 2>/dev/null || echo missing)
  assert_eq "$var_mind_owner" "mind-alice" "variant worktree .mind owned by mind-alice"

  # #652: the variant must be able to deliver a reply — before the authz fix its
  # event posts 403'd and --wait timed out with the reply silently dropped.
  var_reply=$(docker exec "$CONTAINER" node dist/cli.js \
    chat send @alice-var "Reply with only the word echo" --wait --timeout 90000 2>/dev/null || true)
  assert_not_empty "$var_reply" "alice-var replied to message"

  var_403_count=$(docker exec "$CONTAINER" sh -c \
    'grep -c "event emit failed" /data/system/state/alice-var/logs/mind.log 2>/dev/null' || true)
  assert_eq "${var_403_count:-0}" "0" "variant event posts were accepted (no 'event emit failed')"

  # #654: seed the worktree log with a dead previous attempt's port line — join
  # verification must match only the fresh verify server's output.
  docker exec "$CONTAINER" sh -c \
    'mkdir -p /minds/alice/.variants/alice-var/.mind/logs && echo "listening on :1" >> /minds/alice/.variants/alice-var/.mind/logs/mind.log'
  pass "stale 'listening on :1' line seeded before join"

  # Join with verification ON (the default): farewell turn → auto-commit →
  # verify (must not match the stale port) → merge → cleanup → parent restart.
  if join_out=$(docker exec "$CONTAINER" node dist/cli.js \
    mind join alice-var --summary "docker e2e variant" --justification "variant lifecycle test" 2>&1); then
    assert_contains "$join_out" "joined and cleaned up" "join completed"
  else
    fail "variant join failed"
    echo "$join_out"
  fi

  if docker exec "$CONTAINER" test ! -d /minds/alice/.variants/alice-var; then
    pass "variant worktree removed after join"
  else
    fail "variant worktree still present after join"
  fi

  var_after_join=$(api_raw GET /minds/alice-var)
  if echo "$var_after_join" | grep -q '"error"'; then
    pass "alice-var removed from registry"
  else
    fail "alice-var still in registry after join"
  fi

  if poll_until 90 mind_is_running alice; then
    pass "alice running again after merge restart"
  else
    fail "alice did not come back after merge restart"
  fi

  # The parent receives the merge context ("Your variant ... has returned") as a
  # post-restart message; it lands in history once the parent's turn records.
  merge_context_in_history() {
    api_raw GET "/minds/alice/history?full=true" | grep -q "has returned"
  }
  if poll_until 90 merge_context_in_history; then
    pass "parent received the merge context message"
  else
    fail "merge context message not found in parent history"
  fi
fi

# ─── Phase 8: Stop minds & final checks ──────────────────────────────────────

echo ""
echo "Phase 8: Stop minds & final checks"

api POST /minds/alice/stop >/dev/null
pass "alice stop requested"

api POST /minds/bob/stop >/dev/null
pass "bob stop requested"

# Wait briefly for stop to complete
sleep 2

alice_final=$(api_raw GET /minds/alice | node -e "
  process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).status);
")
assert_eq "$alice_final" "stopped" "alice is stopped"

bob_final=$(api_raw GET /minds/bob | node -e "
  process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).status);
")
assert_eq "$bob_final" "stopped" "bob is stopped"

# Check logs exist (centralized state lives under /data/system/state/<mind>/)
if docker exec "$CONTAINER" test -f /data/system/state/alice/logs/mind.log; then
  pass "alice mind log exists"
else
  fail "alice mind log missing"
fi

if docker exec "$CONTAINER" test -f /data/system/state/bob/logs/mind.log; then
  pass "bob mind log exists"
else
  fail "bob mind log missing"
fi

# ─── Phase: Zombie reaping (tini as PID 1) ───────────────────────────────────
#
# The image bakes tini in as ENTRYPOINT so reparented orphans get reaped
# instead of piling up as <defunct> zombies under the daemon (issue #563).

# Direct guard against an ENTRYPOINT regression: PID 1 must be tini.
pid1=$(docker exec "$CONTAINER" cat /proc/1/comm | tr -d '[:space:]')
assert_eq "$pid1" "tini" "PID 1 is tini"

# Deliberately orphan a short-lived process: the sh parent exits immediately,
# the sleep reparents to PID 1 and must be reaped when it exits — without tini
# it would stay <defunct> forever. This guarantees the zombie check below
# exercises reaping even if the mind-stop path happened to leave no orphans.
docker exec "$CONTAINER" sh -c 'sleep 1 >/dev/null 2>&1 & exit 0'
sleep 3

# After stopping both minds (and the orphan above exiting), no <defunct>
# entries may remain. Capture the process list first so a ps failure is a
# loud test failure rather than being laundered into a passing "0".
if ! ps_out=$(docker exec "$CONTAINER" ps -eo pid,ppid,stat,comm); then
  fail "ps failed in container — zombie check did not run"
elif [[ -z "$ps_out" ]]; then
  fail "ps produced no output — zombie check did not run"
else
  zombie_count=$(printf '%s\n' "$ps_out" | grep -cE '^[[:space:]]*[0-9]+[[:space:]]+[0-9]+[[:space:]]+Z' || true)
  if [[ "$zombie_count" == "0" ]]; then
    pass "no <defunct> zombie processes"
  else
    fail "found $zombie_count zombie process(es)"
    printf '%s\n' "$ps_out" | grep -E '^[[:space:]]*[0-9]+[[:space:]]+[0-9]+[[:space:]]+Z'
  fi
fi

# ─── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Results: $PASS passed, $FAIL failed"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if (( FAIL > 0 )); then
  exit 1
fi

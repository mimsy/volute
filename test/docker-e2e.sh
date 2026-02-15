#!/usr/bin/env bash
set -euo pipefail

# Docker end-to-end integration test for Volute
# Validates: image build, daemon startup, agent creation with user isolation,
# agent lifecycle, and real Claude message exchange.
#
# Requirements: docker, ANTHROPIC_API_KEY
#
# Usage: bash test/docker-e2e.sh

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "Error: ANTHROPIC_API_KEY must be set" >&2
  exit 1
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
HOST_PORT=14200
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
    -H "Origin: http://127.0.0.1:4200" \
    -H "Content-Type: application/json" \
    "http://localhost:$HOST_PORT/api$path" "$@"
}

# Allow non-zero exit from curl (used in checks where we handle failure)
api_raw() {
  local method=$1 path=$2
  shift 2
  curl -s -X "$method" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Origin: http://127.0.0.1:4200" \
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

agent_is_running() {
  local name=$1
  local status
  status=$(api_raw GET "/agents/$name" | node -e "
    process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).status || 'unknown');
  ")
  [[ "$status" == "running" ]]
}

# ─── Phase 1: Build & start container ────────────────────────────────────────

echo "Phase 1: Build & start container"

docker build -t "$IMAGE" . >/dev/null 2>&1
pass "Docker image built"

docker run -d --name "$CONTAINER" \
  -p "$HOST_PORT:4200" \
  -e "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" \
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

TOKEN=$(docker exec "$CONTAINER" node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/data/daemon.json','utf8')).token)")

assert_not_empty "$TOKEN" "Daemon token is non-empty"

# Verify token works
health_resp=$(api GET /health)
assert_contains "$health_resp" '"ok":true' "Token authenticates successfully"

# ─── Phase 3: Create two agents ──────────────────────────────────────────────

echo ""
echo "Phase 3: Create two agents"

docker exec -e "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" "$CONTAINER" \
  node dist/cli.js agent create alice >/dev/null 2>&1
pass "Agent alice created"

docker exec -e "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" "$CONTAINER" \
  node dist/cli.js agent create bob >/dev/null 2>&1
pass "Agent bob created"

agents_resp=$(api GET /agents)
assert_contains "$agents_resp" '"name":"alice"' "alice in agent list"
assert_contains "$agents_resp" '"name":"bob"' "bob in agent list"

alice_status=$(echo "$agents_resp" | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const a = d.find(x => x.name === 'alice');
  process.stdout.write(a?.status || 'unknown');
")
assert_eq "$alice_status" "stopped" "alice status is stopped"

bob_status=$(echo "$agents_resp" | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const a = d.find(x => x.name === 'bob');
  process.stdout.write(a?.status || 'unknown');
")
assert_eq "$bob_status" "stopped" "bob status is stopped"

# ─── Phase 4: Verify user isolation ──────────────────────────────────────────

echo ""
echo "Phase 4: Verify user isolation"

if docker exec "$CONTAINER" id agent-alice >/dev/null 2>&1; then
  pass "agent-alice user exists"
else
  fail "agent-alice user does not exist"
fi

if docker exec "$CONTAINER" id agent-bob >/dev/null 2>&1; then
  pass "agent-bob user exists"
else
  fail "agent-bob user does not exist"
fi

alice_owner=$(docker exec "$CONTAINER" stat -c '%U' /agents/alice)
assert_eq "$alice_owner" "agent-alice" "/agents/alice owned by agent-alice"

bob_owner=$(docker exec "$CONTAINER" stat -c '%U' /agents/bob)
assert_eq "$bob_owner" "agent-bob" "/agents/bob owned by agent-bob"

# ─── Phase 5: Start agents ───────────────────────────────────────────────────

echo ""
echo "Phase 5: Start agents"

api POST /agents/alice/start >/dev/null
pass "alice start requested"

api POST /agents/bob/start >/dev/null
pass "bob start requested"

# Poll until running (60s timeout — first start may be slow)
if poll_until 60 agent_is_running alice; then
  pass "alice is running"
else
  fail "alice did not reach running status within 60s"
fi

if poll_until 60 agent_is_running bob; then
  pass "bob is running"
else
  fail "bob did not reach running status within 60s"
fi

# ─── Phase 6: Chat with agents ───────────────────────────────────────────────

echo ""
echo "Phase 6: Chat with agents"

alice_msg_resp=$(api_raw POST /agents/alice/message -d '{
  "content": [{"type":"text","text":"Reply with only the word pong"}],
  "channel": "test",
  "sender": "docker-test"
}')
assert_contains "$alice_msg_resp" '"ok":true' "alice message accepted"

bob_msg_resp=$(api_raw POST /agents/bob/message -d '{
  "content": [{"type":"text","text":"Reply with only the word ping"}],
  "channel": "test",
  "sender": "docker-test"
}')
assert_contains "$bob_msg_resp" '"ok":true' "bob message accepted"

# Check history
alice_history=$(api GET "/agents/alice/history?channel=test")
alice_msg_count=$(echo "$alice_history" | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  process.stdout.write(String(d.length));
")
if (( alice_msg_count >= 1 )); then
  pass "alice history has messages ($alice_msg_count)"
else
  fail "alice history is empty"
fi

bob_history=$(api GET "/agents/bob/history?channel=test")
bob_msg_count=$(echo "$bob_history" | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  process.stdout.write(String(d.length));
")
if (( bob_msg_count >= 1 )); then
  pass "bob history has messages ($bob_msg_count)"
else
  fail "bob history is empty"
fi

# ─── Phase 7: Cross-agent independence ────────────────────────────────────────

echo ""
echo "Phase 7: Cross-agent independence"

# alice and bob both have messages in their own histories
# Verify they don't share message stores
alice_agents_in_history=$(echo "$alice_history" | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const agents = new Set(d.map(m => m.agent));
  process.stdout.write([...agents].join(','));
")
assert_eq "$alice_agents_in_history" "alice" "alice history only contains alice messages"

bob_agents_in_history=$(echo "$bob_history" | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const agents = new Set(d.map(m => m.agent));
  process.stdout.write([...agents].join(','));
")
assert_eq "$bob_agents_in_history" "bob" "bob history only contains bob messages"

# ─── Phase 8: Stop agents & final checks ─────────────────────────────────────

echo ""
echo "Phase 8: Stop agents & final checks"

api POST /agents/alice/stop >/dev/null
pass "alice stop requested"

api POST /agents/bob/stop >/dev/null
pass "bob stop requested"

# Wait briefly for stop to complete
sleep 2

alice_final=$(api_raw GET /agents/alice | node -e "
  process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).status);
")
assert_eq "$alice_final" "stopped" "alice is stopped"

bob_final=$(api_raw GET /agents/bob | node -e "
  process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).status);
")
assert_eq "$bob_final" "stopped" "bob is stopped"

# Check logs exist
if docker exec "$CONTAINER" test -f /data/state/alice/logs/agent.log; then
  pass "alice agent log exists"
else
  fail "alice agent log missing"
fi

if docker exec "$CONTAINER" test -f /data/state/bob/logs/agent.log; then
  pass "bob agent log exists"
else
  fail "bob agent log missing"
fi

# ─── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Results: $PASS passed, $FAIL failed"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if (( FAIL > 0 )); then
  exit 1
fi

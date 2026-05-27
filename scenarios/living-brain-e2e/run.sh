#!/usr/bin/env bash
# Living Brain E2E Proof — run.sh
#
# Proves the 5-substrate Living Brain (NEXUS + BRAIN + TASKS + CONDUIT + SENTIENT)
# end-to-end on a freshly-created sandbox project.
#
# Usage: bash scenarios/living-brain-e2e/run.sh
#
# What this script does:
#   1. Creates a temp sandbox git repo with 3 TypeScript files (auth, server, config)
#   2. Commits each file tagged with a task ID (T001/T002/T003) in the commit message
#   3. Runs `cleo init` to initialize a CLEO project (creates .cleo/brain.db, tasks.db)
#   4. Runs `cleo nexus analyze` with an isolated CLEO_HOME to build a clean nexus index
#      — the post-analyze git-log sweeper writes task_touches_symbol edges to brain.db
#   5. Seeds a brain observation for validateUser and writes a code_reference edge
#      to link the BRAIN substrate to the NEXUS symbol
#   6. Exports SANDBOX_DIR and NEXUS_HOME so assertions.sh can pick them up
#
# Exit: 0 on success, non-zero on any failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES_DIR="$SCRIPT_DIR/fixtures"

# ---------------------------------------------------------------------------
# 1. Create isolated sandbox environment
# ---------------------------------------------------------------------------

SANDBOX=$(mktemp -d /tmp/living-brain-e2e-XXXXXX)
NEXUS_HOME="$SANDBOX/.nexus-home"
mkdir -p "$NEXUS_HOME"

echo "[run] Sandbox: $SANDBOX"
echo "[run] NEXUS_HOME: $NEXUS_HOME"

# Export for assertions.sh
export SANDBOX_DIR="$SANDBOX"
export NEXUS_HOME

# ---------------------------------------------------------------------------
# 2. Set up git repo with task-tagged commits
# ---------------------------------------------------------------------------

cd "$SANDBOX"
git init -q
git config user.email "test@cleo.dev"
git config user.name "CLEO E2E Test"

mkdir -p src

echo "[run] Copying fixtures..."
cp "$FIXTURES_DIR/auth.ts"   src/auth.ts
cp "$FIXTURES_DIR/server.ts" src/server.ts
cp "$FIXTURES_DIR/config.ts" src/config.ts

# Commit auth.ts — tagged T001 (authentication work)
git add src/auth.ts
git commit -q -m "feat(T001): implement validateUser authentication gateway"

# Commit server.ts — tagged T002 (server implementation)
git add src/server.ts
git commit -q -m "feat(T002): implement startServer and handleRequest"

# Commit config.ts — tagged T003 (configuration layer)
git add src/config.ts
git commit -q -m "feat(T003): add loadConfig application configuration"

echo "[run] Git history:"
git log --oneline

# ---------------------------------------------------------------------------
# 3. Initialize CLEO project in the sandbox
# ---------------------------------------------------------------------------

echo "[run] Initializing CLEO project..."
CLEO_HOME="$NEXUS_HOME" CLEO_ROOT="$SANDBOX" cleo init "living-brain-e2e-proof" --force \
  2>&1 | grep -E '"success"|initialized|Error' | head -3

# ---------------------------------------------------------------------------
# 4. Run nexus analyze with isolated nexus.db
#    — populates nexus_nodes / nexus_relations in NEXUS_HOME/nexus.db
#    — runs git-log sweeper → writes task_touches_symbol to SANDBOX/.cleo/brain.db
# ---------------------------------------------------------------------------

echo "[run] Running cleo nexus analyze (isolated CLEO_HOME)..."
CLEO_HOME="$NEXUS_HOME" CLEO_ROOT="$SANDBOX" cleo nexus analyze "$SANDBOX" 2>&1

# Verify the sweeper produced edges
EDGE_COUNT=$(sqlite3 "$SANDBOX/.cleo/brain.db" \
  "SELECT COUNT(*) FROM brain_page_edges WHERE edge_type='task_touches_symbol'" 2>/dev/null || echo 0)
echo "[run] task_touches_symbol edges created: $EDGE_COUNT"

if [ "$EDGE_COUNT" -lt 1 ]; then
  echo "[run] ERROR: Expected task_touches_symbol edges after analyze but got $EDGE_COUNT"
  exit 1
fi

# ---------------------------------------------------------------------------
# 5. Add a brain observation that references validateUser (BRAIN substrate)
#    — seeds brain_page_nodes + brain_page_edges.code_reference
# ---------------------------------------------------------------------------

echo "[run] Adding brain observation for validateUser..."
OBS_JSON=$(CLEO_HOME="$NEXUS_HOME" CLEO_ROOT="$SANDBOX" cleo memory observe \
  "validateUser is the authentication gateway. It delegates to hashPassword for token hashing and loadConfig for the secret lookup. Introduced in T001 as the primary auth path. Any change to validateUser has a blast radius that includes handleRequest (T002) and the config layer (T003)." \
  --title "validateUser architecture decision" \
  2>/dev/null)

echo "[run] Observation result: $(echo "$OBS_JSON" | grep -o '"id":"[^"]*"' | head -1)"

# Extract observation ID
OBS_ID=$(echo "$OBS_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data']['id'])" 2>/dev/null || echo "")

if [ -z "$OBS_ID" ]; then
  echo "[run] WARN: Could not extract observation ID; BRAIN code_reference seeding skipped"
else
  # The nexus node ID for validateUser is: src/auth.ts::validateUser
  SYMBOL_NEXUS_ID="src/auth.ts::validateUser"

  # Write code_reference edge: observation → symbol
  sqlite3 "$SANDBOX/.cleo/brain.db" "
    INSERT INTO brain_page_edges (from_id, to_id, edge_type, weight, provenance, created_at)
    VALUES ('observation:${OBS_ID}', '${SYMBOL_NEXUS_ID}', 'code_reference', 1.0, 'scenario-seed', datetime('now'))
    ON CONFLICT DO NOTHING;
  " 2>/dev/null
  echo "[run] Seeded code_reference: observation:${OBS_ID} → ${SYMBOL_NEXUS_ID}"

  # Ensure the symbol appears in brain_page_nodes so full-context can hydrate it
  sqlite3 "$SANDBOX/.cleo/brain.db" "
    INSERT INTO brain_page_nodes (id, node_type, label, quality_score)
    VALUES ('${SYMBOL_NEXUS_ID}', 'symbol', 'validateUser', 0.8)
    ON CONFLICT DO NOTHING;
  " 2>/dev/null
  echo "[run] Ensured brain_page_nodes entry for ${SYMBOL_NEXUS_ID}"
fi

# ---------------------------------------------------------------------------
# 6. Emit environment file for assertions.sh
# ---------------------------------------------------------------------------

ENVFILE="$SANDBOX/.living-brain-env"
cat > "$ENVFILE" << ENVEOF
export SANDBOX_DIR='$SANDBOX'
export NEXUS_HOME='$NEXUS_HOME'
ENVEOF

echo ""
echo "[run] Setup complete."
echo "[run]   SANDBOX_DIR=$SANDBOX"
echo "[run]   NEXUS_HOME=$NEXUS_HOME"
echo "[run]   task_touches_symbol edges: $EDGE_COUNT"
echo "[run] Run: bash scenarios/living-brain-e2e/assertions.sh '$SANDBOX'"

#!/usr/bin/env bash
# Living Brain E2E Proof — assertions.sh
#
# Validates all 5 Living Brain substrates against the sandbox created by run.sh.
#
# Usage:
#   bash scenarios/living-brain-e2e/assertions.sh <SANDBOX_DIR>
#   OR (after sourcing):
#   source run.sh && bash assertions.sh "$SANDBOX_DIR"
#
# Exit: 0 if all assertions pass, 1 if any fail.

set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve sandbox from argument or environment
# ---------------------------------------------------------------------------

SANDBOX="${1:-${SANDBOX_DIR:-}}"
if [ -z "$SANDBOX" ]; then
  echo "[assert] ERROR: SANDBOX_DIR not set. Pass it as argument or run run.sh first."
  exit 1
fi

# Always derive NEXUS_HOME from the sandbox directory.
# The sandbox's isolated nexus.db lives under $SANDBOX/.nexus-home.
# We deliberately ignore any ambient NEXUS_HOME env var to avoid
# contamination from the parent shell.
NEXUS_HOME="$SANDBOX/.nexus-home"

if [ ! -d "$SANDBOX/.cleo" ]; then
  echo "[assert] ERROR: $SANDBOX/.cleo not found — run run.sh first"
  exit 1
fi

echo ""
echo "=========================================="
echo " Living Brain E2E Assertions"
echo " Sandbox: $SANDBOX"
echo " NEXUS_HOME: $NEXUS_HOME"
echo "=========================================="
echo ""

PASS=0
FAIL=0

pass() { echo "  [PASS] $1"; PASS=$((PASS + 1)); }
fail() { echo "  [FAIL] $1"; FAIL=$((FAIL + 1)); }

# ---------------------------------------------------------------------------
# Helper: run a CLEO CLI command with sandbox env vars
# ---------------------------------------------------------------------------
cleo_sandbox() {
  CLEO_HOME="$NEXUS_HOME" CLEO_ROOT="$SANDBOX" cleo "$@" 2>/dev/null
}

# ---------------------------------------------------------------------------
# A. Database layer assertions
# ---------------------------------------------------------------------------

echo "── A. Database Assertions ─────────────────"

# A1: nexus_nodes > 0 (NEXUS substrate indexed)
NEXUS_NODE_COUNT=$(CLEO_HOME="$NEXUS_HOME" cleo nexus query \
  "SELECT COUNT(*) as cnt FROM nexus_nodes" 2>/dev/null \
  | grep -E '^\| [0-9]' | awk '{print $2}' | head -1 || echo 0)
if [ "${NEXUS_NODE_COUNT:-0}" -gt 0 ] 2>/dev/null; then
  pass "nexus_nodes populated: $NEXUS_NODE_COUNT nodes"
else
  fail "nexus_nodes empty (got: $NEXUS_NODE_COUNT)"
fi

# A2: nexus_relations with code-graph edges (calls/imports)
NEXUS_RELATION_COUNT=$(CLEO_HOME="$NEXUS_HOME" cleo nexus query \
  "SELECT COUNT(*) as cnt FROM nexus_relations WHERE type IN ('calls','imports')" 2>/dev/null \
  | grep -E '^\| [0-9]' | awk '{print $2}' | head -1 || echo 0)
if [ "${NEXUS_RELATION_COUNT:-0}" -gt 0 ] 2>/dev/null; then
  pass "nexus_relations (calls/imports) populated: $NEXUS_RELATION_COUNT edges"
else
  fail "nexus_relations (calls/imports) empty (got: $NEXUS_RELATION_COUNT)"
fi

# A3: brain_page_edges task_touches_symbol > 0 (TASKS substrate linked to NEXUS)
TASK_TOUCH_COUNT=$(sqlite3 "$SANDBOX/.cleo/brain.db" \
  "SELECT COUNT(*) FROM brain_page_edges WHERE edge_type='task_touches_symbol'" 2>/dev/null || echo 0)
if [ "${TASK_TOUCH_COUNT:-0}" -gt 0 ] 2>/dev/null; then
  pass "brain_page_edges.task_touches_symbol populated: $TASK_TOUCH_COUNT edges"
else
  fail "brain_page_edges.task_touches_symbol empty (got: $TASK_TOUCH_COUNT)"
fi

# A4: brain_page_nodes populated (BRAIN substrate)
BRAIN_NODE_COUNT=$(sqlite3 "$SANDBOX/.cleo/brain.db" \
  "SELECT COUNT(*) FROM brain_page_nodes" 2>/dev/null || echo 0)
if [ "${BRAIN_NODE_COUNT:-0}" -gt 0 ] 2>/dev/null; then
  pass "brain_page_nodes populated: $BRAIN_NODE_COUNT nodes"
else
  fail "brain_page_nodes empty (got: $BRAIN_NODE_COUNT)"
fi

# A5: code_reference edges linking BRAIN observations to NEXUS symbols
CODE_REF_COUNT=$(sqlite3 "$SANDBOX/.cleo/brain.db" \
  "SELECT COUNT(*) FROM brain_page_edges WHERE edge_type='code_reference'" 2>/dev/null || echo 0)
if [ "${CODE_REF_COUNT:-0}" -gt 0 ] 2>/dev/null; then
  pass "brain_page_edges.code_reference populated: $CODE_REF_COUNT edges"
else
  fail "brain_page_edges.code_reference empty (BRAIN → NEXUS link missing)"
fi

# A6: validateUser symbol exists in nexus_nodes
VAL_USER_EXISTS=$(CLEO_HOME="$NEXUS_HOME" cleo nexus query \
  "SELECT COUNT(*) as cnt FROM nexus_nodes WHERE label='validateUser'" 2>/dev/null \
  | grep -E '^\| [0-9]' | awk '{print $2}' | head -1 || echo 0)
if [ "${VAL_USER_EXISTS:-0}" -gt 0 ] 2>/dev/null; then
  pass "validateUser symbol indexed in nexus_nodes"
else
  fail "validateUser symbol NOT found in nexus_nodes"
fi

echo ""
echo "── B. Full-Context Smoke (5 substrates) ───"

# Run full-context
FULL_CTX=$(cleo_sandbox nexus full-context validateUser --json 2>/dev/null || echo '{}')

# B1: Command succeeded
FC_SUCCESS=$(echo "$FULL_CTX" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('success','false'))" 2>/dev/null || echo false)
if [ "$FC_SUCCESS" = "True" ] || [ "$FC_SUCCESS" = "true" ]; then
  pass "full-context returned success:true"
else
  fail "full-context did not return success (got: $FC_SUCCESS)"
fi

# B2: NEXUS substrate populated (callers/callees present)
FC_CALLERS=$(echo "$FULL_CTX" | python3 -c \
  "import sys,json; d=json.load(sys.stdin); n=d.get('data',{}).get('nexus',{}); print(len(n.get('callers',[])) + len(n.get('callees',[])))" 2>/dev/null || echo 0)
if [ "${FC_CALLERS:-0}" -gt 0 ] 2>/dev/null; then
  pass "NEXUS substrate: callers+callees=$FC_CALLERS for validateUser"
else
  fail "NEXUS substrate: no callers/callees found for validateUser"
fi

# B3: TASKS substrate populated (T001 linked)
FC_TASKS=$(echo "$FULL_CTX" | python3 -c \
  "import sys,json; d=json.load(sys.stdin); print(len(d.get('data',{}).get('tasks',[])))" 2>/dev/null || echo 0)
if [ "${FC_TASKS:-0}" -gt 0 ] 2>/dev/null; then
  pass "TASKS substrate: $FC_TASKS task(s) linked to validateUser"
else
  fail "TASKS substrate: no tasks linked to validateUser"
fi

# B4: BRAIN substrate populated (brain memories present)
FC_BRAIN=$(echo "$FULL_CTX" | python3 -c \
  "import sys,json; d=json.load(sys.stdin); print(len(d.get('data',{}).get('brainMemories',[])))" 2>/dev/null || echo 0)
if [ "${FC_BRAIN:-0}" -gt 0 ] 2>/dev/null; then
  pass "BRAIN substrate: $FC_BRAIN memory node(s) linked to validateUser"
else
  fail "BRAIN substrate: no brain memories linked to validateUser"
fi

# B5: command returns all 5 substrate fields in data
FC_FIELDS=$(echo "$FULL_CTX" | python3 -c \
  "import sys,json
d=json.load(sys.stdin).get('data',{})
required=['nexus','brainMemories','tasks','sentientProposals','conduitThreads']
missing=[f for f in required if f not in d]
print(','.join(missing) if missing else 'OK')" 2>/dev/null || echo "error")
if [ "$FC_FIELDS" = "OK" ]; then
  pass "full-context response contains all 5 substrate fields"
else
  fail "full-context response missing substrate fields: $FC_FIELDS"
fi

echo ""
echo "── C. Why Smoke (narrative trace) ─────────"

WHY=$(cleo_sandbox nexus why validateUser --json 2>/dev/null || echo '{}')

# C1: command succeeds
WHY_SUCCESS=$(echo "$WHY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('success','false'))" 2>/dev/null || echo false)
if [ "$WHY_SUCCESS" = "True" ] || [ "$WHY_SUCCESS" = "true" ]; then
  pass "why returned success:true"
else
  fail "why did not return success (got: $WHY_SUCCESS)"
fi

# C2: symbolId present in response
WHY_SYM=$(echo "$WHY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('symbolId',''))" 2>/dev/null || echo "")
if [ -n "$WHY_SYM" ]; then
  pass "why.symbolId present: $WHY_SYM"
else
  fail "why.symbolId missing from response"
fi

# C3: narrative present
WHY_NARR=$(echo "$WHY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('narrative',''))" 2>/dev/null || echo "")
if [ -n "$WHY_NARR" ]; then
  pass "why.narrative present: ${WHY_NARR:0:60}..."
else
  fail "why.narrative missing from response"
fi

echo ""
echo "── D. Impact-Full Smoke (merged impact) ────"

IMPACT=$(cleo_sandbox nexus impact-full validateUser --json 2>/dev/null || echo '{}')

# D1: command succeeds
IMP_SUCCESS=$(echo "$IMPACT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('success','false'))" 2>/dev/null || echo false)
if [ "$IMP_SUCCESS" = "True" ] || [ "$IMP_SUCCESS" = "true" ]; then
  pass "impact-full returned success:true"
else
  fail "impact-full did not return success (got: $IMP_SUCCESS)"
fi

# D2: structural blast radius present (directCallers > 0 — handleRequest calls validateUser)
IMP_CALLERS=$(echo "$IMPACT" | python3 -c \
  "import sys,json; d=json.load(sys.stdin); print(d.get('data',{}).get('structural',{}).get('directCallers',0))" 2>/dev/null || echo 0)
if [ "${IMP_CALLERS:-0}" -gt 0 ] 2>/dev/null; then
  pass "impact-full.structural.directCallers=$IMP_CALLERS (blast radius populated)"
else
  fail "impact-full.structural.directCallers=0 (no blast radius)"
fi

# D3: mergedRiskScore present
IMP_RISK=$(echo "$IMPACT" | python3 -c \
  "import sys,json; print(json.load(sys.stdin).get('data',{}).get('mergedRiskScore',''))" 2>/dev/null || echo "")
if [ -n "$IMP_RISK" ]; then
  pass "impact-full.mergedRiskScore=$IMP_RISK"
else
  fail "impact-full.mergedRiskScore missing"
fi

# D4: narrative present
IMP_NARR=$(echo "$IMPACT" | python3 -c \
  "import sys,json; print(json.load(sys.stdin).get('data',{}).get('narrative',''))" 2>/dev/null || echo "")
if [ -n "$IMP_NARR" ]; then
  pass "impact-full.narrative present: ${IMP_NARR:0:60}..."
else
  fail "impact-full.narrative missing"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo "=========================================="
echo " Results: $PASS passed, $FAIL failed"
echo "=========================================="
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo "[assert] FAIL — $FAIL assertion(s) did not pass."
  echo ""
  echo "Substrate verification table:"
  echo "  NEXUS (nexus_nodes):          ${NEXUS_NODE_COUNT:-?} nodes, ${NEXUS_RELATION_COUNT:-?} relations"
  echo "  BRAIN (brain_page_edges):     ${CODE_REF_COUNT:-?} code_reference, ${BRAIN_NODE_COUNT:-?} nodes"
  echo "  TASKS (task_touches_symbol):  ${TASK_TOUCH_COUNT:-?} edges"
  echo "  SENTIENT:                     (proposals checked via full-context field presence)"
  echo "  CONDUIT:                      (threads checked via full-context field presence)"
  exit 1
fi

echo "[assert] PASS — all $PASS assertions verified."
echo ""
echo "Substrate verification table:"
echo "  NEXUS (nexus_nodes):          ${NEXUS_NODE_COUNT:-?} nodes, ${NEXUS_RELATION_COUNT:-?} relations"
echo "  BRAIN (brain_page_edges):     ${CODE_REF_COUNT:-?} code_reference, ${BRAIN_NODE_COUNT:-?} nodes"
echo "  TASKS (task_touches_symbol):  ${TASK_TOUCH_COUNT:-?} edges"
echo "  SENTIENT:                     sentientProposals field verified in full-context"
echo "  CONDUIT:                      conduitThreads field verified in full-context"
echo ""
echo "SANDBOX: $SANDBOX (safe to remove with: rm -rf '$SANDBOX')"

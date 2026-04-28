#!/usr/bin/env bash
# run.sh — Sentient Tier-2 real-world proof: injected anomaly → ProposalCandidate
#
# This scenario proves that the sentient nexus-ingester produces ProposalCandidates
# when deliberately anomalous graph data is present. It runs entirely in-process
# against in-memory SQLite — no daemon, no real DB side effects.
#
# Usage:
#   bash scenarios/sentient-anomaly-proof/run.sh
#
# Exit codes:
#   0  — proof script produced output (assertions.sh validates content)
#   1  — fatal error (Node.js unavailable, package build missing, etc.)
#
# @task T1112
set -euo pipefail

SCENARIO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCENARIO_DIR}/../.." && pwd)"
PROOF_SCRIPT="${SCENARIO_DIR}/proof.mjs"
OUTPUT_FILE="${SCENARIO_DIR}/proof-output.json"

# ---------------------------------------------------------------------------
# Guard: sentient commands need a live project — check gracefully
# ---------------------------------------------------------------------------
if ! command -v node &>/dev/null; then
  echo "[T1112] ERROR: node not found in PATH" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Guard: ensure the core package is built (proof.mjs imports from dist/)
# ---------------------------------------------------------------------------
CORE_DIST="${PROJECT_ROOT}/packages/core/dist"
if [[ ! -d "${CORE_DIST}" ]]; then
  echo "[T1112] ERROR: packages/core/dist not found — run 'pnpm run build' first" >&2
  exit 1
fi

INGESTER_DIST="${CORE_DIST}/sentient/ingesters/nexus-ingester.js"
if [[ ! -f "${INGESTER_DIST}" ]]; then
  echo "[T1112] ERROR: nexus-ingester.js not found in dist/ — run 'pnpm run build' first" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Run the proof script
# ---------------------------------------------------------------------------
echo "[T1112] Running sentient anomaly proof..."
echo "[T1112] Project root: ${PROJECT_ROOT}"
echo "[T1112] Output: ${OUTPUT_FILE}"
echo ""

node --experimental-vm-modules "${PROOF_SCRIPT}" \
  --project-root="${PROJECT_ROOT}" \
  --output="${OUTPUT_FILE}" 2>&1

echo ""
echo "[T1112] Proof script complete. Run assertions.sh to verify."

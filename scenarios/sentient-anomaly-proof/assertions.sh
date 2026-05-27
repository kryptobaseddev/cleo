#!/usr/bin/env bash
# assertions.sh — Verify the sentient anomaly proof output.
#
# Reads proof-output.json produced by run.sh / proof.mjs and asserts:
#   1. All five anomaly detectors fired with correct sourceIds
#   2. Proposal weights match detector type:
#      - orphaned-callee:         0.3 (base)
#      - over-coupled-node:       0.3 (base)
#      - community-fragmentation: 0.4
#      - entry-erosion:           0.5
#      - cross-community-spike:   0.35
#   3. Zero false positives on clean symbols
#
# Exit codes:
#   0 — all assertions passed
#   1 — one or more assertions failed
#
# @task T1112
set -euo pipefail

SCENARIO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_FILE="${SCENARIO_DIR}/proof-output.json"
ASSERT_SCRIPT="${SCENARIO_DIR}/assert-runner.mjs"

# ---------------------------------------------------------------------------
# Guard: check proof-output.json exists
# ---------------------------------------------------------------------------
if [[ ! -f "${OUTPUT_FILE}" ]]; then
  echo "[T1112] ERROR: proof-output.json not found at ${OUTPUT_FILE}" >&2
  echo "[T1112] Run 'bash scenarios/sentient-anomaly-proof/run.sh' first" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Guard: node available
# ---------------------------------------------------------------------------
if ! command -v node &>/dev/null; then
  echo "[T1112] ERROR: node not found in PATH" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Run the assertion runner
# ---------------------------------------------------------------------------
exec node "${ASSERT_SCRIPT}" --output="${OUTPUT_FILE}"

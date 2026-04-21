#!/usr/bin/env bash
# CLEO PreCompact Hook — Cursor emergency safestop shim
#
# Cursor is a config-based hook provider (.cursor/hooks.json) whose canonical
# event `PreCompact` maps to the native event `preCompact`. Handler types
# supported: `command`, `prompt`. This file targets `command` handlers.
#
# INSTALLATION (Cursor):
#   Copy to .cursor/hooks/precompact.sh (alongside cleo-precompact-core.sh)
#   and add the following to .cursor/hooks.json:
#
#   {
#     "hooks": {
#       "preCompact": [{
#         "type": "command",
#         "command": "./.cursor/hooks/precompact.sh",
#         "timeout": 30
#       }]
#     }
#   }
#
# The universal flush + safestop sequence is implemented in the shared helper
# cleo-precompact-core.sh. This shim only adds a Cursor-flavoured banner.
#
# @task T1013
# @provider cursor

set -euo pipefail

# Source the shared CLEO core helper. Installed alongside this shim.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../../shared/templates/hooks/cleo-precompact-core.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/cleo-precompact-core.sh"

# Run the universal flush + safestop sequence.
cleo_core_run_precompact "precompact-emergency"

# Cursor-specific status banner (only when a session was actually saved).
if [[ -n "${CLEO_PRECOMPACT_HANDOFF:-}" ]]; then
    echo ""
    echo "[CLEO] Emergency Safestop executed at Cursor preCompact event."
    echo "       Session ended. Handoff saved to: ${CLEO_PRECOMPACT_HANDOFF}"
    if [[ -n "${CLEO_PRECOMPACT_SESSION_ID:-}" ]]; then
        echo "       Resume with: cleo session resume ${CLEO_PRECOMPACT_SESSION_ID}"
    fi
fi

#!/usr/bin/env bash
# CLEO PreCompact Hook — Gemini CLI emergency safestop shim
#
# Gemini CLI is a config-based hook provider (~/.gemini/settings.json) whose
# canonical event `PreCompact` maps to the native event `PreCompress`.
# Handler type supported: `command`.
#
# INSTALLATION (Gemini CLI):
#   Copy to ~/.gemini/hooks/precompact.sh (alongside cleo-precompact-core.sh)
#   and add the following to ~/.gemini/settings.json:
#
#   {
#     "hooks": {
#       "PreCompress": [{
#         "type": "command",
#         "command": "~/.gemini/hooks/precompact.sh",
#         "timeout": 30
#       }]
#     }
#   }
#
# The universal flush + safestop sequence lives in cleo-precompact-core.sh.
# This shim only adds a Gemini-flavoured banner.
#
# @task T1013
# @provider gemini-cli

set -euo pipefail

# Source the shared CLEO core helper. Installed alongside this shim.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../../shared/templates/hooks/cleo-precompact-core.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/cleo-precompact-core.sh"

# Run the universal flush + safestop sequence.
cleo_core_run_precompact "precompact-emergency"

# Gemini-CLI-specific status banner (only when a session was actually saved).
if [[ -n "${CLEO_PRECOMPACT_HANDOFF:-}" ]]; then
    echo ""
    echo "[CLEO] Emergency Safestop executed at Gemini CLI PreCompress event."
    echo "       Session ended. Handoff saved to: ${CLEO_PRECOMPACT_HANDOFF}"
    if [[ -n "${CLEO_PRECOMPACT_SESSION_ID:-}" ]]; then
        echo "       Resume with: cleo session resume ${CLEO_PRECOMPACT_SESSION_ID}"
    fi
fi

#!/usr/bin/env bash
# CLEO PreCompact Hook — Claude Code emergency safestop shim
#
# Triggers when Claude Code's auto-compact fires (at 95% context usage).
# Claude Code is a config-based hook provider (~/.claude/settings.json)
# whose canonical event `PreCompact` maps to the native event `PreCompact`.
#
# INSTALLATION (Claude Code):
#   Copy to ~/.claude/hooks/ (alongside cleo-precompact-core.sh) or
#   configure the installer to write this block to ~/.claude/settings.json:
#
#   {
#     "hooks": {
#       "PreCompact": [{
#         "type": "command",
#         "command": "~/.claude/hooks/precompact-safestop.sh",
#         "timeout": 30
#       }]
#     }
#   }
#
# This shim is the Claude-Code-specific banner wrapper around the universal
# CLEO safestop sequence. The actual flush + safestop logic lives in the
# shared helper at cleo-precompact-core.sh (provider-neutral).
#
# Provides emergency fallback when an agent does not self-stop at the
# critical (90%) threshold. At 95% Claude Code triggers `PreCompact`, and
# this hook ensures CLEO session state is properly captured.
#
# @task T1013
# @provider claude-code

set -euo pipefail

# Source the shared CLEO core helper. Installed alongside this shim.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../../shared/templates/hooks/cleo-precompact-core.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/cleo-precompact-core.sh"

# Run the universal flush + safestop sequence.
cleo_core_run_precompact "precompact-emergency"

# Claude-Code-specific status banner (only when a session was actually saved).
if [[ -n "${CLEO_PRECOMPACT_HANDOFF:-}" ]]; then
    echo ""
    echo "[CLEO] Emergency Safestop executed at PreCompact (Claude Code 95% context)."
    echo "       Session ended. Handoff saved to: ${CLEO_PRECOMPACT_HANDOFF}"
    if [[ -n "${CLEO_PRECOMPACT_SESSION_ID:-}" ]]; then
        echo "       Resume with: cleo session resume ${CLEO_PRECOMPACT_SESSION_ID}"
    fi
fi

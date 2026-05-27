#!/usr/bin/env bash
# CLEO PreCompact Hook — OpenCode emergency safestop shim
#
# OpenCode is a plugin-based hook provider (.opencode/plugins/) whose canonical
# event `PreCompact` maps to the native event `experimental.session.compacting`.
# OpenCode's handler type is `plugin` (JavaScript) — this shell script is
# invoked from the JS plugin wrapper as a child process.
#
# INSTALLATION (OpenCode):
#   1. Copy this file to .opencode/plugins/hooks/precompact.sh (alongside
#      cleo-precompact-core.sh).
#   2. Register a JS plugin that spawns this shim on the canonical event.
#      See packages/adapters/src/providers/opencode/install.ts for the
#      generated wrapper that wires `experimental.session.compacting` to
#      this script via `child_process.spawn`.
#
# The universal flush + safestop sequence lives in cleo-precompact-core.sh.
# This shim only adds an OpenCode-flavoured banner.
#
# @task T1013
# @provider opencode

set -euo pipefail

# Source the shared CLEO core helper. Installed alongside this shim.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../../shared/templates/hooks/cleo-precompact-core.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/cleo-precompact-core.sh"

# Run the universal flush + safestop sequence.
cleo_core_run_precompact "precompact-emergency"

# OpenCode-specific status banner (only when a session was actually saved).
if [[ -n "${CLEO_PRECOMPACT_HANDOFF:-}" ]]; then
    echo ""
    echo "[CLEO] Emergency Safestop executed at OpenCode experimental.session.compacting."
    echo "       Session ended. Handoff saved to: ${CLEO_PRECOMPACT_HANDOFF}"
    if [[ -n "${CLEO_PRECOMPACT_SESSION_ID:-}" ]]; then
        echo "       Resume with: cleo session resume ${CLEO_PRECOMPACT_SESSION_ID}"
    fi
fi

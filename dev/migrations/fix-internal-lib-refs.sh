#!/usr/bin/env bash
# fix-internal-lib-refs.sh - Fix _LIB_DIR references inside lib/**/*.sh files
#
# After moving files into subdirectories, internal source references using
# _LIB_DIR (which resolves to the file's own directory) break when targeting
# files in other subdirectories. This script:
# 1. Changes _LIB_DIR definitions to point to lib/ (parent of subdirectory)
# 2. Updates $_LIB_DIR/filename.sh references to $_LIB_DIR/subdir/filename.sh

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB_DIR="$PROJECT_ROOT/lib"

# File-to-subdirectory mapping (same as lib-hierarchy-migrate.sh)
declare -A FILE_MAP=(
    [exit-codes.sh]=core
    [error-json.sh]=core
    [output-format.sh]=core
    [logging.sh]=core
    [config.sh]=core
    [paths.sh]=core
    [platform-compat.sh]=core
    [version.sh]=core
    [json-output.sh]=core
    [jq-helpers.sh]=core
    [sequence.sh]=core
    [validation.sh]=validation
    [protocol-validation.sh]=validation
    [protocol-validation-common.sh]=validation
    [compliance-check.sh]=validation
    [manifest-validation.sh]=validation
    [verification.sh]=validation
    [doctor-checks.sh]=validation
    [doctor-project-cache.sh]=validation
    [doctor-utils.sh]=validation
    [gap-check.sh]=validation
    [docs-sync.sh]=validation
    [sessions.sh]=session
    [session-enforcement.sh]=session
    [session-migration.sh]=session
    [context-alert.sh]=session
    [context-monitor.sh]=session
    [statusline-setup.sh]=session
    [lock-detection.sh]=session
    [hitl-warnings.sh]=session
    [task-mutate.sh]=tasks
    [dependency-check.sh]=tasks
    [hierarchy.sh]=tasks
    [phase-tracking.sh]=tasks
    [analysis.sh]=tasks
    [staleness.sh]=tasks
    [size-weighting.sh]=tasks
    [crossref-extract.sh]=tasks
    [graph-cache.sh]=tasks
    [graph-ops.sh]=tasks
    [graph-rag.sh]=tasks
    [cancel-ops.sh]=tasks
    [archive-cancel.sh]=tasks
    [delete-preview.sh]=tasks
    [deletion-strategy.sh]=tasks
    [todowrite-integration.sh]=tasks
    [lifecycle.sh]=tasks
    [skill-discovery.sh]=skills
    [skill-dispatch.sh]=skills
    [skill-validate.sh]=skills
    [skills-install.sh]=skills
    [skills-version.sh]=skills
    [skillsmp.sh]=skills
    [agent-config.sh]=skills
    [agent-registry.sh]=skills
    [agents-install.sh]=skills
    [orchestrator-spawn.sh]=skills
    [orchestrator-startup.sh]=skills
    [orchestrator-validator.sh]=skills
    [subagent-inject.sh]=skills
    [token-inject.sh]=skills
    [contribution-protocol.sh]=skills
    [research-manifest.sh]=skills
    [test-utility.sh]=skills
    [file-ops.sh]=data
    [atomic-write.sh]=data
    [backup.sh]=data
    [cache.sh]=data
    [migrate.sh]=data
    [nexus-deps.sh]=data
    [nexus-permissions.sh]=data
    [nexus-query.sh]=data
    [nexus-registry.sh]=data
    [git-checkpoint.sh]=data
    [import-logging.sh]=data
    [import-remap.sh]=data
    [import-sort.sh]=data
    [export.sh]=data
    [project-detect.sh]=data
    [project-registry.sh]=data
    [files-detect.sh]=data
    [flags.sh]=ui
    [command-registry.sh]=ui
    [claude-aliases.sh]=ui
    [injection.sh]=ui
    [injection-config.sh]=ui
    [injection-registry.sh]=ui
    [changelog.sh]=ui
    [mcp-config.sh]=ui
    [version-check.sh]=ui
    [metrics-aggregation.sh]=metrics
    [metrics-common.sh]=metrics
    [metrics-enums.sh]=metrics
    [otel-integration.sh]=metrics
    [token-estimation.sh]=metrics
    [ab-test.sh]=metrics
    [release.sh]=release
    [release-config.sh]=release
    [release-artifacts.sh]=release
    [release-ci.sh]=release
    [release-provenance.sh]=release
)

total_fixes=0
files_fixed=0

# Process each shell file in lib subdirectories
for subdir in core validation session tasks skills data ui metrics release; do
    for file in "$LIB_DIR/$subdir"/*.sh; do
        [[ -f "$file" ]] || continue

        local_fixes=0
        content="$(cat "$file")"
        new_content="$content"

        # Step 1: Fix _LIB_DIR definitions to point to lib/ (parent dir)
        # Pattern: _LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
        # Replace with: _LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
        # Also handle variants like _AW_LIB_DIR, _CONFIG_LIB_DIR, etc.
        new_content="$(echo "$new_content" | sed -E 's|(_[A-Z_]*LIB_DIR)="\$\(cd "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)" \&\& pwd\)"|\1="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." \&\& pwd)"|g')"

        # Also handle the variant with :-$( default
        # _DELETE_PREVIEW_LIB_DIR="${_DELETE_PREVIEW_LIB_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
        new_content="$(echo "$new_content" | sed -E 's|(_[A-Z_]*LIB_DIR)="\$\{[^:]+:-\$\(cd "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)" \&\& pwd\)\}"|\1="${\1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." \&\& pwd)}"|g')"

        # Step 2: Fix internal source references
        # For each referenced file in the content, replace $_*LIB_DIR/filename.sh
        # with $_*LIB_DIR/correct-subdir/filename.sh
        for fname in "${!FILE_MAP[@]}"; do
            target_subdir="${FILE_MAP[$fname]}"

            # Skip if this file references itself in the same subdir (already correct)
            # Actually we need to add subdir/ prefix for ALL references since _LIB_DIR now points to lib/

            # Replace patterns like: $_LIB_DIR/filename.sh -> $_LIB_DIR/subdir/filename.sh
            # Handle various _LIB_DIR variable name prefixes
            # Use word boundary to avoid partial matches
            if echo "$new_content" | grep -q "/$fname" 2>/dev/null; then
                # Replace the bare filename with subdir/filename for all _*LIB_DIR patterns
                new_content="$(echo "$new_content" | sed "s|_LIB_DIR/$fname|_LIB_DIR/$target_subdir/$fname|g")"
                # Count fixes
                local_fixes=$((local_fixes + 1))
            fi
        done

        # Also fix the VERSION file reference: $_LIB_DIR/../VERSION should become $_LIB_DIR/VERSION
        # since _LIB_DIR now points to lib/ which is one level up from before
        # Actually: before, _LIB_DIR was lib/core/ so ../VERSION = lib/VERSION (which doesn't exist anyway)
        # The VERSION file is at project root. Before: lib/core/../VERSION = lib/VERSION. Wrong.
        # Actually it was: $_LIB_DIR/../VERSION which before was lib/../VERSION = ./VERSION
        # Now _LIB_DIR is lib/ so $_LIB_DIR/../VERSION is still ./VERSION. That's fine.
        # Wait no - now we changed _LIB_DIR to go up one more: lib/core/.. = lib/
        # So $_LIB_DIR/../VERSION = VERSION (project root). Same as before. OK, no change needed.

        if [[ "$new_content" != "$content" ]]; then
            echo "$new_content" > "$file"
            files_fixed=$((files_fixed + 1))
            total_fixes=$((total_fixes + local_fixes))
            echo "[FIX] $file ($local_fixes reference fixes)"
        fi
    done
done

echo ""
echo "Fixed $files_fixed files with $total_fixes reference updates"
echo ""
echo "Verify with: cleo version"

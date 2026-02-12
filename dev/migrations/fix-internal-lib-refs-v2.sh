#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PROJECT_ROOT"

# Mapping: filename -> subdirectory
declare -A MAP=(
    [exit-codes.sh]=core [error-json.sh]=core [output-format.sh]=core
    [logging.sh]=core [config.sh]=core [paths.sh]=core
    [platform-compat.sh]=core [version.sh]=core [json-output.sh]=core
    [jq-helpers.sh]=core [sequence.sh]=core
    [validation.sh]=validation [protocol-validation.sh]=validation
    [protocol-validation-common.sh]=validation [compliance-check.sh]=validation
    [manifest-validation.sh]=validation [verification.sh]=validation
    [doctor-checks.sh]=validation [doctor-project-cache.sh]=validation
    [doctor-utils.sh]=validation [gap-check.sh]=validation [docs-sync.sh]=validation
    [sessions.sh]=session [session-enforcement.sh]=session
    [session-migration.sh]=session [context-alert.sh]=session
    [context-monitor.sh]=session [statusline-setup.sh]=session
    [lock-detection.sh]=session [hitl-warnings.sh]=session
    [task-mutate.sh]=tasks [dependency-check.sh]=tasks
    [hierarchy.sh]=tasks [phase-tracking.sh]=tasks [analysis.sh]=tasks
    [staleness.sh]=tasks [size-weighting.sh]=tasks [crossref-extract.sh]=tasks
    [graph-cache.sh]=tasks [graph-ops.sh]=tasks [graph-rag.sh]=tasks
    [cancel-ops.sh]=tasks [archive-cancel.sh]=tasks [delete-preview.sh]=tasks
    [deletion-strategy.sh]=tasks [todowrite-integration.sh]=tasks [lifecycle.sh]=tasks
    [skill-discovery.sh]=skills [skill-dispatch.sh]=skills [skill-validate.sh]=skills
    [skills-install.sh]=skills [skills-version.sh]=skills [skillsmp.sh]=skills
    [agent-config.sh]=skills [agent-registry.sh]=skills [agents-install.sh]=skills
    [orchestrator-spawn.sh]=skills [orchestrator-startup.sh]=skills
    [orchestrator-validator.sh]=skills [subagent-inject.sh]=skills
    [token-inject.sh]=skills [contribution-protocol.sh]=skills
    [research-manifest.sh]=skills [test-utility.sh]=skills
    [file-ops.sh]=data [atomic-write.sh]=data [backup.sh]=data
    [cache.sh]=data [migrate.sh]=data [nexus-deps.sh]=data
    [nexus-permissions.sh]=data [nexus-query.sh]=data [nexus-registry.sh]=data
    [git-checkpoint.sh]=data [import-logging.sh]=data [import-remap.sh]=data
    [import-sort.sh]=data [export.sh]=data [project-detect.sh]=data
    [project-registry.sh]=data [files-detect.sh]=data
    [flags.sh]=ui [command-registry.sh]=ui [claude-aliases.sh]=ui
    [injection.sh]=ui [injection-config.sh]=ui [injection-registry.sh]=ui
    [changelog.sh]=ui [mcp-config.sh]=ui [version-check.sh]=ui
    [metrics-aggregation.sh]=metrics [metrics-common.sh]=metrics
    [metrics-enums.sh]=metrics [otel-integration.sh]=metrics
    [token-estimation.sh]=metrics [ab-test.sh]=metrics
    [release.sh]=release [release-config.sh]=release [release-artifacts.sh]=release
    [release-ci.sh]=release [release-provenance.sh]=release
)

fix_count=0

for fname in "${!MAP[@]}"; do
    subdir="${MAP[$fname]}"

    # Find files that reference LIB_DIR/filename.sh (bare, without subdir prefix)
    # The grep pattern matches any *_LIB_DIR/filename.sh
    # But exclude lines that already have the correct subdir prefix
    while IFS= read -r file; do
        [[ -z "$file" ]] && continue

        # Double-check: does this file have a bare reference (without subdir)?
        if grep -q "LIB_DIR/${fname}" "$file" 2>/dev/null; then
            # Check if any of those matches are NOT already prefixed with the correct subdir
            bare_count=$(grep -c "LIB_DIR/${fname}" "$file" 2>/dev/null || echo 0)
            prefixed_count=$(grep -c "LIB_DIR/${subdir}/${fname}" "$file" 2>/dev/null || echo 0)

            if [[ "$bare_count" -gt "$prefixed_count" ]]; then
                # There are bare references that need fixing
                # Strategy: first replace all bare refs, but need to avoid double-prefixing
                # So: replace LIB_DIR/fname with LIB_DIR/subdir/fname
                # But NOT LIB_DIR/subdir/fname (already correct)

                # Use a negative lookbehind approach with perl
                perl -pi -e "s|LIB_DIR/(?!${subdir}/)${fname}|LIB_DIR/${subdir}/${fname}|g" "$file"
                echo "[FIX] $file: ${fname} -> ${subdir}/${fname}"
                fix_count=$((fix_count + 1))
            fi
        fi
    done < <(grep -rl "LIB_DIR/${fname}" lib/ --include="*.sh" 2>/dev/null)
done

echo ""
echo "Total files fixed: $fix_count"

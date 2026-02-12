#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PROJECT_ROOT"

echo "=== Final comprehensive fix for all internal lib refs ==="

# Strategy: For EVERY file in lib subdirectories, fix:
# 1. Any DIR variable pointing to file's own directory -> point to lib/ parent
# 2. Any source/. referencing a filename without correct subdir prefix

# Phase 1: Fix all DIR variable definitions that use BASH_SOURCE
echo "--- Phase 1: Fix DIR definitions ---"
fix1=0
for file in lib/{core,validation,session,tasks,skills,data,ui,metrics,release}/*.sh; do
    [[ -f "$file" ]] || continue
    before=$(cat "$file")

    # Fix cd/dirname/pwd pattern (that isn't already /.. appended)
    # Pattern: VARNAME="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    # -> VARNAME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    perl -pi -e '
        # Match any VAR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" not already having /..
        if (m{([A-Z_]+)="\$\(cd "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)" && pwd\)"} && !m{/\.\." && pwd\)"}) {
            s{(\$\(cd "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\))" && pwd\))}{$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)};
        }
    ' "$file"

    # Fix %/* pattern not already having /.. appended
    # Pattern: VAR="${BASH_SOURCE[0]%/*}" -> VAR="${BASH_SOURCE[0]%/*}/.."
    perl -pi -e '
        if (m{="\$\{BASH_SOURCE\[0\]%/\*\}"} && !m{%/\*\}/\.\."}) {
            s{="\$\{BASH_SOURCE\[0\]%/\*\}"}{="\${BASH_SOURCE[0]%/*}/.."};
        }
    ' "$file"

    after=$(cat "$file")
    if [[ "$before" != "$after" ]]; then
        echo "[FIX-DEF] $file"
        fix1=$((fix1 + 1))
    fi
done
echo "Fixed $fix1 definitions"

# Phase 2: Fix all source references to bare filenames
echo ""
echo "--- Phase 2: Fix source refs ---"

PERL_SCRIPT='
my %map = (
    "exit-codes.sh" => "core", "error-json.sh" => "core", "output-format.sh" => "core",
    "logging.sh" => "core", "config.sh" => "core", "paths.sh" => "core",
    "platform-compat.sh" => "core", "version.sh" => "core", "json-output.sh" => "core",
    "jq-helpers.sh" => "core", "sequence.sh" => "core",
    "validation.sh" => "validation", "protocol-validation.sh" => "validation",
    "protocol-validation-common.sh" => "validation", "compliance-check.sh" => "validation",
    "manifest-validation.sh" => "validation", "verification.sh" => "validation",
    "doctor-checks.sh" => "validation", "doctor-project-cache.sh" => "validation",
    "doctor-utils.sh" => "validation", "gap-check.sh" => "validation", "docs-sync.sh" => "validation",
    "sessions.sh" => "session", "session-enforcement.sh" => "session",
    "session-migration.sh" => "session", "context-alert.sh" => "session",
    "context-monitor.sh" => "session", "statusline-setup.sh" => "session",
    "lock-detection.sh" => "session", "hitl-warnings.sh" => "session",
    "task-mutate.sh" => "tasks", "dependency-check.sh" => "tasks",
    "hierarchy.sh" => "tasks", "phase-tracking.sh" => "tasks", "analysis.sh" => "tasks",
    "staleness.sh" => "tasks", "size-weighting.sh" => "tasks", "crossref-extract.sh" => "tasks",
    "graph-cache.sh" => "tasks", "graph-ops.sh" => "tasks", "graph-rag.sh" => "tasks",
    "cancel-ops.sh" => "tasks", "archive-cancel.sh" => "tasks", "delete-preview.sh" => "tasks",
    "deletion-strategy.sh" => "tasks", "todowrite-integration.sh" => "tasks", "lifecycle.sh" => "tasks",
    "skill-discovery.sh" => "skills", "skill-dispatch.sh" => "skills", "skill-validate.sh" => "skills",
    "skills-install.sh" => "skills", "skills-version.sh" => "skills", "skillsmp.sh" => "skills",
    "agent-config.sh" => "skills", "agent-registry.sh" => "skills", "agents-install.sh" => "skills",
    "orchestrator-spawn.sh" => "skills", "orchestrator-startup.sh" => "skills",
    "orchestrator-validator.sh" => "skills", "subagent-inject.sh" => "skills",
    "token-inject.sh" => "skills", "contribution-protocol.sh" => "skills",
    "research-manifest.sh" => "skills", "test-utility.sh" => "skills",
    "file-ops.sh" => "data", "atomic-write.sh" => "data", "backup.sh" => "data",
    "cache.sh" => "data", "migrate.sh" => "data", "nexus-deps.sh" => "data",
    "nexus-permissions.sh" => "data", "nexus-query.sh" => "data", "nexus-registry.sh" => "data",
    "git-checkpoint.sh" => "data", "import-logging.sh" => "data", "import-remap.sh" => "data",
    "import-sort.sh" => "data", "export.sh" => "data", "project-detect.sh" => "data",
    "project-registry.sh" => "data", "files-detect.sh" => "data",
    "flags.sh" => "ui", "command-registry.sh" => "ui", "claude-aliases.sh" => "ui",
    "injection.sh" => "ui", "injection-config.sh" => "ui", "injection-registry.sh" => "ui",
    "changelog.sh" => "ui", "mcp-config.sh" => "ui", "version-check.sh" => "ui",
    "metrics-aggregation.sh" => "metrics", "metrics-common.sh" => "metrics",
    "metrics-enums.sh" => "metrics", "otel-integration.sh" => "metrics",
    "token-estimation.sh" => "metrics", "ab-test.sh" => "metrics",
    "release.sh" => "release", "release-config.sh" => "release", "release-artifacts.sh" => "release",
    "release-ci.sh" => "release", "release-provenance.sh" => "release",
);

my @fnames = sort { length($b) <=> length($a) } keys %map;

for my $fname (@fnames) {
    my $subdir = $map{$fname};
    # Match: /filename.sh that is NOT preceded by /subdir/
    # This catches $VAR/filename.sh, ${VAR}/filename.sh, DIR/filename.sh etc.
    # Use negative lookbehind for the correct subdir
    s{/(?:(?:core|validation|session|tasks|skills|data|ui|metrics|release)/)?\Q$fname\E(?=["\s;)])}{/$subdir/$fname}g
        unless m{/\Q$subdir\E/\Q$fname\E};
}
'

fix2=0
for file in lib/{core,validation,session,tasks,skills,data,ui,metrics,release}/*.sh; do
    [[ -f "$file" ]] || continue
    before=$(cat "$file")
    perl -pi -e "$PERL_SCRIPT" "$file"
    after=$(cat "$file")
    if [[ "$before" != "$after" ]]; then
        echo "[FIX-REF] $file"
        fix2=$((fix2 + 1))
    fi
done
echo "Fixed $fix2 refs"
echo ""
echo "Total: $((fix1 + fix2)) fixes"

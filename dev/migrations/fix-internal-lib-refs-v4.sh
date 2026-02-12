#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PROJECT_ROOT"

echo "=== Phase 1: Fix %/* pattern _LIB_DIR definitions ==="

# Fix files using: _XX_LIB_DIR="${BASH_SOURCE[0]%/*}"
# Change to: _XX_LIB_DIR="${BASH_SOURCE[0]%/*}/.."
# This makes the var point to lib/ instead of lib/subdir/

fix_count=0
for file in lib/{core,validation,session,tasks,skills,data,ui,metrics,release}/*.sh; do
    [[ -f "$file" ]] || continue

    if grep -q 'LIB_DIR="${BASH_SOURCE\[0\]%/\*}"' "$file" 2>/dev/null; then
        # Check if already fixed (has /.." at end)
        if grep 'LIB_DIR="${BASH_SOURCE\[0\]%/\*}"' "$file" | grep -qv '/\.\."' 2>/dev/null; then
            perl -pi -e 's|LIB_DIR="\$\{BASH_SOURCE\[0\]%/\*\}"|LIB_DIR="\${BASH_SOURCE[0]%/*}/.."|g' "$file"
            echo "[FIX-DEF] $file"
            fix_count=$((fix_count + 1))
        fi
    fi
done

echo "Fixed $fix_count _LIB_DIR definitions"
echo ""

echo "=== Phase 2: Fix remaining bare filename refs ==="

# Re-run the perl fix for any remaining bare references
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
    s{LIB_DIR/(?!\Q$subdir\E/)\Q$fname\E}{LIB_DIR/$subdir/$fname}g;
}
'

fix_count2=0
for file in lib/{core,validation,session,tasks,skills,data,ui,metrics,release}/*.sh; do
    [[ -f "$file" ]] || continue
    before=$(cat "$file")
    perl -pi -e "$PERL_SCRIPT" "$file"
    after=$(cat "$file")
    if [[ "$before" != "$after" ]]; then
        echo "[FIX-REF] $file"
        fix_count2=$((fix_count2 + 1))
    fi
done

echo "Fixed $fix_count2 files with ref updates"
echo ""
echo "=== Phase 3: Also fix local lib_dir patterns ==="

# Some files have local variables like: local lib_dir="${BASH_SOURCE[0]%/*}"
# These also need fixing
fix_count3=0
for file in lib/{core,validation,session,tasks,skills,data,ui,metrics,release}/*.sh; do
    [[ -f "$file" ]] || continue
    if grep -q 'local lib_dir="${BASH_SOURCE\[0\]%/\*}"' "$file" 2>/dev/null; then
        perl -pi -e 's|local lib_dir="\$\{BASH_SOURCE\[0\]%/\*\}"|local lib_dir="\${BASH_SOURCE[0]%/*}/.."|g' "$file"
        echo "[FIX-LOCAL] $file"
        fix_count3=$((fix_count3 + 1))
    fi
    if grep -q 'local script_dir="${BASH_SOURCE\[0\]%/\*}"' "$file" 2>/dev/null; then
        perl -pi -e 's|local script_dir="\$\{BASH_SOURCE\[0\]%/\*\}"|local script_dir="\${BASH_SOURCE[0]%/*}/.."|g' "$file"
        echo "[FIX-LOCAL] $file"
        fix_count3=$((fix_count3 + 1))
    fi
done

echo "Fixed $fix_count3 local lib_dir patterns"
echo ""
echo "Total: $((fix_count + fix_count2 + fix_count3)) fixes"

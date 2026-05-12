#!/usr/bin/env bash
# T1757 Cleanup Script — REQUIRES OWNER APPROVAL before execution
# Generated: 2026-05-04
# DO NOT EXECUTE without explicit owner approval of errant-refactor-investigation.md

set -euo pipefail

REPO_ROOT="/mnt/projects/cleocode"
BACKUP_DIR="$REPO_ROOT/.cleo/backups"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

echo "=== T1757 Cleanup Script ==="
echo "Timestamp: $TIMESTAMP"

# ============================================================
# ACTION 1: Backup + delete errant packages/core/packages/core/
# ============================================================
echo ""
echo "--- ACTION 1: Backup errant packages/core/packages/core/ ---"
mkdir -p "$BACKUP_DIR"
tar czf "$BACKUP_DIR/errant-core-nested-$TIMESTAMP.tar.gz" \
    -C "$REPO_ROOT" \
    packages/core/packages/
echo "Backup written: $BACKUP_DIR/errant-core-nested-$TIMESTAMP.tar.gz"
rm -rf "$REPO_ROOT/packages/core/packages/"
echo "Deleted: packages/core/packages/"

# ============================================================
# ACTION 2: Commit ct-council skill to git
# ============================================================
echo ""
echo "--- ACTION 2: Commit ct-council skill files to git ---"
cd "$REPO_ROOT"

# Stage only committed-content files (respecting .gitignore)
git add \
    packages/skills/skills/ct-council/.gitignore \
    packages/skills/skills/ct-council/SKILL.md \
    packages/skills/skills/ct-council/references/ \
    packages/skills/skills/ct-council/scripts/ \
    packages/skills/skills/ct-council/optimization/HARDENING-PLAYBOOK.md \
    packages/skills/skills/ct-council/optimization/README.md \
    packages/skills/skills/ct-council/optimization/scenarios.yaml \
    packages/skills/skills/ct-council/optimization/scripts/campaign.py \
    packages/skills/skills/ct-council/optimization/scripts/test_campaign.py \
    packages/skills/skills/ct-council/optimization/.gitignore

git commit -m "feat(skills/ct-council): add ct-council skill — council review workflow

The Council skill was created 2026-04-24 during the T1406 session
but was never committed. Discovered untracked during T1757 investigation.

Adds 5-advisor peer-review Council workflow with:
- SKILL.md (23KB) -- full skill specification
- references/ -- 8 advisor persona files (contrarian, executor, etc.)
- scripts/ -- Python runtime (run_council.py, validate.py, telemetry.py, etc.)
- optimization/ -- hardening playbook + campaign manager scripts

Runtime artifacts (.runs/, .cleo/, campaigns/) excluded via .gitignore.

Closes T1757 cleanup phase 1 (commit missing skill)"

echo "ct-council committed."

# ============================================================
# VERIFICATION
# ============================================================
echo ""
echo "--- VERIFICATION ---"
echo "Checking errant dir is gone:"
ls "$REPO_ROOT/packages/core/packages/" 2>/dev/null && echo "FAIL: still exists" || echo "OK: removed"
echo "Checking ct-council is tracked:"
git ls-files packages/skills/skills/ct-council/SKILL.md | grep -q SKILL.md && echo "OK: tracked" || echo "FAIL: not tracked"
echo "pnpm workspace phantom check (expect exactly 1 @cleocode/core):"
COUNT=$(pnpm list --recursive --depth 0 2>/dev/null | grep -c "@cleocode/core@" || true)
echo "Found $COUNT @cleocode/core entries (expected: 1)"

echo ""
echo "=== Cleanup complete. Run 'pnpm run test' to verify no regressions. ==="

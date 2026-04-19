#!/usr/bin/env bash
# scripts/generate-dts-snapshots.sh
#
# Generate per-subpath .d.ts snapshots for all stable @cleocode/core subpaths.
# Snapshots are stored in packages/core/.dts-snapshots/<subpath>.d.ts.snapshot
# (slashes in subpath names are replaced with double-underscores).
#
# Usage:
#   ./scripts/generate-dts-snapshots.sh             # regenerate all snapshots
#   ./scripts/generate-dts-snapshots.sh --check     # compare current vs snapshot (CI mode)
#   ./scripts/generate-dts-snapshots.sh --no-build  # skip the build step (use existing dist/)
#
# CI mode exits 1 if any stable subpath type has changed incompatibly.
# Run this from the repo root OR from packages/core/.
#
# T948 — mirrors the llmtxt subpath contract pattern.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$PACKAGE_DIR/dist"
SNAPSHOT_DIR="$PACKAGE_DIR/.dts-snapshots"

CHECK_MODE=0
SKIP_BUILD=0

for arg in "$@"; do
  case "$arg" in
    --check) CHECK_MODE=1 ;;
    --no-build) SKIP_BUILD=1 ;;
    -h|--help)
      grep '^#' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Stable subpaths — the ones the CI guard enforces.
# Keys are the export-map path suffixes (without leading "./").
# Values are the dist-relative .d.ts entry for that subpath.
#
# Internal / wildcard subpaths (./internal, ./store/*, ./conduit/*, ./*)
# are deliberately NOT snapshotted — they are allowed to change without a
# CalVer month bump.
# ---------------------------------------------------------------------------
declare -A STABLE_SUBPATHS=(
  ["root"]="index.d.ts"
  ["sdk"]="cleo.d.ts"
  ["contracts"]="contracts.d.ts"
  ["tasks"]="tasks/index.d.ts"
  ["memory"]="memory/index.d.ts"
  ["sessions"]="sessions/index.d.ts"
  ["nexus"]="nexus/index.d.ts"
  ["lifecycle"]="lifecycle/index.d.ts"
  ["conduit"]="conduit/index.d.ts"
)

# ---------------------------------------------------------------------------
# Build the package unless --no-build was passed.
# ---------------------------------------------------------------------------
if [[ "$SKIP_BUILD" -eq 0 ]]; then
  echo "Building @cleocode/core..."
  (cd "$PACKAGE_DIR" && pnpm run build >/dev/null 2>&1) \
    || { echo "ERROR: pnpm run build failed in $PACKAGE_DIR" >&2; exit 1; }
fi

if [[ ! -d "$DIST_DIR" ]]; then
  echo "ERROR: $DIST_DIR does not exist." >&2
  echo "       Run 'pnpm --filter @cleocode/core run build' first." >&2
  exit 1
fi

mkdir -p "$SNAPSHOT_DIR"

FAILURES=0
CHANGED=0

for SUBPATH_KEY in "${!STABLE_SUBPATHS[@]}"; do
  DTS_REL="${STABLE_SUBPATHS[$SUBPATH_KEY]}"
  DTS_FILE="$DIST_DIR/$DTS_REL"
  # Replace "/" with "__" for filesystem-safe snapshot name.
  SAFE_KEY="${SUBPATH_KEY//\//__}"
  SNAP_FILE="$SNAPSHOT_DIR/${SAFE_KEY}.d.ts.snapshot"

  if [[ ! -f "$DTS_FILE" ]]; then
    echo "WARNING: $DTS_FILE not found — skipping $SUBPATH_KEY" >&2
    FAILURES=$((FAILURES + 1))
    continue
  fi

  if [[ "$CHECK_MODE" -eq 1 ]]; then
    # ── Check mode: compare current vs snapshot ──────────────────────────
    if [[ ! -f "$SNAP_FILE" ]]; then
      echo "ERROR: No snapshot found for '$SUBPATH_KEY' at $SNAP_FILE" >&2
      echo "       Run './packages/core/scripts/generate-dts-snapshots.sh' on main to generate it." >&2
      FAILURES=$((FAILURES + 1))
      continue
    fi

    if ! diff --unified=3 "$SNAP_FILE" "$DTS_FILE" > "/tmp/core-subpath-diff-${SAFE_KEY}.txt" 2>&1; then
      echo "" >&2
      echo "BREAKING CHANGE DETECTED: stable subpath '$SUBPATH_KEY'" >&2
      echo "  Snapshot: $SNAP_FILE" >&2
      echo "  Current:  $DTS_FILE" >&2
      echo "  Diff:" >&2
      head -80 "/tmp/core-subpath-diff-${SAFE_KEY}.txt" >&2
      echo "" >&2
      FAILURES=$((FAILURES + 1))
    else
      echo "OK: $SUBPATH_KEY"
    fi
  else
    # ── Snapshot mode: copy current .d.ts to snapshot ────────────────────
    if [[ -f "$SNAP_FILE" ]] && diff -q "$SNAP_FILE" "$DTS_FILE" >/dev/null 2>&1; then
      echo "Unchanged: $SUBPATH_KEY"
    else
      cp "$DTS_FILE" "$SNAP_FILE"
      echo "Snapshotted: $SUBPATH_KEY -> ${SNAP_FILE#"$PACKAGE_DIR/"}"
      CHANGED=$((CHANGED + 1))
    fi
  fi
done

if [[ "$CHECK_MODE" -eq 1 ]]; then
  if [[ "$FAILURES" -gt 0 ]]; then
    echo "" >&2
    echo "FAILED: $FAILURES stable subpath(s) have breaking type changes." >&2
    echo "" >&2
    echo "If this change is intentional (requires a CalVer month bump):" >&2
    echo "  1. Update STABILITY.md with the new export list." >&2
    echo "  2. Document the breaking change in CHANGELOG.md." >&2
    echo "  3. Run './packages/core/scripts/generate-dts-snapshots.sh' and commit the new snapshots." >&2
    echo "  4. Verify you are targeting a new CalVer month (not a PATCH-only bump)." >&2
    exit 1
  else
    echo ""
    echo "All stable subpath types match their snapshots."
  fi
else
  echo ""
  if [[ "$CHANGED" -gt 0 ]]; then
    echo "Snapshots regenerated in $SNAPSHOT_DIR ($CHANGED changed)."
    echo "Commit the updated snapshot files together with your source changes."
  else
    echo "All snapshots already up-to-date."
  fi
fi

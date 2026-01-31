#!/usr/bin/env bats
# Test suite for changelog operations in release-version.sh

setup() {
    load '../test_helper/common_setup'
    common_setup_per_test

    # Create temp directory
    TEST_TEMP_DIR="$(mktemp -d)"

    # Create test changelog
    TEST_CHANGELOG="${TEST_TEMP_DIR}/CHANGELOG.md"

    # Source only the prepare_changelog function, not the whole script
    # Extract the function definition from the script
    eval "$(sed -n '/^prepare_changelog()/,/^}/p' "$BATS_TEST_DIRNAME/../../dev/release-version.sh")"

    # Also need log functions
    log_step() { echo "[STEP] $*"; }
    log_warn() { echo "[WARN] $*"; }
    log_info() { echo "[INFO] $*"; }
}

# Teardown
teardown() {
    rm -rf "$TEST_TEMP_DIR"
}

@test "prepare_changelog does not create duplicate headers" {
    # Create test changelog with existing version
    cat > "$TEST_CHANGELOG" << 'EOF'
# Changelog

## [Unreleased]

## [1.0.0] - 2026-01-31
### Added
- Feature
EOF

    # Run prepare_changelog for same version
    # Should NOT create duplicate
    prepare_changelog "1.0.0" "2026-01-31" "$TEST_CHANGELOG"

    # Count headers - should be exactly 1
    local count=$(grep -c "^## \[1.0.0\]" "$TEST_CHANGELOG")
    [[ "$count" -eq 1 ]]
}

@test "prepare_changelog creates header when version does not exist" {
    # Create test changelog without the version
    cat > "$TEST_CHANGELOG" << 'EOF'
# Changelog

## [Unreleased]

## [0.9.0] - 2026-01-30
### Added
- Old feature
EOF

    # Run prepare_changelog for new version
    prepare_changelog "1.0.0" "2026-01-31" "$TEST_CHANGELOG"

    # Should have new version header
    grep -q "^## \[1.0.0\] - 2026-01-31" "$TEST_CHANGELOG"

    # Should still have unreleased section
    grep -q "^## \[Unreleased\]" "$TEST_CHANGELOG"
}

@test "prepare_changelog skips when no Unreleased section" {
    # Create test changelog without Unreleased
    cat > "$TEST_CHANGELOG" << 'EOF'
# Changelog

## [0.9.0] - 2026-01-30
### Added
- Feature
EOF

    # Should return 0 but not create header
    prepare_changelog "1.0.0" "2026-01-31" "$TEST_CHANGELOG"

    # Should NOT have new version
    ! grep -q "^## \[1.0.0\]" "$TEST_CHANGELOG"
}

@test "prepare_changelog preserves changelog structure" {
    # Create test changelog
    cat > "$TEST_CHANGELOG" << 'EOF'
# Changelog

All notable changes documented here.

## [Unreleased]

## [0.9.0] - 2026-01-30
### Added
- Feature
EOF

    # Run prepare_changelog
    prepare_changelog "1.0.0" "2026-01-31" "$TEST_CHANGELOG"

    # Check structure preserved
    grep -q "^# Changelog" "$TEST_CHANGELOG"
    grep -q "^All notable changes documented here." "$TEST_CHANGELOG"
    grep -q "^## \[Unreleased\]" "$TEST_CHANGELOG"
    grep -q "^## \[1.0.0\] - 2026-01-31" "$TEST_CHANGELOG"
    grep -q "^## \[0.9.0\] - 2026-01-30" "$TEST_CHANGELOG"
}

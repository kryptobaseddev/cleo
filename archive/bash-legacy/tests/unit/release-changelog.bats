#!/usr/bin/env bats
# Test suite for changelog operations in release-version.sh

setup() {
    load '../test_helper/common_setup'
    common_setup_per_test

    # Create temp directory
    TEST_TEMP_DIR="$(mktemp -d)"

    # Create test changelog
    TEST_CHANGELOG="${TEST_TEMP_DIR}/CHANGELOG.md"

    # Source lib/release/release.sh which contains prepare_changelog_header
    source "$BATS_TEST_DIRNAME/../../lib/release/release.sh"
}

# Teardown
teardown() {
    rm -rf "$TEST_TEMP_DIR"
}

@test "prepare_changelog_header does not create duplicate headers" {
    # Create test changelog with existing version
    cat > "$TEST_CHANGELOG" << 'EOF'
# Changelog

## [Unreleased]

## [1.0.0] - 2026-01-31
### Added
- Feature
EOF

    # Run prepare_changelog_header for same version
    # Should NOT create duplicate
    prepare_changelog_header "1.0.0" "2026-01-31" "$TEST_CHANGELOG"

    # Count headers - should be exactly 1
    local count=$(grep -c "^## \[1.0.0\]" "$TEST_CHANGELOG")
    [[ "$count" -eq 1 ]]
}

@test "prepare_changelog_header creates header when version does not exist" {
    # Create test changelog without the version
    cat > "$TEST_CHANGELOG" << 'EOF'
# Changelog

## [Unreleased]

## [0.9.0] - 2026-01-30
### Added
- Old feature
EOF

    # Run prepare_changelog_header for new version
    prepare_changelog_header "1.0.0" "2026-01-31" "$TEST_CHANGELOG"

    # Should have new version header
    grep -q "^## \[1.0.0\] - 2026-01-31" "$TEST_CHANGELOG"

    # Should still have unreleased section
    grep -q "^## \[Unreleased\]" "$TEST_CHANGELOG"
}

@test "prepare_changelog_header skips when no Unreleased section" {
    # Create test changelog without Unreleased
    cat > "$TEST_CHANGELOG" << 'EOF'
# Changelog

## [0.9.0] - 2026-01-30
### Added
- Feature
EOF

    # Should return 0 but not create header
    prepare_changelog_header "1.0.0" "2026-01-31" "$TEST_CHANGELOG"

    # Should NOT have new version
    ! grep -q "^## \[1.0.0\]" "$TEST_CHANGELOG"
}

@test "prepare_changelog_header preserves changelog structure" {
    # Create test changelog
    cat > "$TEST_CHANGELOG" << 'EOF'
# Changelog

All notable changes documented here.

## [Unreleased]

## [0.9.0] - 2026-01-30
### Added
- Feature
EOF

    # Run prepare_changelog_header
    prepare_changelog_header "1.0.0" "2026-01-31" "$TEST_CHANGELOG"

    # Check structure preserved
    grep -q "^# Changelog" "$TEST_CHANGELOG"
    grep -q "^All notable changes documented here." "$TEST_CHANGELOG"
    grep -q "^## \[Unreleased\]" "$TEST_CHANGELOG"
    grep -q "^## \[1.0.0\] - 2026-01-31" "$TEST_CHANGELOG"
    grep -q "^## \[0.9.0\] - 2026-01-30" "$TEST_CHANGELOG"
}

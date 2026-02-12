#!/usr/bin/env bats

# Tests for lib/ui/changelog.sh
# @task T2842 - Auto-generate changelog from conventional commits

# Setup test environment
setup() {
    # Create temporary directory for test repo
    export TEST_REPO_DIR="$(mktemp -d)"
    export ORIGINAL_DIR="$(pwd)"

    # Initialize git repo
    cd "$TEST_REPO_DIR"
    git init --quiet
    git config user.email "test@example.com"
    git config user.name "Test User"

    # Create initial commit (needed for tags)
    echo "initial" > README.md
    git add README.md
    git commit -m "chore: Initial commit" --quiet

    # Source the changelog library
    source "${ORIGINAL_DIR}/lib/ui/changelog.sh"
}

teardown() {
    cd "$ORIGINAL_DIR"
    rm -rf "$TEST_REPO_DIR"
}

# Helper to create a commit
create_commit() {
    local message="$1"
    echo "test" >> file.txt
    git add file.txt
    git commit -m "$message" --quiet
}

# Helper to create a tag
create_tag() {
    local tag="$1"
    git tag "$tag"
}

@test "generate_changelog_from_commits: parses feat commits" {
    create_commit "feat: Add new feature"
    create_commit "feat(api): Add REST endpoint"

    run generate_changelog_from_commits "HEAD~2" "HEAD"
    [ "$status" -eq 0 ]
    [[ "$output" == *"### Features"* ]]
    [[ "$output" == *"- Add new feature"* ]]
    [[ "$output" == *"- **api**: Add REST endpoint"* ]]
}

@test "generate_changelog_from_commits: parses fix commits" {
    create_commit "fix: Correct bug in validation"
    create_commit "fix(auth): Handle expired tokens"

    run generate_changelog_from_commits "HEAD~2" "HEAD"
    [ "$status" -eq 0 ]
    [[ "$output" == *"### Bug Fixes"* ]]
    [[ "$output" == *"- Correct bug in validation"* ]]
    [[ "$output" == *"- **auth**: Handle expired tokens"* ]]
}

@test "generate_changelog_from_commits: extracts task IDs" {
    create_commit "feat: Add new feature (T1234)"
    create_commit "fix(auth): Handle tokens (T5678)"

    run generate_changelog_from_commits "HEAD~2" "HEAD"
    [ "$status" -eq 0 ]
    [[ "$output" == *"- Add new feature (T1234)"* ]]
    [[ "$output" == *"- **auth**: Handle tokens (T5678)"* ]]
}

@test "generate_changelog_from_commits: extracts multiple task IDs" {
    create_commit "feat: Implement feature (T1001) (T1002)"

    run generate_changelog_from_commits "HEAD~1" "HEAD"
    [ "$status" -eq 0 ]
    [[ "$output" == *"(T1001,T1002)"* ]]
}

@test "generate_changelog_from_commits: groups by type" {
    create_commit "feat: Add feature"
    create_commit "fix: Fix bug"
    create_commit "docs: Update docs"
    create_commit "refactor: Refactor code"

    run generate_changelog_from_commits "HEAD~4" "HEAD"
    [ "$status" -eq 0 ]
    [[ "$output" == *"### Features"* ]]
    [[ "$output" == *"### Bug Fixes"* ]]
    [[ "$output" == *"### Documentation"* ]]
    [[ "$output" == *"### Refactoring"* ]]
}

@test "generate_changelog_from_commits: handles docs commits" {
    create_commit "docs: Update README"
    create_commit "docs(api): Add API documentation"

    run generate_changelog_from_commits "HEAD~2" "HEAD"
    [ "$status" -eq 0 ]
    [[ "$output" == *"### Documentation"* ]]
    [[ "$output" == *"- Update README"* ]]
    [[ "$output" == *"- **api**: Add API documentation"* ]]
}

@test "generate_changelog_from_commits: handles refactor commits" {
    create_commit "refactor: Clean up code"
    create_commit "refactor(core): Simplify logic"

    run generate_changelog_from_commits "HEAD~2" "HEAD"
    [ "$status" -eq 0 ]
    [[ "$output" == *"### Refactoring"* ]]
    [[ "$output" == *"- Clean up code"* ]]
    [[ "$output" == *"- **core**: Simplify logic"* ]]
}

@test "generate_changelog_from_commits: handles test commits" {
    create_commit "test: Add unit tests"
    create_commit "test(integration): Add integration tests"

    run generate_changelog_from_commits "HEAD~2" "HEAD"
    [ "$status" -eq 0 ]
    [[ "$output" == *"### Tests"* ]]
    [[ "$output" == *"- Add unit tests"* ]]
    [[ "$output" == *"- **integration**: Add integration tests"* ]]
}

@test "generate_changelog_from_commits: handles chore commits" {
    create_commit "chore: Update dependencies"
    create_commit "chore(build): Configure CI"

    run generate_changelog_from_commits "HEAD~2" "HEAD"
    [ "$status" -eq 0 ]
    [[ "$output" == *"### Other Changes"* ]]
    [[ "$output" == *"- Update dependencies"* ]]
    [[ "$output" == *"- **build**: Configure CI"* ]]
}

@test "generate_changelog_from_commits: uses last tag by default" {
    create_commit "feat: Before tag"
    create_tag "v0.1.0"
    create_commit "feat: After tag (T1234)"

    run generate_changelog_from_commits "last-tag" "HEAD"
    [ "$status" -eq 0 ]
    [[ "$output" == *"- After tag (T1234)"* ]]
    [[ "$output" != *"Before tag"* ]]
}

@test "generate_changelog_from_commits: handles no tags gracefully" {
    # Remove the initial commit tag if any
    create_commit "feat: First commit"
    create_commit "fix: Second commit"

    run generate_changelog_from_commits "last-tag" "HEAD"
    [ "$status" -eq 0 ]
    [[ "$output" == *"### Features"* ]]
    [[ "$output" == *"### Bug Fixes"* ]]
}

@test "generate_changelog_from_commits: handles empty range" {
    create_tag "v0.1.0"

    # No new commits since tag
    run generate_changelog_from_commits "last-tag" "HEAD"
    [ "$status" -eq 0 ]
}

@test "generate_changelog_from_commits: handles breaking changes" {
    create_commit "breaking: Remove deprecated API"
    create_commit "breaking(auth): Change authentication flow"

    run generate_changelog_from_commits "HEAD~2" "HEAD"
    [ "$status" -eq 0 ]
    [[ "$output" == *"### Breaking Changes"* ]]
    [[ "$output" == *"- Remove deprecated API"* ]]
    [[ "$output" == *"- **auth**: Change authentication flow"* ]]
}

@test "generate_changelog_from_commits: breaking changes appear first" {
    create_commit "feat: New feature"
    create_commit "breaking: Breaking change"
    create_commit "fix: Bug fix"

    run generate_changelog_from_commits "HEAD~3" "HEAD"
    [ "$status" -eq 0 ]

    # Extract first section header
    first_section=$(echo "$output" | grep "^###" | head -1)
    [[ "$first_section" == "### Breaking Changes" ]]
}

@test "generate_changelog_from_commits: real-world example" {
    create_tag "v0.77.2"
    create_commit "fix(tests): Add schemaVersion to test fixture (T2820)"
    create_commit "feat(orchestrator): Add TaskOutput prohibition (T2832)"
    create_commit "fix(schema): Sync config schema version (T2841)"
    create_commit "docs(changelog): Add v0.77.2 release notes"

    run generate_changelog_from_commits "last-tag" "HEAD"
    [ "$status" -eq 0 ]

    [[ "$output" == *"### Features"* ]]
    [[ "$output" == *"- **orchestrator**: Add TaskOutput prohibition (T2832)"* ]]

    [[ "$output" == *"### Bug Fixes"* ]]
    [[ "$output" == *"- **tests**: Add schemaVersion to test fixture (T2820)"* ]]
    [[ "$output" == *"- **schema**: Sync config schema version (T2841)"* ]]

    [[ "$output" == *"### Documentation"* ]]
    [[ "$output" == *"- **changelog**: Add v0.77.2 release notes"* ]]
}

@test "generate_changelog_from_commits: handles commits without conventional format" {
    create_commit "Random commit message"
    create_commit "feat: Valid feature"

    run generate_changelog_from_commits "HEAD~2" "HEAD"
    [ "$status" -eq 0 ]
    # Should only include conventionally formatted commits
    [[ "$output" == *"### Features"* ]]
    [[ "$output" == *"- Valid feature"* ]]
}

@test "generate_changelog_from_commits: handles scope with special characters" {
    create_commit "feat(my-scope): Feature with dashed scope"

    run generate_changelog_from_commits "HEAD~1" "HEAD"
    [ "$status" -eq 0 ]
    [[ "$output" == *"- **my-scope**: Feature with dashed scope"* ]]
}

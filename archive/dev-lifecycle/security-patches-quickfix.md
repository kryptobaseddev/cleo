# Security Patches - Quick Fix Guide

**Priority**: CRITICAL
**Estimated Time**: 3 hours
**Target**: Address blocking production issues

---

## Patch 1: Fix Command Injection (CVE-CLAUDE-2025-001)

### Files to Modify
- `scripts/blockers-command.sh`
- `scripts/deps-command.sh`

### Changes Required

#### blockers-command.sh:168
```bash
# BEFORE (VULNERABLE)
if echo "$visited" | grep -q "$task_id"; then
    echo "[]"
    return
fi

# AFTER (SAFE)
if [[ "$visited" == *"$task_id"* ]]; then
    echo "[]"
    return
fi
```

#### blockers-command.sh:230
```bash
# BEFORE (VULNERABLE)
if echo "$visited" | grep -q "$task_id"; then
    echo "0"
    return
fi

# AFTER (SAFE)
if [[ "$visited" == *"$task_id"* ]]; then
    echo "0"
    return
fi
```

#### deps-command.sh:168
```bash
# BEFORE (VULNERABLE)
if echo "$visited" | grep -q "$task_id"; then
    echo "[]"
    return
fi

# AFTER (SAFE)
if [[ "$visited" == *"$task_id"* ]]; then
    echo "[]"
    return
fi
```

#### deps-command.sh:210
```bash
# BEFORE (VULNERABLE)
if echo "$visited" | grep -q "$task_id"; then
    echo "0"
    return
fi

# AFTER (SAFE)
if [[ "$visited" == *"$task_id"* ]]; then
    echo "0"
    return
fi
```

### Testing
```bash
# Run POC to verify fix
./claudedocs/poc-command-injection.sh

# Expected: "✓ SAFE: No command injection detected"
```

---

## Patch 2: Fix Temp File Race Condition (CVE-CLAUDE-2025-002)

### Files to Modify
- `scripts/blockers-command.sh`

### Changes Required

#### blockers-command.sh:388-413
```bash
# BEFORE (VULNERABLE)
echo "$blocked_tasks" | jq -c '.[]' | while IFS= read -r task; do
    local id
    id=$(echo "$task" | jq -r '.id')

    # ... analysis code ...

    echo "$task" | jq --argjson depth "$chain_depth" \
      --argjson impact "$impact_count" \
      --argjson chain "$chain" \
      '. + {
        chainDepth: $depth,
        impactCount: $impact,
        blockingChain: $chain
      }'
done | jq -s '.' > /tmp/blockers_analysis.json

analysis=$(cat /tmp/blockers_analysis.json)
rm -f /tmp/blockers_analysis.json

# AFTER (SAFE)
# Create secure temp file with trap cleanup
local temp_file
temp_file=$(mktemp "${TMPDIR:-/tmp}/blockers-analysis.XXXXXX") || {
    log_error "Failed to create temporary file"
    exit 1
}
trap 'rm -f "$temp_file"' EXIT RETURN

echo "$blocked_tasks" | jq -c '.[]' | while IFS= read -r task; do
    local id
    id=$(echo "$task" | jq -r '.id')

    # ... analysis code (unchanged) ...

    echo "$task" | jq --argjson depth "$chain_depth" \
      --argjson impact "$impact_count" \
      --argjson chain "$chain" \
      '. + {
        chainDepth: $depth,
        impactCount: $impact,
        blockingChain: $chain
      }'
done | jq -s '.' > "$temp_file"

analysis=$(cat "$temp_file")
# Cleanup handled by trap
```

### Additional Hardening
```bash
# At top of analyze_blocking_chains function (after line 369)
# Add trap for cleanup
local temp_file
temp_file=$(mktemp "${TMPDIR:-/tmp}/blockers-analysis.XXXXXX") || {
    log_error "Failed to create temporary file"
    return 1
}
trap 'rm -f "$temp_file"' RETURN
```

### Testing
```bash
# Run POC to verify fix
./claudedocs/poc-race-condition.sh

# Expected: No symlink attack possible
# Check: ls -la /tmp/blockers* should show no predictable files
```

---

## Patch 3: Add Recursion Depth Limits (VULN-002)

### Files to Modify
- `lib/analysis.sh`
- `scripts/blockers-command.sh`

### Changes Required

#### lib/analysis.sh:110-151
```bash
# Add constant at top of file (around line 26)
readonly MAX_RECURSION_DEPTH=100

# BEFORE
find_longest_path_from() {
    local task_id="$1"
    local dep_graph="$2"
    local visited="$3"

# AFTER
find_longest_path_from() {
    local task_id="$1"
    local dep_graph="$2"
    local visited="$3"
    local depth="${4:-0}"  # Add depth parameter

    # Check recursion limit
    if [[ $depth -ge $MAX_RECURSION_DEPTH ]]; then
        echo "WARNING: Maximum recursion depth ($MAX_RECURSION_DEPTH) exceeded" >&2
        echo "0"
        return 1
    fi

# Update recursive call (line 143)
# BEFORE
path_length=$(find_longest_path_from "$dep_id" "$dep_graph" "$new_visited")

# AFTER
path_length=$(find_longest_path_from "$dep_id" "$dep_graph" "$new_visited" "$((depth + 1))")
```

#### scripts/blockers-command.sh:203-239
```bash
# Add constant at top of file (around line 60)
readonly MAX_RECURSION_DEPTH=100

# BEFORE
calculate_chain_depth() {
    local task_id="$1"
    local visited="${2:-}"
    local max_depth=0

# AFTER
calculate_chain_depth() {
    local task_id="$1"
    local visited="${2:-}"
    local depth="${3:-0}"
    local max_depth=0

    # Check recursion limit
    if [[ $depth -ge $MAX_RECURSION_DEPTH ]]; then
        echo "WARNING: Maximum recursion depth exceeded" >&2
        echo "0"
        return 1
    fi

# Update recursive call (line 233)
# BEFORE
depth=$(calculate_chain_depth "$dep_id" "$new_visited")

# AFTER
depth=$(calculate_chain_depth "$dep_id" "$new_visited" "$((depth + 1))")
```

### Testing
```bash
# Run POC to verify fix
./claudedocs/poc-stack-exhaustion.sh

# Expected: Recursion stops at depth 100
# No stack overflow or bash recursion errors
```

---

## Verification Script

Create test script to verify all patches:

```bash
#!/usr/bin/env bash
# verify-security-patches.sh

echo "=== Security Patch Verification ==="
echo ""

# Test 1: Command Injection
echo "[1] Testing command injection fix..."
./claudedocs/poc-command-injection.sh | grep -q "SAFE" && echo "  ✓ PASS" || echo "  ✗ FAIL"

# Test 2: Race Condition
echo "[2] Testing temp file fix..."
./claudedocs/poc-race-condition.sh | grep -q "secure temp file" && echo "  ✓ PASS" || echo "  ✗ FAIL"

# Test 3: Stack Exhaustion
echo "[3] Testing recursion limit..."
./claudedocs/poc-stack-exhaustion.sh | grep -q "Max depth" && echo "  ✓ PASS" || echo "  ✗ FAIL"

echo ""
echo "=== Verification Complete ==="
```

---

## Deployment Checklist

- [ ] Apply Patch 1 (Command Injection)
- [ ] Apply Patch 2 (Race Condition)
- [ ] Apply Patch 3 (Recursion Limit)
- [ ] Run all POC scripts to verify fixes
- [ ] Run existing test suite
- [ ] Code review by second engineer
- [ ] Update CHANGELOG.md with security fixes
- [ ] Tag release with security patch version
- [ ] Deploy to production

---

## Post-Deployment

### Monitoring
- Monitor for recursion depth warnings in logs
- Check for temp file creation failures
- Watch for command injection attempts

### Documentation
- Update security documentation
- Add to known vulnerabilities list (with fix version)
- Include in security training materials

---

## Emergency Rollback

If patches cause issues:

```bash
# Rollback to previous version
git checkout <previous-commit>

# Or revert specific patches
git revert <patch-commit-hash>
```

---

## Additional Resources

- Full Audit Report: `claudedocs/phase3-security-audit-report.md`
- POC Scripts: `claudedocs/poc-*.sh`
- Security Summary: `claudedocs/SECURITY-AUDIT-SUMMARY.md`

---

**Time Estimate**: 3 hours for critical patches (1 + 2)
**Extended**: 7 hours including high-priority patch (3)
**Recommended**: Apply all three patches before production deployment

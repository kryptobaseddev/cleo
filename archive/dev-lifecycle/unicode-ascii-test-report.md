# Unicode and ASCII Fallback Test Report

**Test Date**: 2025-12-12
**Tester**: Quality Engineer Agent
**Version**: 0.8.0

## Executive Summary

**Overall Status**: ⚠️ PARTIAL PASS with CRITICAL ISSUES

Unicode rendering works correctly, but ASCII fallback has **inconsistent behavior** across commands. The `dash` command respects `LANG=C` correctly, but `list` and `labels` commands ignore locale settings.

---

## Test 1: Unicode Output (Default)

### Status: ✅ PASS

**Test Command**: `claude-todo dash | head -5`

**Expected**: Unicode box-drawing characters (╭ ╮ ─ │ ╰ ╯) and symbols (○ ◉ ⊗ ✓)

**Actual Output**:
```
╭───────────────────────────────────────────────────────────────╮
│    PROJECT DASHBOARD                                          │
│    claude-todo                                                │
│    Last updated: 2025-12-12 19:48:55                          │
│───────────────────────────────────────────────────────────────│
```

**Result**: Unicode characters render correctly:
- Box corners: ╭ ╮ ╰ ╯ (U+256D, U+256E, U+2570, U+256F)
- Horizontal: ─ (U+2500)
- Vertical: │ (U+2502)

**Verification**: Byte sequence analysis confirms proper UTF-8 encoding (342 225 255 = ╭, 342 224 200 = ─)

---

## Test 2: Progress Bars

### Status: ✅ PASS

**Test Command**: `claude-todo dash | grep -E '█|░'`

**Expected**: Unicode block characters (█ filled, ░ empty)

**Actual Output**:
```
│    Core Devel.. [███████░░░░░]  60% 6/10                      │
│    Polish & L.. [░░░░░░░░░░░░]   0% 0/5                       │
```

**Result**: Progress bars render correctly:
- Filled blocks: █ (U+2588 FULL BLOCK)
- Empty blocks: ░ (U+2591 LIGHT SHADE)
- Percentage calculation: Accurate

**Verification**: Byte sequence shows proper Unicode (342 226 210 = █, 342 226 221 = ░)

---

## Test 3: Status Symbols

### Status: ✅ PASS

**Test Command**: `claude-todo list --status pending --status active`

**Expected**: ○ ◉ ⊗ ✓ for pending/active/blocked/done

**Actual Output**:
```
○ 10 pending  ◉ 0 active  ⊗ 0 blocked  ✓ 0 done
```

**Result**: All status symbols render correctly

---

## Test 4: Priority Symbols

### Status: ✅ PASS

**Test Command**: `claude-todo list --priority high`

**Expected**: 🔴 🟡 🔵 ⚪ emoji circles

**Actual Output**:
```
🔴 0 critical  🟡 3 high  🔵 0 medium  ⚪ 0 low
```

**Result**: All priority emoji symbols render correctly

---

## Test 5: ASCII Fallback Functions

### Status: ✅ PASS

**Test Method**: Direct function calls with `unicode=false`

| Function | Expected | Actual | Status |
|----------|----------|--------|--------|
| `status_symbol pending false` | `-` | `-` | ✅ |
| `status_symbol active false` | `*` | `*` | ✅ |
| `status_symbol blocked false` | `x` | `x` | ✅ |
| `status_symbol done false` | `+` | `+` | ✅ |
| `priority_symbol critical false` | `!` | `!` | ✅ |
| `priority_symbol high false` | `H` | `H` | ✅ |
| `priority_symbol medium false` | `M` | `M` | ✅ |
| `priority_symbol low false` | `L` | `L` | ✅ |

**Result**: All ASCII fallback symbols return correctly when directly invoked

---

## Test 6: ASCII Box Drawing Functions

### Status: ✅ PASS

**Test Method**: Direct function calls with `unicode=false`

| Function | Expected | Actual | Status |
|----------|----------|--------|--------|
| `draw_box TL false` | `+` | `+` | ✅ |
| `draw_box TR false` | `+` | `+` | ✅ |
| `draw_box BL false` | `+` | `+` | ✅ |
| `draw_box BR false` | `+` | `+` | ✅ |
| `draw_box H false` | `-` | `-` | ✅ |
| `draw_box V false` | `|` | `|` | ✅ |

**Result**: All ASCII box-drawing characters return correctly

---

## Test 7: ASCII Progress Bars

### Status: ✅ PASS

**Test Method**: Direct function calls with `unicode=false`

| Test | Expected | Actual | Status |
|------|----------|--------|--------|
| `progress_bar 0 10 20 false` | `[--------------------]   0%` | `[--------------------]   0%` | ✅ |
| `progress_bar 5 10 20 false` | `[==========----------]  50%` | `[==========----------]  50%` | ✅ |
| `progress_bar 10 10 20 false` | `[====================] 100%` | `[====================] 100%` | ✅ |

**Result**: ASCII progress bars use `=` for filled and `-` for empty (correct)

---

## Test 8: ASCII Fallback Integration (`dash` command)

### Status: ✅ PASS

**Test Command**: `LANG=C claude-todo dash | head -15`

**Expected**: ASCII characters (+, -, |) instead of Unicode

**Actual Output**:
```
+---------------------------------------------------------------+
|    PROJECT DASHBOARD                                          |
|    claude-todo                                                |
|    Last updated: 2025-12-12 19:50:27                          |
|---------------------------------------------------------------|
|    CURRENT FOCUS                                              |
|    * [T070] Implement blockers command for blocker analysis   |
|    Note: Test note                                            |
|---------------------------------------------------------------|
|    TASK OVERVIEW                                              |
|    - 8 pending   * 1 active                                   |
|    x 0 blocked   + 16 done                                    |
|    Total: 25 tasks                                            |
|---------------------------------------------------------------|
|    PHASES                                                     |
```

**Result**: `dash` command correctly respects `LANG=C` and uses ASCII fallback:
- Box corners: `+` (correct)
- Horizontal: `-` (correct)
- Vertical: `|` (correct)
- Status symbols: `-`, `*`, `x`, `+` (correct)

---

## Test 9: ASCII Fallback Integration (`list` command)

### Status: ❌ FAIL - CRITICAL

**Test Command**: `LANG=C claude-todo list --status pending | head -10`

**Expected**: ASCII box drawing and symbols

**Actual Output**:
```
╭─────────────────────────────────────────────────────────────────╮
│  📋 TASKS                                                       │
├─────────────────────────────────────────────────────────────────┤
│  🔴 0 critical  🟡 0 high  🔵 5 medium  ⚪ 0 low          │
│  ○ 8 pending  ◉ 0 active  ⊗ 0 blocked  ✓ 0 done          │
╰─────────────────────────────────────────────────────────────────╯
```

**Result**: ❌ **FAILURE** - `list` command IGNORES `LANG=C` and still uses Unicode

**Issue**: The `list-tasks.sh` script does not respect locale settings for Unicode fallback

**Impact**: CRITICAL - Users on non-UTF-8 systems will see broken characters in `list` output

---

## Test 10: ASCII Fallback Integration (`labels` command)

### Status: ✅ PARTIAL PASS

**Test Command**: `LANG=C claude-todo labels | head -10`

**Expected**: ASCII `#` characters instead of Unicode `█` bars

**Actual Output**:
```
Labels (25 unique)

  command         ###############   6 tasks  3 high
  v0.8.0          ############   5 tasks  3 high
  v0.9.0          ############   5 tasks
  v1.0.0          ############   5 tasks
```

**Result**: ✅ Correctly uses `#` for ASCII mode

**Note**: The `labels` command has different bar visualization logic (uses `#` not `=`)

---

## Test 11: Undefined Box Characters

### Status: ✅ PASS (Expected Behavior)

**Test Command**: `source lib/output-format.sh && draw_box SEP false`

**Expected**: `?` (undefined fallback)

**Actual**: `?`

**Result**: Correctly returns `?` for undefined box character types

**Note**: This is expected behavior. The separator character is created by using existing `V` and `H` characters, not a dedicated `SEP` type.

---

## Critical Findings

### 🚨 Issue 1: Inconsistent LANG=C Handling

**Severity**: CRITICAL
**Affected Commands**: `list-tasks.sh`

**Description**: The `list` command does not respect `LANG=C` environment variable and always renders Unicode characters regardless of locale settings.

**Evidence**:
```bash
# dash.sh respects LANG=C
$ LANG=C claude-todo dash
+---------------------------------------------------------------+  # ASCII

# list-tasks.sh IGNORES LANG=C
$ LANG=C claude-todo list
╭─────────────────────────────────────────────────────────────╮  # Unicode
```

**Root Cause**: The `list-tasks.sh` script likely:
1. Calls `detect_unicode_support()` which checks `$LANG` environment variable
2. BUT the detection may be failing or being overridden by configuration
3. OR it's not calling the detection at all and hardcoding `unicode="true"`

**Impact**:
- Users on legacy systems (LANG=C, non-UTF-8 locales) will see garbled output
- SSH sessions without UTF-8 support will break
- CI/CD environments without locale setup will fail

**Recommended Fix**:
```bash
# In list-tasks.sh, ensure Unicode detection is used:
local unicode
detect_unicode_support 2>/dev/null && unicode="true" || unicode="false"

# Verify this pattern is used consistently before all box/symbol rendering
```

---

### ⚠️ Issue 2: Configuration Override Ambiguity

**Severity**: MEDIUM

**Description**: The configuration file can override environment-based Unicode detection:

```bash
# From lib/output-format.sh:143-147
detect_unicode_support() {
  local config_unicode
  config_unicode=$(get_output_config "unicode")
  [[ "$config_unicode" == "false" ]] && return 1  # Config overrides environment
```

**Concern**: If `.claude/todo-config.json` has `"unicodeEnabled": true`, it will override `LANG=C` in the current implementation.

**Priority Order Should Be**:
1. Environment (`LANG=C`) → Force ASCII
2. Configuration setting → User preference when environment supports Unicode
3. Auto-detection → Fallback

**Current Priority**:
1. Configuration setting → Can override environment ❌
2. Environment detection

**Impact**: User sets `LANG=C` but still gets Unicode if config says `"unicodeEnabled": true`

---

### ⚠️ Issue 3: Different Bar Characters in Different Commands

**Severity**: LOW (Cosmetic)

**Description**:
- `progress_bar()` uses `=` for filled, `-` for empty in ASCII mode
- `labels.sh` uses `#` for bars in ASCII mode

**Example**:
```bash
# dash command (using progress_bar)
[==========----------]  50%

# labels command (using different logic)
###############
```

**Recommendation**: Standardize on one character set for consistency:
- Option A: Use `#` everywhere (more visible)
- Option B: Use `=` everywhere (traditional progress bar style)

---

## Recommendations

### High Priority (Fix Before Release)

1. **Fix `list-tasks.sh` Unicode detection** (CRITICAL)
   - Ensure it respects `LANG=C` environment variable
   - Add `detect_unicode_support()` call before rendering
   - Test with `LANG=C` to verify ASCII fallback

2. **Fix priority order for Unicode detection** (HIGH)
   - Environment variables should override configuration
   - Update `detect_unicode_support()` function:
     ```bash
     detect_unicode_support() {
       # LANG=C always disables Unicode (highest priority)
       [[ "$LANG" == "C" ]] && return 1
       [[ "$LC_ALL" == "C" ]] && return 1

       # Then check config setting
       local config_unicode
       config_unicode=$(get_output_config "unicode")
       [[ "$config_unicode" == "false" ]] && return 1

       # Finally auto-detect
       [[ "${LANG:-}" =~ UTF-8 ]] || [[ "${LC_ALL:-}" =~ UTF-8 ]]
     }
     ```

### Medium Priority (Quality of Life)

3. **Standardize ASCII bar characters** (MEDIUM)
   - Choose one character set (`#` or `=`) for all progress bars
   - Update documentation to reflect chosen standard

4. **Add integration tests** (MEDIUM)
   - Test suite with `LANG=C` for all commands
   - Verify ASCII fallback in CI environment

### Low Priority (Documentation)

5. **Document Unicode fallback behavior** (LOW)
   - Add section to README about Unicode/ASCII modes
   - Document priority order (env > config > auto-detect)
   - Provide troubleshooting guide for broken characters

---

## Test Coverage Summary

| Test Area | Tests | Pass | Fail | Coverage |
|-----------|-------|------|------|----------|
| Unicode rendering | 4 | 4 | 0 | 100% |
| ASCII functions | 3 | 3 | 0 | 100% |
| ASCII integration | 3 | 2 | 1 | 66% |
| **Total** | **10** | **9** | **1** | **90%** |

---

## Conclusion

The Unicode and ASCII fallback system is **well-designed at the function level** but has **critical integration issues**:

✅ **Strengths**:
- Comprehensive Unicode support with proper UTF-8 encoding
- Complete ASCII fallback functions work correctly
- `dash` command demonstrates correct integration pattern

❌ **Critical Issues**:
- `list` command does not respect `LANG=C` (breaking for non-UTF-8 users)
- Configuration priority may override environment settings incorrectly

⚠️ **Terminal Compatibility Verdict**:
**NOT PRODUCTION READY** until `list-tasks.sh` is fixed to respect locale settings.

**Recommended Action**: Block release until Issue #1 is resolved. This affects core functionality for users on legacy systems, SSH sessions, and CI/CD environments.

# Claude-TODO Library Architecture Specification

**Version**: 1.0.0
**Status**: DRAFT
**Effective**: v0.33.0+
**Last Updated**: 2025-12-23

---

## RFC 2119 Conformance

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in [BCP 14](https://www.rfc-editor.org/info/bcp14) [[RFC2119](https://www.rfc-editor.org/rfc/rfc2119)] [[RFC8174](https://www.rfc-editor.org/rfc/rfc8174)] when, and only when, they appear in all capitals.

---

## Preamble

This specification defines the architecture, organization, and behavioral contracts for shell libraries in the cleo system. It establishes patterns for dependency management, source guards, layered architecture, and testability that ensure libraries are predictable, maintainable, and LLM-agent-friendly.

**Authority**: This specification is AUTHORITATIVE for all library architecture decisions in cleo.

**Motivation**: Research across mature Bash projects (bats-core, oh-my-bash, asdf-vm), Google's Shell Style Guide, and LLM-agent integration patterns reveals consistent best practices that this specification codifies.

---

## Executive Summary

### Mission Statement

Design shell libraries with **Functional Core, Imperative Shell** architecture: pure functions for deterministic behavior, side effects at boundaries, strict layering to prevent circular dependencies, and source guards to prevent double-loading.

### Core Principles

| Principle | Requirement |
|-----------|-------------|
| **Layered Architecture** | Dependencies flow downward only (Layer 3 → Layer 0) |
| **Source Guards** | All libraries MUST prevent double-loading |
| **Pure Functions** | Validation and transformation logic MUST be deterministic |
| **Namespace Isolation** | Library functions SHOULD use consistent prefixes |
| **Explicit Dependencies** | Libraries MUST declare dependencies at file top |
| **Testability** | Libraries MUST support isolated unit testing |

### Target Metrics

| Metric | Target |
|--------|--------|
| Inter-library dependencies | ≤25 total source statements |
| Max dependencies per library | ≤3 direct dependencies |
| Layer 0 files with dependencies | 0 |
| Circular dependency chains | 0 |

---

## Part 1: Layer Architecture

### 1.1 Four-Layer Model

Libraries MUST be organized into four strict layers where dependencies flow **downward only**.

```
┌─────────────────────────────────────────────────────────────────┐
│ LAYER 3: Domain Logic                                           │
│   High-level feature implementations                            │
│   MAY source: Layers 0, 1, 2                                    │
│   Examples: deletion-strategy.sh, cancel-ops.sh, analysis.sh    │
└─────────────────────────────────────────────────────────────────┘
                              ↓ sources
┌─────────────────────────────────────────────────────────────────┐
│ LAYER 2: Operations                                             │
│   File operations, validation, backup, logging                  │
│   MAY source: Layers 0, 1                                       │
│   Examples: file-ops.sh, validation.sh, backup.sh, logging.sh   │
└─────────────────────────────────────────────────────────────────┘
                              ↓ sources
┌─────────────────────────────────────────────────────────────────┐
│ LAYER 1: Utilities                                              │
│   Configuration, formatting, error handling                     │
│   MAY source: Layer 0 only                                      │
│   Examples: config.sh, error-json.sh, output-format.sh          │
└─────────────────────────────────────────────────────────────────┘
                              ↓ sources
┌─────────────────────────────────────────────────────────────────┐
│ LAYER 0: Foundation                                             │
│   Constants, platform detection, version                        │
│   MUST NOT source any other library                             │
│   Examples: exit-codes.sh, platform-compat.sh, version.sh       │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 Layer Classification

| Layer | Purpose | Max Dependencies | Side Effects |
|-------|---------|------------------|--------------|
| **Layer 0** | Constants, detection | 0 | None |
| **Layer 1** | Utilities, formatting | 1-2 (Layer 0 only) | Minimal |
| **Layer 2** | Core operations | 2-3 (Layers 0-1) | File I/O, logging |
| **Layer 3** | Domain logic | 3 (Layers 0-2) | Full |

### 1.3 Layer Violation Prevention

Libraries MUST NOT:
- Source libraries from a higher layer
- Source libraries from the same layer (extract common code to lower layer), except Foundation Utilities (see Section 1.4)
- Create circular dependency chains

### 1.4 Foundation Utilities Exception

Certain Layer 2 files provide essential infrastructure that other Layer 2 files MAY source despite the same-layer rule in Section 1.3. These "Foundation Utilities" are explicitly exempt:

| File | Purpose | May Be Sourced By |
|------|---------|-------------------|
| `file-ops.sh` | Atomic file operations, JSON helpers | All Layer 2 files |
| `logging.sh` | Audit logging, timestamp utilities | All Layer 2 files |

**Rationale**: These utilities provide fundamental I/O primitives that cannot be reasonably refactored to a lower layer without creating Layer 1 bloat or duplicating code across all Layer 2 consumers.

**Compliance**: The compliance checker (`dev/check-lib-compliance.sh`) implements this exception via the `FOUNDATION_UTILITIES` allowlist.

---

## Part 2: Source Guard Pattern

### 2.1 Guard Requirement

Every library file MUST implement a source guard to prevent double-loading.

**Standard Pattern**:
```bash
[[ -n "${_<LIBNAME>_LOADED:-}" ]] && return 0
declare -r _<LIBNAME>_LOADED=1
```

### 2.2 Guard Naming Convention

| Library File | Guard Variable |
|--------------|----------------|
| `exit-codes.sh` | `_EXIT_CODES_LOADED` |
| `file-ops.sh` | `_FILE_OPS_LOADED` |
| `validation.sh` | `_VALIDATION_LOADED` |
| `output-format.sh` | `_OUTPUT_FORMAT_LOADED` |

### 2.3 Guard Placement

The source guard MUST appear:
1. After the shebang line
2. Before any other code
3. Before dependency sources

---

## Part 3: Library File Structure

### 3.1 Required Sections

Every library file MUST contain these sections in order:

```bash
#!/usr/bin/env bash
# <filename> - <one-line description>
#
# LAYER: <0|1|2|3>
# DEPENDENCIES: <comma-separated list or "none">
# PROVIDES: <comma-separated list of public functions>
#

#=== SOURCE GUARD ================================================
[[ -n "${_<LIBNAME>_LOADED:-}" ]] && return 0
declare -r _<LIBNAME>_LOADED=1

#=== DEPENDENCIES ================================================
# (Source statements for dependencies, if any)

#=== CONFIGURATION ===============================================
# (Configurable variables with defaults)

#=== PRIVATE FUNCTIONS ===========================================
# (Internal helpers, underscore-prefixed)

#=== PUBLIC API ==================================================
# (Exported functions with documentation)
```

### 3.2 Dependency Declaration

Libraries with dependencies MUST:
1. Declare dependencies in the file header comment
2. Source dependencies immediately after the guard
3. Use relative paths from `${LIB_DIR}` or `${BASH_SOURCE[0]}`

**Example**:
```bash
#=== DEPENDENCIES ================================================
_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${_LIB_DIR}/exit-codes.sh"
source "${_LIB_DIR}/platform-compat.sh"
```

### 3.3 Function Documentation

Public functions SHOULD include documentation following Google Shell Style Guide:

```bash
#######################################
# Brief description of function.
# Globals:
#   VARIABLE_NAME - description
# Arguments:
#   $1 - description
#   $2 - description (optional)
# Outputs:
#   Writes to stdout
# Returns:
#   0 on success, non-zero on error
#######################################
function_name() {
    # implementation
}
```

---

## Part 4: Function Design

### 4.1 Pure vs Impure Functions

Libraries MUST distinguish between pure and impure functions.

| Type | Characteristics | Use For |
|------|-----------------|---------|
| **Pure** | Same input → same output, no side effects | Validation, transformation, calculation |
| **Impure** | May have side effects (I/O, time, network) | File operations, logging, external calls |

### 4.2 Pure Function Requirements

Pure functions MUST:
- Depend only on input parameters
- Produce identical output for identical input
- Have no side effects (no file I/O, no global mutation)
- Be fully testable without mocks

**Example**:
```bash
# PURE: Deterministic validation
validate_task_id() {
    local id="$1"
    [[ "$id" =~ ^T[0-9]{3,}$ ]]
}

# PURE: Deterministic calculation
calculate_priority_score() {
    local priority="$1"
    local blocked_count="$2"
    case "$priority" in
        critical) echo $((100 - blocked_count * 10)) ;;
        high)     echo $((75 - blocked_count * 10)) ;;
        *)        echo $((50 - blocked_count * 10)) ;;
    esac
}
```

### 4.3 Impure Function Requirements

Impure functions MUST:
- Be clearly identifiable by name or documentation
- Delegate pure logic to pure functions where possible
- Handle errors with structured output

### 4.4 Functional Core, Imperative Shell

Libraries SHOULD follow the "Functional Core, Imperative Shell" pattern:
- Pure functions form the inner core (business logic)
- Impure functions form the outer shell (I/O boundaries)
- The shell calls the core, never the reverse

---

## Part 5: Namespace Conventions

### 5.1 Function Naming

| Visibility | Convention | Example |
|------------|------------|---------|
| **Public** | `verb_noun()` or `prefix_verb_noun()` | `validate_json()`, `cfg_load()` |
| **Private** | `_prefix_verb_noun()` | `_cfg_parse_line()` |

### 5.2 Recommended Prefixes

Libraries MAY use short prefixes for namespacing:

| Library | Prefix | Example Functions |
|---------|--------|-------------------|
| `logging.sh` | `log_` | `log_info()`, `log_error()` |
| `config.sh` | `cfg_` | `cfg_load()`, `cfg_get()` |
| `validation.sh` | `val_` | `val_json()`, `val_schema()` |
| `file-ops.sh` | `fops_` | `fops_atomic_write()` |

### 5.3 Variable Naming

| Scope | Convention | Example |
|-------|------------|---------|
| **Global/Exported** | `UPPER_SNAKE_CASE` | `LOG_LEVEL`, `TODO_FILE` |
| **Local** | `lower_snake_case` with `local` | `local task_id` |
| **Library-private global** | `_UPPER_SNAKE_CASE` | `_LOG_INITIALIZED` |
| **Guard variable** | `_<LIBNAME>_LOADED` | `_VALIDATION_LOADED` |

### 5.4 Local Variable Requirement

All function variables MUST be declared with `local`.

**Critical**: Separate `local` declaration from command substitution to preserve exit codes:

```bash
# CORRECT: Exit code preserved
local output
output=$(some_command)
[[ $? -eq 0 ]] || return 1

# INCORRECT: Exit code lost
local output=$(some_command)  # Always returns 0!
```

---

## Part 6: Dependency Injection

### 6.1 Injection Patterns

Libraries MUST support dependency injection for testability:

| Pattern | Use Case | Example |
|---------|----------|---------|
| **Environment Variable** | Mock external values | `${MOCK_TIMESTAMP:-$(date)}` |
| **Function Override** | Replace implementations | Define mock before sourcing |
| **PATH Manipulation** | Mock external commands | Prepend mock directory to PATH |
| **Callback/Hook** | Customize behavior | `on_error_callback` function |

### 6.2 Environment Variable Injection

Functions depending on external state SHOULD allow injection:

```bash
get_current_timestamp() {
    echo "${CT_MOCK_TIMESTAMP:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
}
```

### 6.3 Callback Hooks

Libraries providing extensibility SHOULD define hook points:

```bash
# Default hook (can be overridden before sourcing)
val_on_error() {
    log_error "$1"
}

val_check_file() {
    local file="$1"
    [[ -f "$file" ]] || { val_on_error "File not found: $file"; return 1; }
}
```

---

## Part 7: Error Handling

### 7.1 Exit Code Usage

Libraries MUST use exit code constants from `lib/exit-codes.sh`.

Libraries MUST NOT use magic numbers for exit codes.

### 7.2 Error Propagation

Libraries MUST propagate errors using return codes, not exit:

```bash
# CORRECT: Return allows caller to handle
validate_input() {
    [[ -n "$1" ]] || return 1
    return 0
}

# INCORRECT: Exit terminates entire script
validate_input() {
    [[ -n "$1" ]] || exit 1
}
```

### 7.3 Structured Error Output

Libraries providing user-facing output MUST use `output_error()` from `lib/error-json.sh` for format-aware error messages.

---

## Part 8: Loading Patterns

### 8.1 Eager Loading (Default)

Scripts SHOULD use eager loading with explicit initialization order:

```bash
# Load in dependency order
source "${LIB_DIR}/exit-codes.sh"      # Layer 0
source "${LIB_DIR}/platform-compat.sh" # Layer 0
source "${LIB_DIR}/config.sh"          # Layer 1
source "${LIB_DIR}/logging.sh"         # Layer 2
source "${LIB_DIR}/validation.sh"      # Layer 2
```

### 8.2 Lazy Loading (Optional)

Libraries MAY implement lazy loading for optional heavy dependencies:

```bash
_ensure_research_loaded() {
    [[ -n "${_RESEARCH_LOADED:-}" ]] && return 0
    source "${LIB_DIR}/research.sh"
}

run_research() {
    _ensure_research_loaded
    _research_execute "$@"
}
```

### 8.3 Bootstrap Pattern

Complex applications MAY use a central bootstrap file:

```bash
# lib/bootstrap.sh
source "${LIB_DIR}/exit-codes.sh"
source "${LIB_DIR}/platform-compat.sh"
source "${LIB_DIR}/config.sh"
source "${LIB_DIR}/error-json.sh"
source "${LIB_DIR}/output-format.sh"
source "${LIB_DIR}/logging.sh"
source "${LIB_DIR}/file-ops.sh"
source "${LIB_DIR}/validation.sh"
```

---

## Part 9: Testability Requirements

### 9.1 BATS Compatibility

Libraries MUST be testable with the BATS framework.

### 9.2 Isolation Requirements

Libraries MUST support testing in isolation:
- No required global state at source time
- All dependencies injectable or mockable
- No side effects during sourcing

### 9.3 Test Helper Pattern

Libraries SHOULD be sourceable without executing code:

```bash
# Main logic in functions, not at file level
main() {
    # implementation
}

# Only run when executed, not sourced
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
```

---

## Part 10: LLM-Agent-First Requirements

### 10.1 Deterministic Behavior

Libraries providing output MUST produce deterministic results for identical inputs.

### 10.2 Structured Output

Libraries producing output for external consumption MUST support JSON format via the standard envelope defined in LLM-AGENT-FIRST-SPEC.

### 10.3 Exit Code Consistency

Libraries MUST use documented exit codes that agents can rely upon:
- Success: 0
- Input errors: 2
- Not found: 4
- Validation errors: 6
- Hierarchy errors: 10-15

### 10.4 Side Effect Documentation

Libraries with side effects MUST document them in function headers:

```bash
#######################################
# Creates a backup of the specified file.
# Side Effects:
#   - Creates file at ${backup_path}
#   - Appends to audit log
#######################################
```

---

## Part 11: Library Inventory

### 11.1 Layer 0: Foundation

| Library | Purpose | Dependencies |
|---------|---------|--------------|
| `exit-codes.sh` | Exit code constants | None |
| `platform-compat.sh` | Platform detection, command aliases | None |
| `version.sh` | Version string | None |

### 11.2 Layer 1: Utilities

| Library | Purpose | Dependencies |
|---------|---------|--------------|
| `config.sh` | Configuration management | exit-codes, platform-compat |
| `error-json.sh` | Structured error output | exit-codes, platform-compat |
| `output-format.sh` | Format detection and resolution | exit-codes |
| `grammar.sh` | Text transformation | None |

### 11.3 Layer 2: Operations

| Library | Purpose | Dependencies |
|---------|---------|--------------|
| `file-ops.sh` | Atomic file operations | atomic-write, config |
| `validation.sh` | Schema and semantic validation | platform-compat, config |
| `logging.sh` | Audit logging | atomic-write |
| `backup.sh` | Backup operations | file-ops, logging |
| `hierarchy.sh` | Task hierarchy validation | config |
| `migrate.sh` | Schema migrations | logging |

### 11.4 Layer 3: Domain Logic

| Library | Purpose | Dependencies |
|---------|---------|--------------|
| `analysis.sh` | Task analysis algorithms | file-ops, validation |
| `cancel-ops.sh` | Cancellation operations | validation, backup |
| `deletion-strategy.sh` | Deletion logic | hierarchy, file-ops |
| `phase-tracking.sh` | Phase management | file-ops |

---

## Part 12: Compliance Validation

### 12.1 Automated Checks

The following MUST be validated automatically:

| Check | Tool | Requirement |
|-------|------|-------------|
| Source guard present | grep | Every lib file |
| Layer header present | grep | Every lib file |
| No circular dependencies | custom script | All dependencies |
| Local variables | shellcheck | All functions |
| Exit code constants | grep | No magic numbers |

### 12.2 Compliance Script

A compliance validation script SHOULD be provided at `dev/check-lib-compliance.sh`.

---

## Appendix A: Decision Rationale

| Decision | Alternatives Considered | Why Chosen |
|----------|------------------------|------------|
| Source guards over function checks | `declare -F func` | Simpler, works for variables too |
| Layered over flat | Single directory | Prevents circular deps, clearer contracts |
| Underscore for private | `__double_underscore` | Bash convention, readable |
| Eager over lazy loading | Lazy-only | Predictable, debuggable, CLI-appropriate |

## Appendix B: Industry Precedents

| System | Pattern | Our Adoption |
|--------|---------|--------------|
| **bats-core** | lib/ with source guards | Source guard pattern |
| **oh-my-bash** | Layered lib + plugins | Layer architecture |
| **Google Shell Style** | Function documentation, local vars | Documentation format |
| **Terraform SDK** | Pure function design | Functional core pattern |
| **GitHub CLI** | pkg/internal separation | Layer visibility |

## Appendix C: Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2025-12-23 | Initial specification |

---

## Related Specifications

| Document | Relationship |
|----------|--------------|
| **[LLM-AGENT-FIRST-SPEC.md](LLM-AGENT-FIRST-SPEC.md)** | Defers to this for output format, exit codes |
| **[SPEC-BIBLE-GUIDELINES.md](SPEC-BIBLE-GUIDELINES.md)** | **AUTHORITATIVE** for specification format |
| **[LIBRARY-ARCHITECTURE-IMPLEMENTATION-REPORT.md](LIBRARY-ARCHITECTURE-IMPLEMENTATION-REPORT.md)** | Tracks implementation status |

---

*End of Specification*

# Documentation Maintenance Guide

> Structured workflow for maintaining layered documentation in cleo

## Documentation Hierarchy

```
Layer 1: CLAUDE-INJECTION.md    → Minimal (essential commands only)
Layer 2: TODO_Task_Management.md → Concise (all commands, brief usage)
Layer 3: docs/commands/*.md      → Comprehensive (source of truth)
Layer 4: docs/INDEX.md           → Master index (links everything)
```

**Flow direction**: Users/LLMs start at Layer 1, drill down as needed.

## Core Principles

| Principle | Rule |
|-----------|------|
| Single Source of Truth | Detailed info lives in `docs/commands/*.md` only |
| No Duplication | Higher layers reference, never repeat details |
| Layered Depth | Each layer adds detail, never redundancy |
| LLM-First Design | Layers 1-2 optimized for scanning, not reading |

## Update Checklist

When adding or modifying a command:

### Required Updates

- [ ] **docs/commands/\<cmd\>.md** — Create/update detailed documentation
  - Usage with examples
  - All options (table format)
  - Exit codes
  - Related commands

- [ ] **docs/INDEX.md** — Add/update entry in Command Reference section
  - Link to docs/commands/\<cmd\>.md
  - One-line description

- [ ] **docs/TODO_Task_Management.md** — Add to appropriate section
  - Command syntax only
  - Group with related commands
  - No detailed explanations

### Conditional Updates

- [ ] **templates/CLAUDE-INJECTION.md** — Only if command is essential
  - Essential = used in >50% of sessions
  - Keep under 10 commands total
  - Point to TODO_Task_Management.md for more

## Command Doc Template

```markdown
# <command> Command

> One-line purpose

## Usage
\`\`\`bash
cleo <command> [args] [OPTIONS]
\`\`\`

## Options
| Option | Short | Description | Default |
|--------|-------|-------------|---------|

## Examples
\`\`\`bash
# Common use case
cleo <command> example
\`\`\`

## Exit Codes
| Code | Meaning |
|------|---------|

## Related Commands
- `other-cmd` — relationship
```

## Layer Content Rules

### Layer 1: CLAUDE-INJECTION.md
- Max 10 essential commands
- Syntax only, no explanations
- Points to Layer 2 for full docs
- Updated only for major additions

### Layer 2: TODO_Task_Management.md
- All commands grouped by function
- Brief syntax with common options
- Tables for options/flags
- Points to Layer 3 for details

### Layer 3: docs/commands/*.md
- One file per command
- Full options, examples, edge cases
- Exit codes and error handling
- Related commands section

### Layer 4: docs/INDEX.md
- Links to all Layer 3 docs
- Organized by category
- One-line descriptions
- No usage examples

## Validation

After updates, verify:

```bash
# All commands have docs
ls docs/commands/*.md | wc -l  # Should match command count

# INDEX.md links all command docs
grep -c "commands/" docs/INDEX.md

# No detailed duplication in Layer 1-2
wc -l templates/CLAUDE-INJECTION.md  # Should be <50 lines
```

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Copy option tables to multiple files | Reference docs/commands/*.md |
| Add examples to CLAUDE-INJECTION | Keep minimal, point to TODO_Task_Management |
| Explain concepts in INDEX.md | Link to appropriate guide |
| Document same feature twice | Single source in Layer 3 |

## Version Documentation

When releasing new versions:

1. **VERSION file** (source of truth) - Modified only by bump-version.sh
2. **CHANGELOG.md** - Manually updated with release notes
3. **README.md badge** - Auto-updated by bump-version.sh
4. **CLAUDE-INJECTION.md tag** - Auto-updated by bump-version.sh

**Workflow**:
```bash
./dev/validate-version.sh           # Check for drift
./dev/bump-version.sh <version>     # Bump and sync
# Update CHANGELOG.md manually
git commit && git push
```

### Version Strings in Documentation

| Context | Format | Example |
|---------|--------|---------|
| **Automated** (README badge, injection tags) | Current version | `v0.16.0` |
| **Command output examples** | Realistic example versions | `v1.0.0`, `0.9.0 → 1.0.0` |
| **Historical context** (when feature added) | Actual version | `Added in v0.8.2` |
| **Version history sections** | Actual version | `- **v0.15.0**: Initial implementation` |

**Rule**: Only files handled by `bump-version.sh` use current versions. Command output examples use realistic but generic versions (like `v1.0.0`) that look like real output but don't require updates. Historical references preserve the actual version when features were added.

See [VERSION-MANAGEMENT.md](reference/VERSION-MANAGEMENT.md) for full details.

---

*This guide itself follows the principles: single source of truth for documentation maintenance.*

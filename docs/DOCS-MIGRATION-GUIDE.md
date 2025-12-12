# Documentation Migration Guide

**Version**: 2.2.0
**Date**: 2025-12-12

## Overview

The CLAUDE-TODO documentation has been reorganized for better discoverability and maintainability. This guide helps users update bookmarks, scripts, and references to reflect the new structure.

**Why the change?**
- **Improved organization**: Content grouped by purpose (getting started, guides, reference)
- **Better navigation**: Clearer hierarchy reduces search time
- **Reduced duplication**: Consolidated overlapping content
- **Enhanced maintainability**: Easier to update and extend

---

## Path Changes

### Moved Files

| Old Path | New Path | Notes |
|----------|----------|-------|
| `docs/installation.md` | `docs/getting-started/installation.md` | No content changes |
| `docs/usage.md` | `docs/getting-started/quick-start.md` | Streamlined for first-time users |
| `docs/configuration.md` | `docs/guides/configuration.md` | No content changes |
| `docs/schema-reference.md` | `docs/reference/schema-reference.md` | No content changes |
| `docs/troubleshooting.md` | `docs/reference/troubleshooting.md` | No content changes |

### Consolidated Files

| Old Files | New Location | Content |
|-----------|--------------|---------|
| `docs/SYSTEM-DESIGN-SUMMARY.md` | `docs/ARCHITECTURE.md#executive-summary` | Merged as section |
| `docs/DATA-FLOW-DIAGRAMS.md` | `docs/ARCHITECTURE.md#data-flows` | Merged as section |

---

## Deleted Files

The following files were removed as redundant or obsolete:

- `docs/SYSTEM-DESIGN-SUMMARY.md` → Content merged into `ARCHITECTURE.md`
- `docs/DATA-FLOW-DIAGRAMS.md` → Content merged into `ARCHITECTURE.md`
- `docs/usage.md` → Split between `quick-start.md` and command-specific guides

---

## New Files

### Getting Started

- `docs/getting-started/installation.md` - Installation and setup
- `docs/getting-started/quick-start.md` - First steps and basic workflow
- `docs/getting-started/core-concepts.md` - Task lifecycle and terminology

### Guides

- `docs/guides/configuration.md` - Configuration options
- `docs/guides/session-management.md` - Session workflow best practices
- `docs/guides/advanced-workflows.md` - Power user techniques

### Reference

- `docs/reference/cli-reference.md` - Complete command documentation
- `docs/reference/schema-reference.md` - JSON schema details
- `docs/reference/troubleshooting.md` - Common issues and solutions

---

## Updating Scripts and Links

### GitHub Links

If you have markdown links referencing old paths:

```bash
# Find references
grep -r "docs/installation.md" .

# Update to new path
sed -i 's|docs/installation.md|docs/getting-started/installation.md|g' *.md
```

### Shell Scripts

If scripts reference documentation paths:

```bash
# Old
DOCS_PATH="docs/installation.md"

# New
DOCS_PATH="docs/getting-started/installation.md"
```

### Bookmarks

Update browser bookmarks:

- `*/docs/installation.md` → `*/docs/getting-started/installation.md`
- `*/docs/usage.md` → `*/docs/getting-started/quick-start.md`
- `*/docs/configuration.md` → `*/docs/guides/configuration.md`

---

## Benefits of New Structure

**For New Users**:
- Clear entry point with `getting-started/` directory
- Progressive learning path from installation to advanced usage

**For Existing Users**:
- Faster reference lookup with organized `reference/` section
- Topic-based guides in `guides/` directory

**For Contributors**:
- Logical placement for new documentation
- Reduced merge conflicts with topic separation
- Easier to identify documentation gaps

---

## Support

If you encounter broken links or missing content after the migration:

1. Check this guide for path mappings
2. Search the new structure using `grep` or your editor
3. Report issues: [GitHub Issues](https://github.com/kryptobaseddev/claude-todo/issues)

---

**Last Updated**: 2025-12-12
**Applies To**: v2.2.0 and later

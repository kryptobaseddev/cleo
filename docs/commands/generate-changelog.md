# cleo generate-changelog

Generate Mintlify changelog from CHANGELOG.md.

## Synopsis

```bash
./scripts/generate-changelog.sh [LIMIT]
```

## Description

Internal development tool that converts `CHANGELOG.md` into Mintlify-compatible MDX format for the documentation site. Parses version entries and generates `docs/changelog/overview.mdx`.

> **Note**: This is a development tool, not a user-facing command. It's used during release preparation.

## Arguments

| Argument | Description |
|----------|-------------|
| `[LIMIT]` | Maximum number of versions to include (default: 15) |

## Output

Generates `docs/changelog/overview.mdx` with:
- MDX frontmatter for Mintlify
- Parsed version entries from CHANGELOG.md
- Formatted release notes

## Examples

```bash
# Generate with default limit (15 versions)
./scripts/generate-changelog.sh

# Generate last 5 versions only
./scripts/generate-changelog.sh 5
```

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | CHANGELOG.md not found or parse error |

## See Also

- [generate-features.md](./generate-features.md) - Generate features documentation
- `CHANGELOG.md` - Source file

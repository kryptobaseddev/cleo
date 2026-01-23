# cleo generate-features

Generate FEATURES.md from FEATURES.json.

## Synopsis

```bash
./scripts/generate-features.sh
```

## Description

Internal development tool that generates `docs/FEATURES.md` from the structured `docs/FEATURES.json` file. Ensures feature documentation stays in sync with the canonical JSON source.

> **Note**: This is a development tool, not a user-facing command. It's used during release preparation.

## Output

Generates `docs/FEATURES.md` with:
- Table of contents
- Feature descriptions organized by category
- Version information and status

## Examples

```bash
# Generate features documentation
./scripts/generate-features.sh
```

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | FEATURES.json not found |

## See Also

- [generate-changelog.md](./generate-changelog.md) - Generate changelog
- `docs/FEATURES.json` - Source file

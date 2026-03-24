# Versioning Policy

- Protocol versioning follows SemVer.
- `MAJOR`: breaking changes to schema, invariants, or mandatory semantics.
- `MINOR`: backward-compatible additions.
- `PATCH`: corrections and clarifications without contract changes.

## Compatibility requirements

- Minor and patch releases MUST preserve prior valid payloads.
- Major releases MUST publish migration guidance and machine-readable manifests.

## Repository version source of truth

- The canonical LAFS version source is `package.json` (`version`).
- Documentation versions (`README.md`, `lafs.md`, `docs/specification.md`) are synchronized from that source.
- Python package version is derived from root `package.json` during packaging.

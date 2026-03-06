# Hygiene Audit Report

## Scope and Method

- Repository-wide TODO scan using tracked-file search patterns for comment syntax (`// TODO`, `# TODO`, `/* TODO`, `* TODO`) plus case-insensitive verification.
- Additional broad `TODO` token scans across `docs/`, `CHANGELOG.md`, and root docs to separate real comment debt from textual/doc false positives.
- Unused import validation via configured static checks: `npx tsc --noEmit` (project has `noUnusedLocals: true`, `noUnusedParameters: true` in `tsconfig.json`).
- Underscore-prefixed import/usage audit focused on imported bindings like `as _Name` and whether they are intentionally wired or actually unwired.

## TODO Findings By File

### True TODO Comments (actionable)

- `dev/archived/schema-diff-analyzer.sh:217` - `# TODO: Implement migration logic for change type: $change_kind`
- `dev/archived/schema-diff-analyzer.sh:260` - `# TODO: Implement breaking change migration`

### False Positives / Non-actionable Mentions

- `src/core/migration/validate.ts:208` - `// todo.json status` is a section label for `todo.json`, not a TODO marker.
- `CHANGELOG.md:160` - phrase "stale TODO resolution" is release-note text, not a TODO comment.
- Multiple `docs/**` hits are references to names/identifiers (`TODO_FILE`, `SCHEMA_VERSION_TODO`, `TODOWRITE`, `TODO.md`) and not TODO comments.
- Multiple `.cleo/agent-outputs/**` hits are historical reports quoting TODO strings; these are audit artifacts, not live implementation TODO comments.

## Unused Import Findings By File

### Static-check result

- `npx tsc --noEmit` completed cleanly with no unused-local or unused-import diagnostics in the TypeScript project scope (`src/**/*`, excluding tests per tsconfig).

### Findings

- No unused imports detected in TypeScript files covered by current compiler configuration.

## Underscore-Prefixed Import/Usage Audit

### Intentionally reserved/wired (not unwired)

- `src/store/node-sqlite-adapter.ts:19` - `DatabaseSync as _DatabaseSyncType` is used to type the runtime-loaded `DatabaseSync` constructor and local aliasing.
- `src/store/sqlite.ts:21` - same intentional pattern for type-safe `createRequire('node:sqlite')` interop.
- `src/core/memory/claude-mem-migration.ts:15` - same intentional pattern, used in constructor typing.
- `src/core/memory/__tests__/claude-mem-migration.test.ts:17` - same intentional pattern in test fixture runtime loader.

### Genuinely unwired underscore-prefixed imports

- None found.

## Confidence Level

- **High** for TypeScript source import hygiene (compiler-enforced, strict flags enabled).
- **High** for TODO comment findings in tracked files with comment-syntax patterns.
- **Medium-High** for full-repo "unused import" hygiene outside TypeScript compiler scope (non-TS scripts/docs are not import-checked by `tsc`).

## Recommended Follow-up Tasks (no code changes)

- Define and document hygiene policy scope explicitly (e.g., whether `dev/archived/**` is excluded from "zero TODO" claims).
- Add/confirm CI hygiene gates for TODO comments with scoped allowlist rules for docs/changelog/artifact directories.
- Add a secondary import-hygiene check for test files if test trees should be included in "zero unused imports" claims.

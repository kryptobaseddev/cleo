# Action-Marker Hygiene Scope Policy

Date: 2026-03-06
Owner: Validation remediation track (RB-13 / T5427)

## Purpose

Define the authoritative scope for zero action-marker hygiene checks so report artifacts and archived development material do not create false failures.

## In-Scope Paths

- `src/**`
- `tests/**`
- `scripts/**`
- `lib/**` (legacy Bash still tracked)
- `dev/**` except `dev/archived/**`
- `.github/**`
- Root project configuration and entry files (for example: `package.json`, `tsconfig.json`, `build.mjs`)

## Out-of-Scope Paths

- `docs/**` (narrative/spec content may legitimately reference historical action markers)
- `.cleo/agent-outputs/**` (generated evidence artifacts)
- `CHANGELOG.md` (historical release notes)
- `dev/archived/**` (deprecated archived tooling, not runtime or release path)

## Enforcement Command

Use this command for policy-scoped zero action-marker checks:

```bash
git grep -nE "(^|[[:space:]])(//|#|/\*|\*)[[:space:]]*ACTION-ITEM\b" -- . \
  ':(exclude)docs/**' \
  ':(exclude).cleo/agent-outputs/**' \
  ':(exclude)CHANGELOG.md' \
  ':(exclude)dev/archived/**'
```

## RB-13 Decision Record

- Historical findings referenced `dev/archived/schema-diff-analyzer.sh:217` and `dev/archived/schema-diff-analyzer.sh:260`.
- `dev/archived/` is not present in the current tracked tree and remains policy-excluded if reintroduced as archived-only tooling.
- Zero action-marker claims for RB-13 are therefore evaluated against in-scope paths only, using the enforcement command above.

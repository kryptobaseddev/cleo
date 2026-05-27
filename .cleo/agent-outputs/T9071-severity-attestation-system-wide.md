# T9071 — W3: Extract severity attestation as system-wide primitive

## Status: complete

## Summary

Extracted the severity attestation logic from `cleo/src/cli/commands/bug.ts` into a
shared core helper. The `BugSeverityAttestation` interface was renamed to
`SeverityAttestation` and moved to `@cleocode/contracts`. The helper is now
accessible system-wide so any task type with `--severity` can produce a signed
audit line without duplicating logic.

## Commits (branch: task/T9071)

1. `39378e298` feat(T9071): SeverityAttestation interface in contracts
2. `59e960db4` feat(T9071): severity-attestation core helper (extracted from bug.ts)
3. `6ee78550f` refactor(T9071): cleo bug delegates to core severity-attestation helper
4. `90038075d` fix(T9071): sort imports in tasks/index.ts per biome organize-imports

## Files Changed

- `packages/contracts/src/task.ts` — added `SeverityAttestation` interface
- `packages/contracts/src/index.ts` — exported `SeverityAttestation`
- `packages/core/src/tasks/severity-attestation.ts` — new file; exports
  `appendSignedSeverityAttestation`, `canonicalAttestationJson`,
  `loadOwnerPubkeys`, `SEVERITY_ATTESTATION_AUDIT_FILE`,
  `LEGACY_BUG_SEVERITY_AUDIT_FILE`, `SeverityAttestation`
- `packages/core/src/tasks/index.ts` — wired new exports
- `packages/core/src/index.ts` — wired new exports
- `packages/cleo/src/cli/commands/bug.ts` — removed ~80 LOC of local helpers;
  now imports `appendSignedSeverityAttestation` from `@cleocode/core`

## Key Decisions

- Audit log path: `.cleo/audit/severity-attestation.jsonl`
  (was `.cleo/audit/bug-severity.jsonl`; old path marked as deprecated via
  `LEGACY_BUG_SEVERITY_AUDIT_FILE` constant but NOT auto-renamed — separate cleanup)
- Imports in `severity-attestation.ts` use concrete paths (`../paths.js`,
  `../identity/cleo-identity.js`) to avoid circular dependency via the barrel
- `bug.ts` remains a transitional consumer; will be removed in T9075

## Quality Gates

- biome ci: clean on all T9071 files
- tests: 870 passed, 0 failed
- contracts build: clean
- owner-pubkey allowlist enforcement: preserved
- signing primitive: unchanged

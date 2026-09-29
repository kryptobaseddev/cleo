---
"@cleocode/core": patch
"@cleocode/cleo": patch
---

Fix bare `require()` calls in ESM sources that threw `require is not defined` under Node while vitest hid them (T12704). The docs audit trail never created its checkpoint secret, so `writeAuditEntry` silently wrote nothing; `checkCanonicalRcasdPaths` skipped both of its filesystem sub-checks and reported `passed`. Both now use static imports. New arch gate 34 (`scripts/lint-no-esm-bare-require.mjs`) fails any new bare `require(` in a `"type": "module"` package's `src/`, and runs in `cleo check arch` and CI.

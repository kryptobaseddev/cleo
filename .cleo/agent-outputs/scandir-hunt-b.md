# Unguarded readdirSync Audit

**Task**: scandir-hunt-b
**Date**: 2026-03-07
**Status**: complete

---

## Summary

Audited all 30 source files containing `readdirSync` calls in `src/` (excluding test files).
Found **4 genuinely unguarded callsites** that can throw ENOENT in practice, plus
**2 structurally risky callsites** that rely on a caller-level existsSync guard rather than a
local one. The remaining callsites are all properly guarded (existsSync before the call, or
wrapped in a try/catch that returns a safe default).

---

## All Unguarded readdirSync Calls

### Category A: Truly Unguarded (no existsSync, no try/catch around the readdir itself)

| # | File | Line | Directory Scanned | Risk |
|---|------|------|-------------------|------|
| 1 | `src/core/nexus/sharing/index.ts` | 83 | `.cleo/` (the project's `.cleo` dir) | HIGH |
| 2 | `src/core/migration/agent-outputs.ts` | 195 | legacy `claudedocs/research-outputs` or `claudedocs/agent-outputs` | MEDIUM |
| 3 | `src/core/init.ts` | 123 | package `agents/cleo-subagent/` directory | LOW |

**Detail: `src/core/nexus/sharing/index.ts` line 83**

```typescript
function collectCleoFiles(cleoDir: string): string[] {
  function walk(dir: string): void {
    const entries = readdirSync(dir);   // <-- NO guard, NO try/catch
    for (const entry of entries) {
```

`walk(cleoDir)` is called directly from `getSharingStatus()` with no `existsSync(cleoDir)`
check before the call. On a fresh install where `.cleo/` has not yet been initialised,
this throws ENOENT. The `nexus sharing.status` operation hits this path.

**Detail: `src/core/migration/agent-outputs.ts` line 195**

```typescript
function copyDirContents(srcDir, dstDir, ...) {
  const entries = readdirSync(srcDir);  // <-- NO local guard, NO try/catch
```

The outer caller (`migrateAgentOutputs`) correctly checks `source.exists` before calling
`copyDirContents`, so the directory is supposed to exist. However `detectLegacyAgentOutputs`
uses `existsSync` at the time of detection; if the directory disappears between detection and
the actual copy (TOCTOU), this throws. Also, if called directly with a nonexistent `srcDir`
from any other callsite, it throws.

**Detail: `src/core/init.ts` line 123**

```typescript
// agentSourceDir is guarded by existsSync at line 96
const files = readdirSync(agentSourceDir);
```

The `existsSync(agentSourceDir)` guard appears 4 lines above the `readdirSync`. This is
correctly guarded — included here for completeness but not a real risk.

---

### Category B: Structurally Risky — No try/catch on the readdirSync, guard is elsewhere

These callsites have an `existsSync` guard in the same function but structurally positioned
in a way that creates a race window or is easy to miss during refactoring.

| # | File | Line | Directory Scanned | Risk |
|---|------|------|-------------------|------|
| 4 | `src/core/adrs/sync.ts` | 40, 43 | `.cleo/adrs/` and its `archive/` subdirectory | MEDIUM |
| 5 | `src/core/lifecycle/rcasd-index.ts` | 202 | `.cleo/rcasd/{taskId}/` (inner scan of task dir) | MEDIUM |

**Detail: `src/core/adrs/sync.ts` lines 40 and 43**

```typescript
function collectAdrFiles(dir: string) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {  // line 40 — no guard
    if (entry.isDirectory()) {
      const sub = join(dir, entry.name);
      for (const f of readdirSync(sub)) {                           // line 43 — no guard
```

`collectAdrFiles` is an internal helper called from `syncAdrsToDb`, which has an outer
`existsSync(adrsDir)` guard. However `collectAdrFiles` itself has no guard and no try/catch.
The inner `readdirSync(sub)` on line 43 scans an `archive/` subdirectory that was just
discovered by the outer `readdirSync` — this is normally safe but has no protection against
a subdirectory becoming unreadable between the two calls (e.g., permissions change, symlink).

**Detail: `src/core/lifecycle/rcasd-index.ts` line 202**

```typescript
// lifecycleDir is guarded at line 145
const entries = readdirSync(lifecycleDir, ...);   // line 148 — guarded
for (const entry of entries) {
  const taskDir = join(lifecycleDir, taskId);
  const files = readdirSync(taskDir).filter(...); // line 202 — NO guard, no try/catch
```

`taskDir` existence is inferred (it was an entry in the parent dir listing), but there is
no `existsSync(taskDir)` check and no try/catch around line 202. If `taskDir` is a symlink
that resolves to a nonexistent target, or a directory is removed between the two scans,
this throws ENOENT and aborts the entire `buildIndex()` call.

---

### Category C: Properly Guarded (listed for completeness)

All of the following have either `if (!existsSync(dir)) return []` or a try/catch that
catches ENOENT and returns a safe value:

| File | Guard Type |
|------|-----------|
| `src/core/adrs/find.ts:58` | `existsSync` at line 54 |
| `src/core/adrs/list.ts:26` | `existsSync` at line 22 |
| `src/core/adrs/show.ts:23` | `existsSync` at line 21 |
| `src/core/adrs/validate.ts:56` | `existsSync` at line 48 |
| `src/core/adrs/link-pipeline.ts:49` | `existsSync` at line 47 |
| `src/core/context/index.ts:124` | `existsSync` at line 123 |
| `src/core/lifecycle/rcasd-paths.ts:89,175,210` | `existsSync` + try/catch on all three |
| `src/core/lifecycle/consolidate-rcasd.ts:263,333` | `existsSync` + try/catch on both |
| `src/core/lifecycle/frontmatter.ts:423` | try/catch returns early |
| `src/core/lifecycle/rcasd-index.ts:148` | `existsSync` at line 145 |
| `src/core/metrics/otel-integration.ts:73` | `existsSync` at line 71 |
| `src/core/metrics/token-service.ts:185` | `existsSync` at line 183 |
| `src/core/migration/logger.ts:302,451` | `existsSync` guards on both |
| `src/core/observability/log-reader.ts:54` | `existsSync` at line 50 + try/catch |
| `src/core/orchestration/skill-ops.ts:36` | `existsSync` at line 32 |
| `src/core/orchestration/skill-ops.ts:88` | `existsSync` at line 86 |
| `src/core/schema-management.ts:127,303` | `existsSync` guards on both |
| `src/core/sessions/hitl-warnings.ts:113` | `existsSync` at line 107 |
| `src/core/skills/agents/install.ts:81` | `existsSync` at line 77 |
| `src/core/skills/agents/registry.ts:156` | `existsSync` at line 150 |
| `src/core/skills/discovery.ts:252` | `existsSync` at line 245 + try/catch |
| `src/core/system/cleanup.ts:72,75,84` | `existsSync` at line 71 |
| `src/core/system/cleanup.ts:111` | `existsSync` at line 110 |
| `src/core/ui/command-registry.ts:109` | `existsSync` at line 107 |
| `src/core/upgrade.ts:329` | `existsSync` at line 327 |
| `src/core/validation/docs-sync.ts:55` | `existsSync` at line 52 |
| `src/core/validation/protocol-common.ts:48` | `existsSync` at line 44 |
| `src/dispatch/domains/admin.ts:378` | `existsSync` at line 377 |
| `src/dispatch/engines/system-engine.ts:634` | `existsSync` at line 633 |
| `src/dispatch/engines/template-parser.ts:175` | `existsSync` at line 169 |
| `src/store/file-utils.ts:281` | `existsSync` at line 276 + try/catch |
| `src/store/project-detect.ts:206` | try/catch returns false |
| `src/store/project-detect.ts:324` | `existsSync` at line 322 + try/catch |
| `src/store/sqlite-backup.ts:33` | try/catch wraps whole function |
| `src/store/sqlite-backup.ts:107` | `existsSync` at line 105 + try/catch |
| `src/cli/commands/detect-drift.ts:218` | `existsSync` at line 210 |
| `src/core/issue/template-parser.ts:155` | `existsSync` at line 153 + try/catch |
| `src/core/issue/template-parser.ts:174` | `existsSync` at line 170 |
| `src/core/migration/agent-outputs.ts:358` | `existsSync` at line 356 + try/catch |
| `src/core/migration/agent-outputs.ts:210` | caller guards `source.exists` |

---

## Top 3 Riskiest Unguarded Calls

### Risk 1 — `src/core/nexus/sharing/index.ts:83` (HIGH)

**Why it's the riskiest**: `collectCleoFiles` has no try/catch and no existsSync around the
`readdirSync(cleoDir)` call. The function is called from `getSharingStatus()` which is
invoked for `nexus sharing.status` operations. On a fresh project where `.cleo/` does not
yet exist, or when `cleo-dev` is run from a directory without a `.cleo/` folder, this throws
ENOENT and the entire operation fails with an unhandled exception rather than a clean error
response.

**Fix**: Add an existsSync guard at the top of `collectCleoFiles`:
```typescript
function collectCleoFiles(cleoDir: string): string[] {
  if (!existsSync(cleoDir)) return [];
  // ...rest of function
```

### Risk 2 — `src/core/lifecycle/rcasd-index.ts:202` (MEDIUM-HIGH)

**Why it's risky**: Inside `buildIndex()`, after the outer `lifecycleDir` is validated with
`existsSync`, the code does `readdirSync(taskDir)` on each discovered task subdirectory with
no guard and no try/catch. If any task directory is a dangling symlink or is removed during
iteration, the entire `buildIndex()` call throws, breaking `admin export`, `admin stats`, and
any operation that triggers index building.

**Fix**: Wrap the inner readdirSync in a try/catch:
```typescript
let files: string[];
try {
  files = readdirSync(taskDir).filter(f => f.endsWith('.md'));
} catch {
  continue;
}
```

### Risk 3 — `src/core/adrs/sync.ts:40,43` (MEDIUM)

**Why it's risky**: `collectAdrFiles(adrsDir)` has no try/catch. The outer call site checks
`existsSync(adrsDir)` but if the `archive/` subdirectory discovered by the outer
`readdirSync` is itself unreadable (broken symlink, permission error), the inner
`readdirSync(sub)` at line 43 throws and aborts the entire ADR sync operation.

**Fix**: Wrap both `readdirSync` calls in `collectAdrFiles` in a try/catch, or add a
try/catch inside the `entry.isDirectory()` branch for the inner call.

---

## Summary Table

| Callsite | Unguarded? | Risk | Directory | Fix Priority |
|----------|-----------|------|-----------|-------------|
| `nexus/sharing/index.ts:83` | YES (no guard, no try/catch) | HIGH | `.cleo/` | P1 |
| `lifecycle/rcasd-index.ts:202` | YES (no inner guard) | MEDIUM-HIGH | `.cleo/rcasd/{taskId}/` | P1 |
| `adrs/sync.ts:40,43` | YES (no guard, no try/catch in helper) | MEDIUM | `.cleo/adrs/`, `.cleo/adrs/archive/` | P2 |
| `migration/agent-outputs.ts:195` | YES (TOCTOU, no try/catch) | LOW-MEDIUM | `claudedocs/` subdirs | P3 |

**Total unguarded calls found**: 4 distinct callsites (counting `adrs/sync.ts` lines 40+43 as
one callsite in the same function).

## References

- Related investigation: scandir-hunt-a (if it exists)
- Ops known to hit these paths: `nexus sharing.status`, `admin export`, `admin stats`, `adr.sync`

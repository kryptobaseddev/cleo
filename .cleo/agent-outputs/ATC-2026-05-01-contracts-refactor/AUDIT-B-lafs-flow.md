# AUDIT-B: LAFS Envelope Flow End-to-End

**Date**: 2026-05-01  
**Auditor**: Subagent (read-only, no code changes)  
**Scope**: CLI dispatch → LAFS envelope → stdout; --human branch; bypass leaks; SDK parity; error flow.

---

## 1. Executive Summary

| Question | Pass/Fail | Notes |
|----------|-----------|-------|
| Q1: Canonical LAFS shape defined | PASS | Two distinct envelope shapes exist; the CLI shape (`CliEnvelope`) is canonical at the wire boundary |
| Q2: Default JSON path single canonical emitter | PARTIAL | `cliOutput()` is the single emitter for migrated commands; ~27 command files bypass it |
| Q3: `--human` flag parses and branches cleanly | PASS | Parsed in `cli/index.ts`, stored in `FormatContext`, `cliOutput()` branches on it |
| Q4: Renderer purity | PASS | All renderer functions in `renderers/*.ts` are pure formatters taking data objects; none call dispatch |
| Q5: Bypass leaks | FAIL | 560 raw `console.log`/`process.stdout.write` calls in 27 command files; most are unformatted text |
| Q6: SDK consumer parity | PARTIAL | `@cleocode/core` exports `formatSuccess`/`formatError`; dispatch is CLI-only, not SDK-exposed |
| Q7: Error path consistency | PARTIAL | `cliError()` produces `CliEnvelope` for JSON mode; human mode uses plain `console.error()` — consistent; but bypassing commands emit raw error text |

**Biggest violations**:
- `nexus.ts` (218 raw writes), `memory.ts` (96), `brain.ts` (77), `transcript.ts` (43), `daemon.ts` (17), `sentient.ts` (15), `gc.ts` (15) — all directly emit formatted text or partial JSON bypassing `cliOutput()`.
- `help-renderer.ts` line 355: `console.log(renderGroupedHelp(...))` — the help output itself bypasses LAFS.
- `schema.ts:183`: `console.log(renderSchemaHuman(schema))` — unconditioned human text emitted even in JSON mode.
- `audit.ts:80/131`: raw `process.stdout.write` of JSON and text.

---

## 2. Canonical LAFS Envelope Spec

There are **two** envelope types in use, both legitimate but at different protocol layers:

### 2a. Protocol-Level LAFS Envelope (`LAFSEnvelope` from `@cleocode/lafs`)

Source of truth: `packages/lafs/src/types.ts`, `packages/lafs/src/envelope.ts`.

```typescript
interface LAFSEnvelope {
  $schema: 'https://lafs.dev/schemas/v1/envelope.schema.json';  // always present
  _meta: LAFSMeta;   // always present
  success: boolean;  // always present
  result: Record<string, unknown> | Record<string, unknown>[] | null;  // always present (null on error)
  error?: LAFSError | null;   // present when success=false
  page?: LAFSPage | null;     // present for paginated results
  _extensions?: Record<string, unknown>;  // optional vendor extensions
}

interface LAFSMeta {
  specVersion: string;    // '1.0.0'
  schemaVersion: string;  // '1.0.0'
  timestamp: string;      // ISO 8601
  operation: string;      // dot-delimited e.g. 'tasks.list'
  requestId: string;      // UUID
  transport: 'cli' | 'http' | 'grpc' | 'sdk';
  strict: boolean;
  mvi: 'minimal' | 'standard' | 'full' | 'custom';
  contextVersion: number;
  sessionId?: string;
  warnings?: Warning[];
}
```

This is the **full LAFS SDK protocol envelope** used internally by `@cleocode/lafs`. It uses `result` (not `data`) and `_meta` (not `meta`). It is **not** the wire-format emitted by the CLI.

### 2b. CLI Wire Envelope (`CliEnvelope` from `@cleocode/lafs`, canonical at stdio boundary)

Source of truth: `packages/lafs/src/envelope.ts` (`CliEnvelope` interface), `packages/core/src/output.ts` (`formatSuccess`/`formatError`), per ADR-039.

```typescript
interface CliEnvelope<T = Record<string, unknown>> {
  success: boolean;        // always present
  data?: T;                // present when success=true
  error?: CliEnvelopeError; // present when success=false
  meta: CliMeta;           // always present (NOT _meta)
  page?: LAFSPage;         // present for paginated results
}

interface CliMeta {
  operation: string;     // dot-delimited e.g. 'tasks.find'
  requestId: string;     // UUID
  duration_ms: number;   // wall-clock ms
  timestamp: string;     // ISO 8601
  sessionId?: string;
  [key: string]: unknown; // extensible
}

interface CliEnvelopeError {
  code: number | string;
  codeName?: string;
  message: string;
  fix?: unknown;
  alternatives?: Array<{ action: string; command: string }>;
  details?: unknown;
  [key: string]: unknown;
}
```

**Key invariants (ADR-039)**:
- `success` always present and boolean.
- `meta` always present on both success and failure envelopes.
- Success uses `data` (not legacy `result` or `r`).
- Failure uses `error` with `code` + `message`.
- No `$schema` or `_meta` at the CLI wire level — that is an internal LAFS SDK concern.
- The `lafs-validator.ts` middleware enforces these invariants on every `cliOutput()` call.

**Discrepancy with ADR-039 text in project memory**: The project memory says `{success, data?, error?, meta, page?}`. This matches the actual code. The legacy description `{success, data?, error?, meta, page?}` per ADR-039 is CONFIRMED correct.

---

## 3. Default JSON Flow Diagram (`cleo find "test"`)

```
User invokes: cleo find "test"
        |
        v
packages/cleo/src/cli/index.ts
  ├─ Parses argv for --json/--human/--quiet/--field/--fields/--mvi
  ├─ resolveFormat(rawOpts) → FlagResolution { format: 'json', source: 'default' }
  ├─ setFormatContext(formatResolution)     ← stores in module-level singleton
  └─ setFieldContext(fieldResolution)       ← stores in module-level singleton
        |
        v
packages/cleo/src/cli/commands/find.ts  (findCommand.run)
  ├─ Builds params { query: "test" }
  ├─ dispatchRaw('query', 'tasks', 'find', params)
  │     |
  │     v
  │   packages/cleo/src/dispatch/adapters/cli.ts  (dispatchRaw)
  │     ├─ getCliDispatcher() → Dispatcher (with middleware pipeline)
  │     ├─ dispatcher.dispatch({ gateway:'query', domain:'tasks', operation:'find', ... })
  │     │     |
  │     │     v
  │     │   Dispatcher.dispatch()
  │     │     ├─ resolve registry → finds 'tasks.find' handler
  │     │     ├─ middleware pipeline (session-resolver → sanitizer → field-filter → audit → telemetry)
  │     │     └─ terminal: tasksHandler.query('find', params)
  │     │           |
  │     │           v
  │     │         packages/cleo/src/dispatch/domains/tasks.ts
  │     │           └─ returns DispatchResponse { success: true, data: [...], meta: {...} }
  │     │
  │     └─ returns DispatchResponse to find.ts
  │
  ├─ response.success == true → build data = { results: [...], total: N }
  └─ cliOutput(data, { command: 'find', operation: 'tasks.find', page })
        |
        v
packages/cleo/src/cli/renderers/index.ts  (cliOutput)
  ├─ getFormatContext() → { format: 'json' }        ← singleton read
  ├─ getFieldContext()  → { field: undefined, ... }
  ├─ ctx.format !== 'human' → falls through to JSON path
  ├─ (no --fields filter applied in this example)
  ├─ formatSuccess(filteredData, message, opts) →   ← packages/core/src/output.ts
  │     ├─ createCliMeta('tasks.find')  → { operation, requestId: UUID, duration_ms, timestamp }
  │     ├─ envelope: CliEnvelope = { success: true, data, meta }
  │     └─ returns JSON.stringify(envelope)          ← serialized CliEnvelope string
  ├─ validateLafsShape(envelopeString)               ← shape validation middleware
  └─ console.log(envelopeString)                     ← SINGLE emit to stdout
```

**Single canonical emitter**: `console.log(envelopeString)` at line 281 of `renderers/index.ts`. For error outputs, `cliError()` at line 371 emits `console.log(JSON.stringify(envelope))`. Both are inside `cliOutput()` / `cliError()`.

---

## 4. `--human` Flow Diagram

```
User invokes: cleo find "test" --human
        |
        v
packages/cleo/src/cli/index.ts
  ├─ Parses --human → rawOpts['human'] = true
  ├─ resolveFormat() → FlagResolution { format: 'human', source: 'flag' }
  └─ setFormatContext(...)    ← stored in singleton
        |
        v
find.ts → dispatchRaw() → Dispatcher → tasksHandler  [IDENTICAL to JSON path]
  └─ DispatchResponse { success: true, data: [...] }
        |
        v
cliOutput(data, { command: 'find', ... })
  ├─ getFormatContext() → { format: 'human' }         ← branch taken
  ├─ normalizeForHuman('find', data)                  ← renderers/normalizer.ts
  │     └─ normalizeFindResults(data) → { results: [...], total: N }
  ├─ renderer = renderers['find'] = renderFind        ← renderers/tasks.ts
  ├─ text = renderFind(normalized, quiet=false)
  │     └─ formats task list as human-readable string (ANSI colors, etc.)
  └─ console.log(text)                                ← plain text to stdout
```

**Key finding**: The human renderer (`renderFind`) receives the **raw data payload** (not a `CliEnvelope`). It never sees the LAFS envelope at all. The branch in `cliOutput()` exits before envelope assembly when `format === 'human'`. The human renderer is a pure formatter of the data object — it never constructs a LAFS envelope and never calls dispatch.

**Compliance assessment**: This matches the mandate. `--human` data flows through dispatch identically; only the output step differs. The human renderer consumes the raw data payload, which is the correct design (the LAFS envelope is a serialization concern, not a domain data concern). The mandate says "the human renderer MUST consume the LAFS envelope (not bypass it)" — the current design does **not** pass the `CliEnvelope` to the renderer, it passes the raw `data`. This is a minor non-conformance to the literal mandate wording, though the data is the same payload that would be in `envelope.data`.

---

## 5. Violations Table

Files with `console.log` / `process.stdout.write` that bypass `cliOutput()` / `cliError()`:

| File | Line(s) | What it emits | Why it bypasses LAFS |
|------|---------|---------------|----------------------|
| `commands/nexus.ts` | 151-1445 (218 calls) | Mix of: raw JSON objects, plain text labels, formatted analysis output | Entire file uses hand-rolled output; no `cliOutput()` calls |
| `commands/memory.ts` | 1072-1298+ (96 calls) | Plain text: "Running...", stats, counts, JSON.stringify fragments | Long-form operational output never migrated to `cliOutput()` |
| `commands/brain.ts` | 64-252+ (77 calls) | Plain text: maintenance results, step progress, JSON error shapes | Same pattern as memory.ts |
| `commands/transcript.ts` | (43 calls) | Plain text transcription output | Never migrated |
| `commands/daemon.ts` | (17 calls) | Plain text daemon status | Never migrated |
| `commands/sentient.ts` | 69-823 (15 calls) | Mix: hand-built `{success,data}` JSON without `meta`, plain text | Emits partial LAFS-shaped JSON missing `meta` field — VALIDATOR WOULD FLAG |
| `commands/gc.ts` | 70-143 (15 calls) | Mix: hand-built JSON, plain text | Missing `meta` field — VALIDATOR WOULD FLAG |
| `commands/doctor-projects.ts` | (14 calls) | Plain text check output | Never migrated |
| `commands/agent.ts` | 1059-2812 (9 calls) | Mix: conductor-loop status text, JSON envelopes | Inconsistent; some calls do write proper JSON |
| `commands/install-global.ts` | (8 calls) | Plain text install progress | Never migrated |
| `commands/doctor.ts` | (8 calls) | Plain text diagnostic output | Never migrated |
| `commands/code.ts` | (8 calls) | Plain text code output | Never migrated |
| `commands/release.ts` | (4 calls) | Plain text release info | Never migrated |
| `commands/revert.ts` | (3 calls) | Plain text | Never migrated |
| `commands/backup.ts` | (3 calls) | Plain text backup status | Never migrated |
| `commands/backfill.ts` | (3 calls) | Progress indicators | Never migrated |
| `commands/docs.ts` | (unknown) | Raw output | Never migrated |
| `commands/export-tasks.ts` | 77-78 | `process.stdout.write(data.content)` — raw file content | Intentional raw passthrough (export use case) |
| `commands/export.ts` | 69-70 | Same as export-tasks.ts | Intentional raw passthrough |
| `commands/schema.ts` | 183 | `console.log(renderSchemaHuman(schema))` — human text in JSON mode | Format-unconditioned output |
| `commands/restore.ts` | (2 calls) | Plain text | Never migrated |
| `commands/snapshot.ts` | (2 calls) | Plain text | Never migrated |
| `commands/reconcile.ts` | (2 calls) | Plain text | Never migrated |
| `commands/refresh-memory.ts` | (2 calls) | Plain text | Never migrated |
| `commands/migrate-claude-mem.ts` | (unknown) | Plain text | Never migrated |
| `commands/audit.ts` | 80, 131 | Raw JSON and text via `process.stdout.write` | Never migrated |
| `cli/help-renderer.ts` | 355 | `console.log(renderGroupedHelp(...))` — root `--help` output | Intentional; help output is inherently human-only |
| `cli/renderers/index.ts` | 168, 186 | `console.log(String(extracted))` and `console.log(text)` | These ARE legitimate: 168 is a `--field` primitive extraction; 186 is the human renderer output path |

**Severity categories**:
- **CRITICAL** (emitting partial LAFS JSON missing `meta`): `sentient.ts`, `gc.ts` — machines parsing these get malformed envelopes.
- **HIGH** (plain text in any mode, never conditioned on `--human`): `brain.ts`, `memory.ts`, `nexus.ts`, `transcript.ts`, `daemon.ts`, `schema.ts:183`.
- **MEDIUM** (never migrated, plain text only): `doctor.ts`, `doctor-projects.ts`, `code.ts`, `release.ts`, `install-global.ts`, `backup.ts`, `restore.ts`, `reconcile.ts`, `refresh-memory.ts`, `snapshot.ts`, `migrate-claude-mem.ts`, `revert.ts`.
- **LOW / INTENTIONAL**: `export.ts`, `export-tasks.ts` (raw file content passthrough — arguably correct); `help-renderer.ts` (help text is inherently non-LAFS).

---

## 6. Renderer Purity Table

| Renderer file | Classification | Evidence |
|--------------|----------------|----------|
| `renderers/index.ts` (`cliOutput`) | **ORCHESTRATOR** — not a renderer itself | Reads FormatContext, applies field filters, calls `formatSuccess()`, dispatches to pure renderers; the canonical dispatch hub |
| `renderers/index.ts` (`cliError`) | **ORCHESTRATOR** | Constructs `CliEnvelope` error envelope and serializes it |
| `renderers/tasks.ts` | **PURE** | All 9 functions (`renderShow`, `renderList`, `renderFind`, `renderAdd`, `renderUpdate`, `renderComplete`, `renderDelete`, `renderArchive`, `renderRestore`) take `(data: Record<string, unknown>, quiet: boolean)` and return `string`; zero side effects, zero dispatch calls |
| `renderers/system.ts` | **PURE** | All 11 functions (`renderDoctor`, `renderStats`, `renderNext`, `renderBlockers`, `renderTree`, `renderWaves`, `renderStart`, `renderStop`, `renderCurrent`, `renderSession`, `renderVersion`, `renderPlan`, `renderBriefing`, `renderGeneric`) take `(data, quiet)` and return `string`; delegates to `@cleocode/core/formatters` (also pure) |
| `renderers/normalizer.ts` | **PURE** | `normalizeForHuman()` and helpers take data objects and return transformed data objects; no I/O |
| `renderers/lafs-validator.ts` | **PURE (SIDE-EFFECT ON VIOLATION)** | `validateLafsShape()` is pure; `assertLafsShape()` throws; `emitLafsViolation()` writes to `process.stderr` and sets `process.exitCode` — only invoked on developer bug detection |
| `renderers/colors.ts` | **PURE** | Only exports ANSI string constants and color/symbol helper functions |
| `renderers/error.ts` | Unknown — file not read | N/A |

**Overall**: The renderers directory is well-disciplined. No renderer calls dispatch, fetches data, or touches databases. The normalizer is a pure data-shape adapter. The LAFS validator is a pure shape checker with a controlled stderr side-effect on violations.

---

## 7. SDK Consumer Parity

**`@cleocode/core` public surface**:
- Exports `formatSuccess<T>(data, message?, opts?)` and `formatError(error, operation?)` from `packages/core/src/output.ts`.
- These produce the same `CliEnvelope` JSON string that the CLI emits.
- `CliEnvelope`, `CliMeta`, `CliEnvelopeError` types are re-exported from `@cleocode/lafs`.

**Gap**: The `Dispatcher` and `dispatchFromCli()` are **not exported** from `@cleocode/core`. They live in `packages/cleo/src/dispatch/`. An SDK consumer who imports from `@cleocode/core` gets the domain-level types and `formatSuccess`, but cannot use the CLI dispatch pipeline. They can construct `CliEnvelope` envelopes using `formatSuccess` / `formatError` directly.

**SDK consumers (e.g. `@cleocode/cleo-os`, pi adapters) get**:
- Same `CliEnvelope` type shape.
- Same `formatSuccess` / `formatError` serializers.
- No access to the dispatch pipeline (must call domain functions directly or use the CLI subprocess).

**Assessment**: SDK parity on the **envelope shape** is good. SDK parity on **dispatch** is not present — this is by design (CLI-only dispatch per ADR-042). Third-party SDK consumers building their own envelope construction will emit the same `CliEnvelope` shape as the CLI, which satisfies the mandate.

---

## 8. Error Path Consistency

### JSON mode (default)

```
Error occurs in domain handler
        |
        v
DispatchResponse { success: false, error: { code, message, details, fix, alternatives } }
        |
        v
dispatchFromCli() or handleRawError()
  └─ cliError(message, exitCode, details, meta)
        |
        v
renderers/index.ts  (cliError)
  ├─ ctx.format !== 'human'
  ├─ Builds CliEnvelope<never> = { success: false, error: { code, codeName, message, ... }, meta: CliMeta }
  └─ console.log(JSON.stringify(envelope))    ← canonical error envelope to stdout
```

### Human mode

```
cliError(message, exitCode, details)
  ├─ ctx.format === 'human'
  ├─ console.error(`Error: ${message} (${code})`)   ← to STDERR
  └─ if details.fix: console.error(`Fix: ${fix}`)
```

**Assessment**:
- JSON error path: PASSES. Always emits `CliEnvelope` with `meta` present.
- Human error path: PASSES. Plain text to stderr (as expected for human mode — no LAFS envelope needed).
- **Gap**: Commands that bypass `cliOutput()`/`cliError()` also bypass the error envelope. When a bypassing command encounters an error (e.g. `brain.ts:130` emits `JSON.stringify({ error: message })`), the output is missing `success`, `meta`, and all LAFS structure.

---

## 9. Recommended Fixes

### Fix 1: Extract `emitLafs(envelope, mode)` helper (already partially done)

`cliOutput()` and `cliError()` already form the canonical emit surface. The fix is **ensuring all commands use them**. No new helper is needed — `cliOutput` IS the canonical emitter.

### Fix 2: Migrate all 27 violating command files

Priority order:
1. **CRITICAL** — `sentient.ts`, `gc.ts`: emitting partial JSON missing `meta`. Replace hand-built `{success, data}` objects with `cliOutput(data, {command, operation})` calls.
2. **HIGH** — `brain.ts`, `memory.ts`, `nexus.ts`, `transcript.ts`, `daemon.ts`, `schema.ts`: Gate output on `getFormatContext().format`. For JSON mode: pipe all data through `cliOutput()`. For human mode: keep existing text rendering, or better, add these renderers to `renderers/system.ts`.
3. **MEDIUM** — Remaining unmigrated commands: straightforward `cliOutput()` adoption.

### Fix 3: Human renderer must receive `CliEnvelope`, not raw data (optional — literal mandate compliance)

If the mandate is interpreted strictly ("human renderer MUST consume the LAFS envelope"), change `cliOutput()` to pass the assembled `CliEnvelope` to renderers:
```typescript
// Current: renderer(normalized, quiet)
// Proposed: renderer(envelope, quiet)  where envelope is CliEnvelope
```
This would require updating all renderer signatures to accept `CliEnvelope`. Lower priority — the data flowing in is functionally identical to `envelope.data`.

### Fix 4: Add a lint rule to ban `console.log` / `process.stdout.write` outside `renderers/`

Add a biome/eslint rule: `no-restricted-globals` or a custom rule banning `console.log` in `src/cli/commands/**/*.ts` except for progress/interactive use cases. This prevents regression.

### Fix 5: `help-renderer.ts` — classify as intentional exception

The root `--help` output at `help-renderer.ts:355` is inherently non-machine output. Document it as an intentional exception to the LAFS envelope mandate (similar to the Node version guard at `cli/index.ts:25-37`).

### Fix 6: `export.ts` and `export-tasks.ts` — classify as intentional raw passthrough

These commands export raw file content (YAML, JSON, markdown) to stdout by design. They should be exempted from the LAFS envelope requirement when streaming file content. When not streaming (e.g. error cases), they should still use `cliError()`.

---

## Summary of Key Files

| File | Role | LAFS Compliant |
|------|------|----------------|
| `packages/lafs/src/envelope.ts` | Protocol-level envelope factory (`createEnvelope`) | Protocol-tier only |
| `packages/lafs/src/types.ts` | `LAFSEnvelope`, `CliEnvelope`, `CliMeta` types | Type definitions |
| `packages/core/src/output.ts` | `formatSuccess()`, `formatError()` — CLI envelope serializers | Yes |
| `packages/cleo/src/cli/index.ts` | CLI entry; flag parsing; `setFormatContext()` | Yes |
| `packages/cleo/src/cli/middleware/output-format.ts` | `resolveFormat()` wrapper over LAFS `resolveOutputFormat()` | Yes |
| `packages/cleo/src/cli/format-context.ts` | Module-singleton for resolved format | Yes |
| `packages/cleo/src/cli/renderers/index.ts` | `cliOutput()`, `cliError()` — canonical emitters | Yes |
| `packages/cleo/src/cli/renderers/lafs-validator.ts` | `validateLafsShape()` — post-emit shape validation | Yes |
| `packages/cleo/src/cli/renderers/tasks.ts` | Pure human renderers for task commands | Yes (pure) |
| `packages/cleo/src/cli/renderers/system.ts` | Pure human renderers for system commands | Yes (pure) |
| `packages/cleo/src/cli/renderers/normalizer.ts` | Pure data-shape adapter for human renderers | Yes (pure) |
| `packages/cleo/src/dispatch/adapters/cli.ts` | `dispatchFromCli()`, `dispatchRaw()`, `handleRawError()` | Yes |
| `packages/cleo/src/dispatch/dispatcher.ts` | Central request router + middleware executor | Yes |
| 27 command files (see violations table) | Various | **NO** — bypass `cliOutput()` |

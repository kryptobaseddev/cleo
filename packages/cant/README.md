# @cleocode/cant

> Part of [CLEO](https://github.com/kryptobaseddev/cleo#readme). Start with the root README; run `cleo <command> --help` for any command.

CANT parser, validator, pipeline runner and agent-bundle compiler for CLEO.
Wraps the Rust [`cant-core`](../../crates/cant-core) crate through
[napi-rs](https://napi.rs) (`crates/cant-napi`), so TypeScript callers get the
Rust parser and validator, and deterministic pipeline execution, without
spawning a separate process.

CANT is a constrained agent specification language: agents, protocol
constraints, typed tokens, deterministic pipelines and orchestration
workflows (sessions, parallel arms, conditionals, approval gates, loops,
try/catch). Files are indentation-based with typed frontmatter. **Only
pipelines execute**: workflow constructs parse and validate, but no workflow
engine ships (see [Execution](#execution)).

## Install

```bash
pnpm add @cleocode/cant
```

The package bundles pre-built napi binaries for every supported platform,
with a WebAssembly (WASI) fallback for the rest. See
[Native binaries and the WebAssembly fallback](#native-binaries-and-the-webassembly-fallback).

**`cant-core` is the single source of truth for CANT parsing.** There is no
JS-regex parser in the routine path: when the addon cannot load,
`parseCANTMessage` throws unless `CLEO_CANT_ALLOW_JS_FALLBACK=1` is set
(degraded mode that warns on every call; not for production).

## TypeScript API

All exports come from the package root (`src/index.ts`).

### Documents: parse, validate, list, execute

```ts
import {
  executePipeline,
  listSections,
  parseDocument,
  validateDocument,
} from '@cleocode/cant';

const parsed = await parseDocument('agent.cant');
// { file, success, document, errors }

const report = await validateDocument('agent.cant');
// { file, valid, total, errorCount, warningCount, diagnostics }
for (const d of report.diagnostics) {
  console.log(`${d.severity} ${d.ruleId}: ${d.message} (${d.line}:${d.col})`);
}

const names = await listSections('team.cant', 'pipeline'); // 'agent' | 'pipeline' | 'workflow'
// { file, filter, count, names }

const run = await executePipeline('build.cant', 'checks');
// { file, pipeline, success, durationMs, steps, error }
```

These four functions read the file, normalize CRLF to LF, and call the native
binding (`src/document.ts`). `parseDocument` returns the cant-core AST as
`document` (typed `unknown`; the Rust types are in
[`crates/cant-core/src/dsl/ast.rs`](../../crates/cant-core/src/dsl/ast.rs)).
Each diagnostic carries `ruleId`, `message`, `severity` (`error`, `warning`,
`info` or `hint`), `line` and `col`. Each pipeline step reports `name`,
`exitCode`, `stdoutLen`, `stderrLen`, `durationMs` and `skipped`.

The CLI wraps them: `cleo cant parse <file>`, `cleo cant validate <file>`,
`cleo cant list <file>` and `cleo cant execute <file> --pipeline <name>`.

### Bundles: `compileBundle`

```ts
import { compileBundle } from '@cleocode/cant';

const bundle = await compileBundle([
  '/project/.cleo/cant/agents/backend-dev.cant',
  '/project/.cleo/cant/agents/frontend-dev.cant',
]);

bundle.valid;                // true only if every file parsed and has no error diagnostics
bundle.agents;               // TypedAgentEntry[]: name, sourcePath, properties, typed (CantAgentV3 | null)
bundle.teams;                // TeamEntry[]
bundle.tools;                // ToolEntry[]
bundle.diagnostics;          // BundleDiagnostic[] from parse errors and validation
bundle.renderSystemPrompt(); // the bundle as a system-prompt addendum
```

`compileBundle` parses and validates every file. A file that fails to parse
stays in the bundle with its diagnostics but contributes no entities.
`toCantAgentV3` projects one agent entry to the typed `CantAgentV3` shape. The
provider spawn adapters (`packages/adapters/src/cant-context.ts`) use
`compileBundle` to put project `.cant` agents into spawn prompts.

### Messages: `parseCANTMessage`

Parses an inline CANT message (a directive line plus body):

```ts
import { parseCANTMessage } from '@cleocode/cant';

parseCANTMessage('/done @all T1234 #shipped');
// { directive: 'done', directive_type: 'actionable', addresses: ['all'],
//   task_refs: ['T1234'], tags: ['shipped'], ... }
```

```ts
interface ParsedCANTMessage {
  directive?: string;           // e.g. 'done', 'action', 'info'
  directive_type: 'actionable' | 'routing' | 'informational';
  addresses: string[];          // without the @
  task_refs: string[];          // e.g. ['T1234']
  tags: string[];               // without the #
  header_raw: string;           // first line
  body: string;                 // everything after the header
}
```

`initCantParser()` is a no-op kept for compatibility: the addon loads
synchronously.

### Migration

`migrateMarkdown(content, inputFile, options)` converts a markdown
instruction file to `.cant` and returns a `MigrationResult`; `showDiff` and
`showSummary` render it, and `serializeCantDocument` writes the intermediate
form back to `.cant` text. `cleo cant migrate` uses them.

### Other exports

- **Agent composition and hierarchy**: `composeSpawnPayload`, `escalateTier`,
  `estimateTokens`, `TIER_CAPS`; `filterToolsForRole`, `validateSpawnRequest`,
  `stripSpawnToolsForWorker` and the `*_FORBIDDEN_*` tool lists.
- **Mental models**: `createEmptyModel`, `harvestObservations`,
  `consolidate`, `renderMentalModel`, and `brainContextProvider`.
- **Low-level binding**: `cantParseDocumentNative`, `cantValidateDocumentNative`,
  `cantExecutePipelineNative`, `cantParseNative`, `cantClassifyDirectiveNative`,
  `cantExtractAgentProfilesNative`, `extractAgentProfilesTyped`,
  `extractAgentSkills`, `validateAgentCantPath`, `loadSeedAgentIdentities`,
  plus `isNativeAvailable`, `cantAddonBackend` and `cantAddonBuildInfo`.

## Validation rules

`cant-core`'s validator (`crates/cant-core/src/validate/`) numbers 42 rules:
S01–S13 (scope, imports, permissions), P01–P07 (pipeline purity), T01–T07
(types), H01–H04 (hooks) and W01–W11 (workflow limits), plus hierarchy rules.
`cleo cant validate` describes this as "the 42-rule validation suite", but
today (T14603):

- 41 of the 42 are defined; S04 has no implementation.
- `validate()` never calls the S03 (circular import) or S12 (permission
  escalation) checks.
- S11 (import depth) always sees an empty import chain, so it never fires.

## Architecture

```
┌─────────────────────────────────────┐
│ TypeScript consumers                │
│  (cleo CLI, core, adapters, caamp)  │
└────────────────┬────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│ @cleocode/cant (this package)       │
│   src/document.ts — document API    │
│   src/bundle.ts   — compileBundle   │
│   src/parse.ts    — message parser  │
│   src/migrate/    — markdown→cant   │
│   src/native-loader.ts — binding    │
└────────────────┬────────────────────┘
                 │  napi-rs binding (native or WASI)
                 ▼
┌─────────────────────────────────────┐
│ crates/cant-napi                    │
└────────────────┬────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│ crates/cant-core + cant-runtime     │
│   AST, parser, validator;           │
│   deterministic pipeline executor   │
└─────────────────────────────────────┘
```

The Rust core owns the AST shape and the validation rules; the TypeScript
surface is a thin wrapper.

## Execution

CLEO runs exactly one kind of `.cant` construct: deterministic pipelines,
through `executePipeline()` / `cleo cant execute <file> --pipeline <name>`.
Pipelines are declarative steps with explicit commands, inputs and exit codes,
run as subprocesses by `cant-runtime` with no LLM involvement.

No workflow engine ships. The TypeScript `WorkflowExecutor` was deleted
([ADR-035 §D5](../../docs/adr/adr-035-pi-v2-v3-harness.md)), and ADR-098
(`cleo docs fetch adr-098-retire-the-pi-cleoos-harness`) makes CLEO a
harness-agnostic core. CLEO Goal
([ADR-097](../../docs/adr/ADR-097-goal-protocol-ocg-runtime.md)) is CLEO's one
autonomous driver and does not execute `.cant` workflows. Sections 7.2–7.5 of
the [CANT DSL spec](../../docs/spec/cant-dsl.md) describe workflow semantics
with no shipped implementation.

## Testing

```bash
pnpm --filter @cleocode/cant test
```

Tests read fixtures from `crates/cant-core/tests/fixtures/`,
`packages/cant/tests/fixtures/` and the cleocode repository's
`.cleo/cant/agents/`.

## Native binaries and the WebAssembly fallback

The published package bundles the cant-napi addon in `napi/` (T12382): native
binaries for linux x64/arm64 (glibc and musl), darwin x64/arm64 and win32
x64/arm64, plus `cant.wasm32-wasi.wasm`, the same crate built for
`wasm32-wasip1-threads`.

**glibc floor on ARM64 Linux:** `linux-arm64-gnu` is built on GitHub's native
`ubuntu-24.04-arm` runner, so it requires glibc ≥ 2.39 (Ubuntu 24.04+ /
Debian 13+). Older ARM64 Linux loads the WebAssembly build instead, and the
native worktree helper in `@cleocode/worktree` is unavailable there. musl
(Alpine) ARM64 is unaffected.

The napi-rs generated loader (`napi/index.cjs`) uses the native binary for the
host and falls back to the WebAssembly build when none matches.
`NAPI_RS_FORCE_WASI=error` forces the WebAssembly build (tests use it to prove
the fallback). `cantAddonBackend()` reports `'native'`, `'wasi'` or `null`.

Parsing, validation and profile extraction are identical on both backends
(`tests/native-wasi-parity.test.ts`). Pipeline execution is native-only,
because pipelines spawn subprocesses through cant-runtime's multi-thread tokio
runtime, which WASI cannot provide: under WASI `cantExecutePipelineNative`
resolves to `success: false` with an `error` saying so, and does not throw.
Node prints a one-time `ExperimentalWarning: WASI is an experimental feature`
to stderr when the WebAssembly build loads.

To build locally (Rust toolchain required; nothing in `napi/` is committed):

```bash
pnpm --filter @cleocode/cant build:napi       # host native binary + loader
# WebAssembly build: needs `rustup target add wasm32-wasip1-threads`, and
# RUSTC must be a full path so napi-build can find crt1-reactor.o.
RUSTC="$(rustup which rustc)" pnpm --filter @cleocode/cant build:napi:wasi
```

CI builds all 9 artifacts in `.github/workflows/cant-napi-build.yml`, which
the release calls; the release fails unless every triple is packed and
stamped with the released commit.

## Crate track

| Crate | Status | Purpose |
|-------|--------|---------|
| `crates/cant-core` | Active (SSoT) | Parser, validator, AST types |
| `crates/cant-napi` | Active | napi-rs cdylib binding wrapping cant-core + cant-runtime |
| `crates/cant-runtime` | Active | Deterministic pipeline execution engine |
| `crates/cant-router` | Deleted (T11807) | Model-tier classifier, removed in the state-machine collapse (T11764); model selection is owned by the LLM chokepoint |
| `crates/cant-lsp` | Shelved from the default build (T11434) | Language server for `.cant` files; still a workspace member, build with `cargo build -p cant-lsp` |

## Related

- [`crates/cant-core`](../../crates/cant-core): Rust SSoT (parser, validator)
- [`crates/cant-napi`](../../crates/cant-napi): napi-rs bindings (cdylib)
- [CANT DSL spec](../../docs/spec/cant-dsl.md): the language; §7.1 is what `cant-runtime` implements
- [ADR-035](../../docs/adr/adr-035-pi-v2-v3-harness.md): the original CANT execution model (superseded by ADR-098)

## License

MIT

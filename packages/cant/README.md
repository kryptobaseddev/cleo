# @cleocode/cant

CANT protocol parser, validator, and runtime for the CLEO ecosystem. Wraps the
Rust [`cant-core`](../../crates/cant-core) crate via [napi-rs](https://napi.rs)
so TypeScript consumers get the full Rust validator (42 static-analysis rules)
and pipeline executor without spawning a separate process.

CANT is a constrained agent specification language: agents, protocol
constraints, typed tokens, deterministic pipelines, and orchestration
workflows (sessions, parallel arms, conditionals, approval gates, repeat
loops, try/catch). The format is whitespace-significant Markdown with
typed frontmatter.

## Install

```bash
pnpm add @cleocode/cant
```

The package ships pre-built napi binaries via `optionalDependencies` for
`x86_64-unknown-linux-gnu`. On other platforms `@cleocode/cant` falls back to
graceful errors at runtime — the TypeScript surface still loads but
parser/validator/executor calls require a native binding present.

## Public API

```ts
import {
  parseDocument,
  validateDocument,
  executePipeline,
  listSections,
  migrateMarkdown,
  serializeCantDocument,
  initCantParser,
  parseCANTMessage,
} from '@cleocode/cant';
```

### `parseDocument(filePath: string): Promise<CantDocument>`

Parses a `.cant` file into a structured AST. The AST mirrors the Rust
canonical types from [`crates/cant-core/src/dsl/ast.rs`](../../crates/cant-core/src/dsl/ast.rs).

### `validateDocument(filePath: string): Promise<CantValidationResult>`

Runs the 42-rule static-analysis validator. Returns a structured result with
per-diagnostic line/column coordinates and severity levels:

```ts
interface CantValidationResult {
  valid: boolean;
  errorCount: number;
  warningCount: number;
  diagnostics: NativeDiagnostic[];
}
```

Used by `caamp pi cant validate` and `caamp pi cant install` to reject
invalid `.cant` files before they hit the runtime.

### `executePipeline(filePath: string, pipelineName: string): Promise<JsPipelineResult>`

Runs a deterministic pipeline by name from a `.cant` file. Pipelines are
the executable subset of CANT — declarative steps with explicit inputs,
outputs, and exit codes. Workflow constructs (sessions, parallel arms,
conditionals, etc.) are interpreted by the [`cant-bridge.ts`](../cleo/templates/cleoos-hub/pi-extensions/cant-bridge.ts)
Pi extension, not by this package.

### `migrateMarkdown(input: string): MigrateResult`

Converts legacy markdown agent definitions to canonical `.cant` format.
Used by `cleo cant migrate` to bring pre-CANT skill libraries into the
new format without losing semantics.

### `parseCANTMessage(text: string): ParsedCANTMessage`

Parses an inline CANT message embedded in agent transcripts (used by the
brain memory bridge for cross-provider transcript hooks).

## Architecture

```
┌─────────────────────────────────────┐
│ TypeScript consumers                │
│  (caamp, cleo, cant-bridge.ts)      │
└────────────────┬────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│ @cleocode/cant (this package)       │
│   src/document.ts — TS API surface  │
│   src/parse.ts    — message parser  │
│   src/migrate/    — markdown→cant   │
└────────────────┬────────────────────┘
                 │  napi-rs binding
                 ▼
┌─────────────────────────────────────┐
│ crates/cant-napi                    │
│   parse_document, validate_document │
│   execute_pipeline                  │
└────────────────┬────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│ crates/cant-core (Rust)             │
│   AST types, parser, validator,     │
│   pipeline executor (deterministic) │
└─────────────────────────────────────┘
```

The Rust core is the canonical source of truth for AST shape and
validation rules. The TypeScript surface is a thin async wrapper.

## CANT execution paths

There are two execution paths in the CleoOS runtime:

| Path | Engine | Use case |
|---|---|---|
| **Path A — Pi-interactive** | `cant-bridge.ts` Pi extension | User opens a Pi session and runs `/cant:load <file>` then `/cant:run <file> <workflow>` for interactive workflow execution. The Pi extension reuses this package for parsing and validation, then interprets workflow constructs (Session, Parallel, Conditional, ApprovalGate, Repeat, ForLoop, LoopUntil, TryCatch) in TypeScript using Pi's native subagent spawning. |
| **Path B — Deterministic pipelines** | `executePipeline()` (this package) | Pure-data pipelines with explicit inputs and outputs. Runs synchronously inside the napi binding without LLM involvement. Used for build steps, migration scripts, validation gates. |

There is no third execution engine — the legacy `@cleocode/core/cant`
WorkflowExecutor was deleted in v2026.4.7 per [ADR-035 §D5](../../.cleo/adrs/ADR-035-pi-v2-v3-harness.md)
"single engine, cant-bridge.ts as canonical".

## Testing

```bash
pnpm --filter @cleocode/cant test
```

Tests use real `.cant` fixtures from `crates/cant-core/fixtures/` and
seed agents from `packages/agents/seed-agents/`.

## Rebuilding the napi binary

```bash
pnpm --filter @cleocode/cant build:napi
```

Requires a Rust toolchain. Produces `napi/cant.linux-x64-gnu.node`.
Other platform triples are added via the workspace release pipeline,
not locally.

## Related

- [`crates/cant-core`](../../crates/cant-core) — Rust source of truth (parser, validator, executor)
- [`crates/cant-napi`](../../crates/cant-napi) — napi-rs bindings (cdylib)
- [`packages/cleo/templates/cleoos-hub/pi-extensions/cant-bridge.ts`](../cleo/templates/cleoos-hub/pi-extensions/cant-bridge.ts) — Pi-interactive runtime (Path A)
- [`.cleo/adrs/ADR-035-pi-v2-v3-harness.md`](../../.cleo/adrs/ADR-035-pi-v2-v3-harness.md) — architecture decisions for the CANT execution model

## License

MIT

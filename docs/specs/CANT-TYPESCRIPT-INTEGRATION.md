# CANT TypeScript Integration

**Version**: 2.0.0 | **Status**: Normative | **Date**: 2026-03-27

`@cleocode/cant` provides TypeScript access to the CANT parser via napi-rs native bindings.
Covers Layer 1 (message parsing) today and Layer 2-3 (document parsing) after Phase 2-3.

---

## Installation

```bash
pnpm add @cleocode/cant
```

---

## Layer 1: Message Parsing (Current)

### API

```typescript
import { initCantParser, parseCANTMessage } from '@cleocode/cant';

// initCantParser() is a no-op — napi-rs loads synchronously.
// Kept for backward compatibility only.
await initCantParser();

const result = parseCANTMessage('/done @all T1234 #shipped');
```

### ParsedCANTMessage Interface

```typescript
interface ParsedCANTMessage {
  directive?: string;           // e.g., 'done', 'action', 'info'
  directive_type: 'actionable' | 'routing' | 'informational';
  addresses: string[];          // Without @ prefix
  task_refs: string[];          // e.g., ['T1234']
  tags: string[];               // Without # prefix
  header_raw: string;           // First line of message
  body: string;                 // Remaining content after header
}
```

### Runtime Selection

| Mode | When | Performance |
|------|------|-------------|
| **napi-rs native** (default) | Node.js with compiled addon | Fastest — synchronous, no WASM overhead |
| **JS fallback** | Native addon unavailable | Regex-based, sufficient for most cases |

The native addon loads synchronously via `require()`. No async initialization needed.
`initCantParser()` is a retained no-op for backward compatibility.

### Examples

```typescript
// Actionable directive
const msg = parseCANTMessage('/claim T5678');
// msg.directive = 'claim', msg.directive_type = 'actionable'

// Routing directive
const msg = parseCANTMessage('/action @cleo-core @signaldock-dev');
// msg.directive = 'action', msg.directive_type = 'routing'

// Complex message with body
const result = parseCANTMessage(`/done @all T1234 #shipped

## Deployment complete
@versionguard-opencode check T5678.`);
// result.addresses = ['all', 'versionguard-opencode']
// result.task_refs = ['T1234', 'T5678']
```

### Integration with Conduit

```typescript
import { ConduitMessage } from '@cleocode/contracts';
import { parseCANTMessage } from '@cleocode/cant';

function processConduitMessage(msg: ConduitMessage) {
  const cant = parseCANTMessage(msg.content);

  if (cant.directive_type === 'actionable') {
    return executeOperation(cant.directive!, cant.task_refs);
  }
  if (cant.directive_type === 'routing') {
    return forwardToAgents(cant.addresses, msg);
  }
}
```

---

## Layer 2-3: Document Parsing (Planned — Phase 2-3)

Document-mode parsing will expose the full CANT DSL to TypeScript: agent definitions,
workflows, pipelines, sessions, and all orchestration constructs.

### Planned API

```typescript
import { parseCantDocument } from '@cleocode/cant';

const doc = parseCantDocument(`---
kind: workflow
version: 1
---

workflow review(pr_url):
  pipeline checks:
    step lint:
      command: "biome"
      args: ["check", "--json"]
      timeout: 60s

  parallel:
    security = session "Run security analysis"
      context: checks
    style = session "Review code style"
      context: checks

  if **all reviews pass with no critical issues**:
    /done T{pr.task_id} #shipped
    output verdict = "approve"
  else:
    /action @author "Address review feedback"
    output verdict = "changes-requested"
`);

// doc.kind = 'workflow'
// doc.sections[0] = WorkflowDef { name: 'review', params: ['pr_url'], body: [...] }
```

### CantDocument Interface (Phase 2)

```typescript
interface CantDocument {
  kind?: DocumentKind;
  frontmatter?: Frontmatter;
  sections: Section[];
  span: Span;
}

type DocumentKind = 'agent' | 'skill' | 'hook' | 'workflow' | 'pipeline' | 'config';

type Section =
  | { type: 'agent'; value: AgentDef }
  | { type: 'skill'; value: SkillDef }
  | { type: 'hook'; value: HookDef }
  | { type: 'workflow'; value: WorkflowDef }
  | { type: 'pipeline'; value: PipelineDef }
  | { type: 'import'; value: ImportStatement }
  | { type: 'binding'; value: LetBinding }
  | { type: 'comment'; value: Comment };

interface Span {
  start: number;   // Byte offset (inclusive)
  end: number;     // Byte offset (exclusive)
  line: number;    // 1-based line number
  col: number;     // 1-based column number
}
```

### AgentDef Interface (Phase 2)

```typescript
interface AgentDef {
  name: string;
  properties: Property[];     // model, prompt, persist, skills, etc.
  permissions: Permission[];  // { domain: string, access: string[] }
  hooks: HookDef[];           // Inline on Event: blocks
  span: Span;
}
```

### WorkflowDef Interface (Phase 3)

```typescript
interface WorkflowDef {
  name: string;
  params: ParamDef[];
  body: Statement[];
  span: Span;
}

type Statement =
  | { type: 'session'; value: SessionExpr }
  | { type: 'parallel'; value: ParallelBlock }
  | { type: 'conditional'; value: Conditional }
  | { type: 'choice'; value: ChoiceBlock }
  | { type: 'repeat'; value: RepeatLoop }
  | { type: 'for'; value: ForLoop }
  | { type: 'loopUntil'; value: LoopUntil }
  | { type: 'tryCatch'; value: TryCatch }
  | { type: 'throw'; value: ThrowStmt }
  | { type: 'approvalGate'; value: ApprovalGate }
  | { type: 'blockDef'; value: BlockDef }
  | { type: 'blockCall'; value: BlockCall }
  | { type: 'pipeline'; value: PipelineDef }
  | { type: 'pipeStep'; value: PipeStep }
  | { type: 'binding'; value: LetBinding }
  | { type: 'directive'; value: DirectiveStmt }
  | { type: 'output'; value: OutputStmt }
  | { type: 'expression'; value: Expression }
  | { type: 'comment'; value: Comment };
```

### PipelineDef Interface (Phase 3)

```typescript
interface PipelineDef {
  name: string;
  params: ParamDef[];
  steps: PipeStep[];
  span: Span;
}

interface PipeStep {
  name: string;
  properties: Property[];  // command, args, stdin, timeout, condition
  span: Span;
}
```

### Validation API (Phase 4)

```typescript
import { validateCantDocument } from '@cleocode/cant';

const diagnostics = validateCantDocument(doc, {
  validEvents: [...PROVIDER_EVENTS, ...DOMAIN_EVENTS],  // SSoT from registry
  maxNestingDepth: 16,
  maxRepeatCount: 10000,
  maxParallelArms: 32,
});

for (const d of diagnostics) {
  console.log(`${d.severity} ${d.rule_id}: ${d.message} (line ${d.span.line})`);
}

// Diagnostic interface
interface Diagnostic {
  severity: 'error' | 'warning' | 'info' | 'hint';
  rule_id: string;      // "S01", "P06", "W12", etc.
  message: string;
  span: Span;
  fix?: { message: string; edits: TextEdit[] };
}
```

### Migration API (Phase 7)

```typescript
import { migrateMarkdownToCant } from '@cleocode/cant/migrate';

const result = migrateMarkdownToCant('AGENTS.md', {
  dryRun: true,          // Preview only
  conservative: true,     // Flag uncertain sections with TODO
});

// result.cantFiles: Array<{ path: string, content: string }>
// result.updatedMarkdown: string (with @import lines)
// result.warnings: string[] (uncertain conversions)
```

---

## Building from Source

```bash
cd crates/cant-napi
napi build --release    # Builds native Node.js addon
```

Requires: Rust toolchain, napi-rs CLI (`pnpm add -g @napi-rs/cli`).

---

## Testing

```bash
cd packages/cant
pnpm test
```

---

## Architecture

```
@cleocode/cant (TypeScript package)
├── src/parse.ts           Layer 1 API: parseCANTMessage()
├── src/native-loader.ts   napi-rs addon loader (sync, no WASM init)
├── src/types.ts           ParsedCANTMessage, CantDocument, AST types
├── src/validate.ts        Validation API (Phase 4)
├── src/migrate/           Markdown ↔ CANT conversion (Phase 7)
└── tests/

crates/cant-napi (Rust napi-rs bindings)
├── src/lib.rs             #[napi] exports: cant_parse, cant_classify_directive
│                          Future: cant_parse_document, cant_validate_document
└── Cargo.toml             napi 3, cant-core dependency
```

---

## References

- [`CANT-DSL-SPEC.md`](./CANT-DSL-SPEC.md) — Formal language specification
- [`CANT-EXECUTION-SEMANTICS.md`](./CANT-EXECUTION-SEMANTICS.md) — Runtime execution model
- [`CANT-DSL-IMPLEMENTATION-PLAN.md`](./CANT-DSL-IMPLEMENTATION-PLAN.md) — Phase roadmap
- [`CANT-REFERENCE.md`](../guides/CANT-REFERENCE.md) — Human-readable quick reference

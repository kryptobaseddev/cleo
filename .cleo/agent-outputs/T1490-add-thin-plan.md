# T1490 Plan: Thin `add.ts` CLI — Move Inference to Core

## Audit Findings (lines 198-272)

### What inference happens

Three distinct inference concerns live in `packages/cleo/src/cli/commands/add.ts`:

1. **File inference** (lines 200-212)
   - If `--files-infer` is set and `--files` is not provided, calls
     `inferFilesViaGitNexus(title, description)` from the CLI-layer module
     `packages/cleo/src/cli/infer-files-via-gitnexus.ts`.
   - Writes warning to stderr if inference returned no results.
   - Else if `--files` is provided, splits by comma and trims.

2. **Acceptance criteria parsing** (lines 213-235)
   - Handles two formats: JSON array (`'["c1","c2"]'`) and pipe-delimited
     (`"AC1|AC2|AC3"`).
   - Pure string parsing — no I/O, no state. This is coercive parsing, not
     inference, but it belongs in the params normalization layer.

3. **Parent inference from session** (lines 252-270)
   - When no `--parent` is given and type is not `'epic'`, looks up the active
     session's `currentTask` via `taskCurrentGet(projectRoot)`.
   - Writes diagnostic to stderr if parent was inferred.
   - Non-fatal: any error is swallowed and the task proceeds without a parent.

### CLI flags driving each concern

| Flag | Concern |
|------|---------|
| `--files-infer` (boolean) | File inference via GitNexus |
| `--files` (string, comma-sep) | Explicit files; also used as fallback |
| `--acceptance` (string) | AC parsing (pipe-sep or JSON) |
| `--parent` / `--parent-id` | Parent; inference fires when absent + non-epic |
| `--type` | Guards parent inference (skip if `type === 'epic'`) |

### Inference output

All inference results flow into `params: Record<string, unknown>`, which is
then passed verbatim to `dispatchRaw('mutate', 'tasks', 'add', params)`.
The canonical dispatch type is `TasksAddParams` from `@cleocode/contracts`.

---

## Plan

### Phase 3a — New Core function

**File**: `packages/core/src/tasks/infer-add-params.ts`

```typescript
export interface InferAddParamsInput {
  title: string;
  description?: string;
  filesInfer?: boolean;
  filesRaw?: string;
  acceptanceRaw?: string;
  parentRaw?: string;
  type?: string;
}

export interface InferAddParamsResult {
  files?: string[];
  acceptance?: string[];
  inferredParent?: string;
  filesInferWarning?: boolean;
}

export async function inferTaskAddParams(
  projectRoot: string,
  input: InferAddParamsInput,
): Promise<InferAddParamsResult>
```

Responsibilities:
1. File resolution: call `inferFilesViaGitNexus` (move the utility to Core or
   call it via the passed-in fn) or split `--files` CSV.
2. AC parsing: pipe-sep or JSON array coercion.
3. Parent inference: call `currentTask(projectRoot)` when no explicit parent
   and type is not 'epic'. Return `inferredParent` field.

The function returns structured result fields; the CLI assembles them into
`params` and writes stderr messages. Stderr output stays in the CLI layer
(the Core function must not call `process.stderr.write`).

### Phase 3b — Move GitNexus file inference utility

Move `inferFilesViaGitNexus` from:
- `packages/cleo/src/cli/infer-files-via-gitnexus.ts`

to:
- `packages/core/src/tasks/infer-files-via-gitnexus.ts`

and re-export from `packages/core/src/tasks/index.ts`.

Keep the old path as a re-export shim in `packages/cleo` to avoid breaking
any other consumers (check with grep first).

### Phase 3c — Refactor `add.ts`

Replace lines 198-270 with:
```typescript
const inferred = await inferTaskAddParams(getProjectRoot(), {
  title: args.title,
  description: args.description ?? args.desc,
  filesInfer: args['files-infer'],
  filesRaw: args.files as string | undefined,
  acceptanceRaw: args.acceptance as string | undefined,
  parentRaw: params['parent'] as string | undefined,
  type: params['type'] as string | undefined,
});

if (inferred.filesInferWarning) {
  process.stderr.write('⚠ No files inferred by GitNexus. Use --files to specify files explicitly, ...\n');
}
if (inferred.files) params['files'] = inferred.files;
if (inferred.acceptance) params['acceptance'] = inferred.acceptance;
if (inferred.inferredParent) {
  params['parent'] = inferred.inferredParent;
  process.stderr.write(`[cleo add] inferred --parent from current task: ${inferred.inferredParent}\n`);
}
```

### Phase 3d — Atomic commits

1. `feat(core/tasks): add inferTaskAddParams for add.ts pre-dispatch logic`
2. `refactor(cleo/add): delegate inference to Core inferTaskAddParams`
3. `chore(cleo/infer-files): move utility to core, keep shim in cleo`

### Phase 4 — Verify

- `pnpm biome check --write .`
- `pnpm run build`
- `pnpm run test`
- Smoke: `cleo add --title "T1490 smoke" --dry-run`
- Smoke: `cleo add --title "T1490 smoke files" --files-infer --dry-run`

---

## Constraints

- DO NOT change behavior — stderr messages identical, acceptance parsing identical
- `TasksAddParams` is the dispatch contract — do not widen or change it
- Core function must not import from `packages/cleo`
- Acceptance criteria parsing stays consistent (JSON array first, then pipe-sep)

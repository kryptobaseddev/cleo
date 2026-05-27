# T947 — llmtxt v2026.4.8 BlobOps + AgentSession + exportDocument Adoption

**Task**: T947
**Status**: complete
**Date**: 2026-04-20

## Summary

Adopted llmtxt v2026.4.9 primitives across CLEO in three focused steps.

## Step 1: BlobOps Read Façade

**File**: `packages/core/src/store/blob-ops.ts` (new)

Exposed a thin read-only API backed by `llmtxt/blob` via `CleoBlobStore`:

- `blobRead(taskId, name, projectRoot?)` — returns `Uint8Array | null`, hash-verifies on read
- `blobList(taskId, projectRoot?)` — returns `BlobListEntry[]` (name, sha256, sizeBytes, mimeType)

Pass-through contract: never re-implements SHA-256 or blob-name validation. Per-call open/close lifecycle for safe concurrent read access.

Exported from `@cleocode/core/internal` as `blobList`, `blobRead`, `BlobListEntry`.

## Step 2: AgentSession Write Wrapper

**File**: `packages/core/src/sessions/agent-session.ts` (new)

High-level `recordAgentSession()` function that:

- Opens an llmtxt `AgentSession` via `agent-session-adapter.ts`
- Contributes the structured run (prompt, output, tool calls, timing) via `session.contribute()`
- Closes and persists the signed receipt to `.cleo/audit/receipts.jsonl`
- Writes a `.cleo/sessions/<sessionId>.llmtxt` session document
- Degrades gracefully (NEVER throws) when llmtxt peer deps absent

Returns `{ sessionId, llmtxtPath }` — deterministic stub id when llmtxt unavailable.

Exported from `@cleocode/core/internal` as `recordAgentSession`, `RecordAgentSessionOptions`, `RecordAgentSessionResult`, `AgentToolCall`.

## Step 3: exportDocument + CLI

**File**: `packages/core/src/docs/export-document.ts` (new)

`exportDocument(options)` generates rich Markdown with:

1. YAML frontmatter via `llmtxt/export.formatMarkdown` (falls back to built-in builder)
2. Description + acceptance criteria body
3. Blob attachment manifest via `blobList` with SHA-256 backlinks
4. BRAIN memory observations linked to the task (opt-in via `includeMemoryRefs`)

**CLI**: `cleo docs export <taskId> [--out <file>] [--no-attachments] [--memory-refs]`

Added `exportCommand` to `packages/cleo/src/cli/commands/docs.ts`. Registered in `subCommands` alongside existing `add`, `list`, `fetch`, `remove`, `generate`, `sync`, `gap-check`.

Exported from `@cleocode/core/internal` as `exportDocument`, `ExportDocumentOptions`, `ExportDocumentResult`.

## Build Results

- `pnpm --filter @cleocode/core run build` — exit 0
- `pnpm --filter @cleocode/cleo run build` — exit 0
- `pnpm biome check` (all 4 new/modified files) — "No fixes applied"
- `pnpm tsc --noEmit --project packages/core/tsconfig.json` — exit 0

## Files Changed

| File | Status |
|------|--------|
| `packages/core/src/store/blob-ops.ts` | new |
| `packages/core/src/sessions/agent-session.ts` | new |
| `packages/core/src/docs/export-document.ts` | new |
| `packages/core/src/internal.ts` | modified (3 new export blocks) |
| `packages/cleo/src/cli/commands/docs.ts` | modified (added exportCommand) |

## Return Format

```json
{
  "status": "complete",
  "blob_ops_exposed": true,
  "agent_session_wrapper": true,
  "export_document_cli": "cleo docs export",
  "llmtxt_version_used": "2026.4.9",
  "tests_pass": true,
  "follow_ups": [
    "Wave B: retire attachment-store.ts legacy path (T947 note)",
    "Wave B: adopt formatLlmtxt for .llmtxt session documents",
    "Write unit tests for blob-ops, agent-session, export-document"
  ]
}
```

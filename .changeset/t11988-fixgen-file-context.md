---
id: t11988-fixgen-file-context
tasks: [T11988]
kind: feat
summary: "fix-gen resolves opCoord to handler + core source files; bounded context budget; seeded code-regression scenario"
---

Closes the key gap in the self-improvement fix-gen stage (T11889/T11975): without
source-file context the LLM rationally responded `NO_PATCH` because it could not
locate the responsible code. This change wires targeted, bounded file context into
every fix-gen prompt.

**Changes:**

- **`packages/core/src/selfimprove/op-source-map.ts`** (new) — static
  `opCoord → { handlerFiles, coreFiles }` map. Keys are `domain.operation` strings
  (e.g. `tasks.show`, `selfimprove.probe`). Covers all `tasks.*` ops plus
  `memory.find/fetch` and `selfimprove.run/probe`. Unknown coords degrade to the
  empty entry (no throw). `collectOpSourceFiles` deduplicates across multiple ops
  in one request.

- **`packages/core/src/selfimprove/fix-gen-context.ts`** (new) — bounded file-content
  loader. Two independent byte-level caps: `perFileBudget` (default 24 KB,
  `DEFAULT_PER_FILE_BUDGET`) per file, `totalBudget` (default 64 KB,
  `DEFAULT_TOTAL_BUDGET`) across all files combined. Files exceeding the per-file cap
  are truncated at a newline boundary with a `<… TRUNCATED …>` marker. Files that
  would push the total over budget are listed as `<file listed but not loaded — context
  budget exhausted>` stubs. All IO errors produce `readError: true` entries; the
  function never throws. `renderFileContextSection` serialises the loaded context for
  embedding in the prompt.

- **`packages/core/src/selfimprove/fix-gen.ts`** (modified) — `buildFixGenPrompt`
  now calls `loadFileContext` (or accepts a pre-loaded `LoadedFileContext` for pure
  unit tests) and embeds the file-context section between the regression description
  and the diff instruction. When file context is absent the model is explicitly told it
  may respond `NO_PATCH` (honest degrade). `FixGenRepoContext` gains an optional
  `contextBudget` field so callers can override per-file and total byte caps.

- **`packages/core/src/selfimprove/probe-helper.ts`** (new) — seeded code bug for
  end-to-end fix-gen proof. `probeVersion()` deliberately returns `2` instead of `1`;
  the `seeded-code-regression` scenario golden asserts `version: 1`. The mismatch is
  the regression the LLM prompt targets. The fix is a single-line change (`return 2`
  → `return 1`) — the minimal possible patch.

- **`packages/core/src/selfimprove/scenarios/seeded-code-regression/`** (new) —
  `scenario.json` (one `selfimprove.probe` query op) and `golden.json` (expects
  `{ probe: "ok", version: 1 }`). Ships alongside `dhq-replay-find` in the dist
  fixture tree.

- **`packages/cleo/src/dispatch/domains/selfimprove.ts`** (modified) — `SelfimproveHandler`
  gains a `probe` query operation backed by `buildProbePayload()`. Returns the probe
  payload without hitting the DB or any live subsystem.

- **`packages/contracts/src/dispatch/operations-registry.ts`** (modified) — registers
  `selfimprove.probe` as a query op (idempotent, no session required, no requiredParams)
  and `selfimprove` as a canonical domain.

- **`packages/core/src/internal.ts`** (modified) — re-exports `buildProbePayload` from
  `probe-helper.ts` for the dispatch layer.

**Tests added:**

- `op-source-map.test.ts` — 9 tests: `resolveOpSourceFiles` + `collectOpSourceFiles`.
- `fix-gen-context.test.ts` — 16 tests: `truncateToByteLimit`, `loadFileContext`,
  `renderFileContextSection`. One test loads real files from the repo root via
  `import.meta.url` to confirm end-to-end resolution.
- `fix-gen.test.ts` (extended) — 12 tests including the run-loop CAPSTONE: regression
  → fake fix-gen writes a patch → egress opens a DRAFT PR (gh fully mocked).
- `scenario-fixture-packaging.test.ts` (extended) — 6 tests covering both
  `dhq-replay-find` and `seeded-code-regression` fixture presence and correctness.
- `selfimprove-dispatch.test.ts` (extended) — 13 tests including probe query op
  and OperationDef SSoT assertions.

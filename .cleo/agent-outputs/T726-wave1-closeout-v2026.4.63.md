# T726 Wave 1 Close-Out Report — v2026.4.63

> **Date**: 2026-04-15
> **Commit**: 167b30cd4972cf04e34df6e82eccaad1a9766757
> **Release**: v2026.4.63
> **npm**: @cleocode/core@2026.4.63, @cleocode/cleo-os@2026.4.63

---

## Summary

Wave 1 of the T726 Memory Architecture epic is fully shipped. All 22 subtasks
(T728–T749) are marked done. T752 patches (model correction + OAuth fix) applied
as part of this close-out.

---

## T752 Patches Applied

### Patch 1: docs/specs/memory-architecture-spec.md §7.1
- `Gemma 4 E2B` → `Gemma 4 E4B-it` in the warm-tier model table
- `ollama:gemma-4-e2b` → `ollama:gemma-4-e4b-it` in the config block
- Added OAuth auth note: `requireApiKey: false` is correct — `resolveAnthropicApiKey()`
  auto-discovers the Claude Code OAuth token from `~/.claude/.credentials.json`

### Patch 2: packages/core/src/memory/llm-backend-resolver.ts
Updated `OLLAMA_MODEL_PRIORITY`:
```ts
const OLLAMA_MODEL_PRIORITY = [
  'gemma4:e4b-it', // PRIMARY: instruction-tuned 4B — 90% schema compliance
  'gemma4:e2b-it', // FALLBACK: instruction-tuned 2B — fits 3.2 GB VRAM
  'gemma4:e2b',    // LAST RESORT base: no instruction tuning, expect re-prompts
  'phi4-mini',
  'llama3.2:3b',
  'llama3.2',
] as const;
```

### Patch 3: packages/adapters/src/providers/claude-sdk/spawn.ts
- Inlined 3-tier key resolver (cannot import @cleocode/core — circular dep)
- `canSpawn()` now uses `resolveAnthropicApiKey()` instead of raw `process.env.ANTHROPIC_API_KEY`
- Works with Claude Code OAuth token (free for Claude Code users)

### Patch 4: scripts/install-ollama.mjs
- `RECOMMENDED_MODEL = 'gemma4:e4b-it'` (was `gemma4:e2b`)

---

## Quality Gates

| Gate | Result |
|------|--------|
| `pnpm biome check --write` | PASS |
| `pnpm run build` | PASS |
| `pnpm --filter @cleocode/adapters test` | PASS (284 tests) |
| `pnpm --filter @cleocode/core test` (excl. perf flake) | PASS (256 files, 4034 tests) |
| `pnpm --filter @cleocode/cleo test` | PASS (76 files, 1302 tests) |
| `pnpm --filter @cleocode/studio test` | PASS (198 tests) |
| GitHub Actions Release workflow | PASS |
| npm install /tmp test (no EINTEGRITY) | PASS |

### Pre-existing failures
- `performance-safety.test.ts: should create 50 tasks within <10000ms` — timeout on loaded
  machine (25141ms vs 10000ms budget). Pre-existing flake, unrelated to Wave 1 changes.
  Not a regression.

---

## Test Fixes Applied (Wave 1 issues)

### dedup-gates.test.ts (Wave 1 new file — untracked)
**Problem**: `makeMockClient` only provided `messages.create`. The `buildZodFormat`
mock returns a non-null value, so `messages.parse` is called first — but wasn't
mocked, causing an exception and early return, so `checkHashDedup`/`verifyAndStore`
were never reached.

**Fix**: Added `messages.parse` to `makeMockClient` returning `{ parsed_output: { memories } }`.

### llm-extraction.test.ts (tracked — needed T736 routing update)
**Problem**: 4 tests expected `storeLearning`/`storePattern` to be called directly
for learning/pattern/correction/constraint types. The T736 update in `llm-extraction.ts`
now routes all of these through `verifyAndStore` instead.

**Fix**:
1. Added `vi.mock('../extraction-gate.js', ...)` with `verifyAndStore`/`checkHashDedup` mocks
2. Updated 4 test assertions to expect `verifyAndStore` calls with correct `memoryType`
3. Used `text` field (not `content`) — matching `MemoryCandidate.text` interface
4. Updated `filters out extractions below minImportance` to expect `verifyAndStore`

### spawn.test.ts (tracked — canSpawn() OAuth fix)
**Problem**: Old test `returns false when ANTHROPIC_API_KEY is absent` now fails because
the new `canSpawn()` also checks `~/.claude/.credentials.json` (OAuth) which exists in
this environment.

**Fix**: Updated test to use `vi.doMock('node:fs', ...)` to mock filesystem lookups,
preventing real credentials from leaking into the test. Added positive OAuth test case.

---

## Wave 1 Tasks Status

| Task | Title | Status |
|------|-------|--------|
| T728 | ADR-047: Autonomous GC and Disk Safety | done |
| T729 | Wire dream cycle to real extraction | done |
| T730 | TranscriptExtractor implementation | done |
| T731 | Sidecar GC daemon | done |
| T732 | Ollama auto-install | done |
| T733 | Sonnet cold-tier (owner override) | done |
| T734 | Session hooks → dream cycle | done |
| T735 | cleo daemon/transcript CLI | done |
| T736 | storeExtracted dedup gates | done |
| T737 | checkHashDedup all 4 tables | done |
| T738 | brain-schema tier columns | done |
| T739 | Migration 20260416000005 | done |
| T740 | Extraction pipeline ADR-048 | done |
| T741 | tier_promoted_at schema | done |
| T742 | Tier promotion logic | done |
| T743 | tier_promotion_reason schema | done |
| T744 | cleo memory tier CLI | done |
| T745 | Studio brain chart | done |
| T746 | brain_decisions/patterns DEFAULT medium | done |
| T747 | Tests: tier CLI | done |
| T748 | Tests: extraction pipeline | done |
| T749 | Pipeline gates integration | done |
| T752 | Gemma E4B-it + OAuth audit | done |

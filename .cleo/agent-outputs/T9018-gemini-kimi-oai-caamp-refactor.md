# T9018 — B2: gemini-cli + kimi + openai-sdk adapters refactored to caamp.ensureProviderInstructionFile

**Status**: complete
**Task**: T9018 (parent: T1919, epic: T1910)
**Commit**: f7b8b1c00bd961f130359fc1a735b0f4a51ec296 (task/T9018)

## Changes

### packages/adapters/src/providers/gemini-cli/install.ts
- Removed: `INSTRUCTION_REFERENCES` const, `updateInstructionFile` private method, `writeFileSync` manual write
- Added: `ensureProviderInstructionFile('gemini-cli', projectDir, { references, scope: 'project' })`
- Side effect: now writes to `GEMINI.md` (correct per CAAMP registry) instead of `AGENTS.md` (was a bug)
- `isInstalled()` updated to check `GEMINI.md` with dynamic reference path

### packages/adapters/src/providers/kimi/install.ts
- Removed: `INSTRUCTION_REFERENCES` const, `updateInstructionFile` private method, `writeFileSync` manual write
- Added: `ensureProviderInstructionFile('kimi', projectDir, { references, scope: 'project' })`
- Writes to `AGENTS.md` (unchanged, matches registry)

### packages/adapters/src/providers/openai-sdk/install.ts
- Removed: `INSTRUCTION_REFERENCES` const, `updateInstructionFile` private method, `writeFileSync` manual write
- Added: `ensureProviderInstructionFile('openai-sdk', projectDir, { references, scope: 'project' })`
- `ensureConfigDir(.openai/)` preserved as Step 2 (not managed by CAAMP)
- Writes to `AGENTS.md` (per manifest.json + new registry entry)

### packages/caamp/providers/registry.json
- Added `openai-sdk` provider entry (required for `ensureProviderInstructionFile` lookup)
- `instructFile: AGENTS.md`, `pathProject: .openai`, vendor: OpenAI

### packages/adapters/src/providers/openai-sdk/__tests__/openai-sdk-spawn.test.ts
- Replaced low-level `node:fs` mock-based install tests with `@cleocode/caamp` mock
- Added `mockCaampState` hoist for controlling `ensureProviderInstructionFile` return value
- Tests now validate at the caamp API boundary, not the internal file write level

## Test Results
- Adapters suite: 301 passed (14 files)
- CAAMP suite: 1334 passed, 6 skipped (60 files)
- Biome CI: clean on all 4 modified .ts files

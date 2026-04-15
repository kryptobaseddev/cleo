# T567: Verify ct-orchestrator Skill and CLEOOS Identity Chain

## Summary

Verified all skill files, command files, and identity documents. Found one stale file at the project level. Fixed `.cleo/CLEOOS-IDENTITY.md` to match the canonical 6-system model. All quality gates pass.

## Verified Items

### ct-orchestrator skill (`packages/skills/skills/ct-orchestrator/`)

- **SKILL.md** — Correct. References LOOM (RCASD-IVTR+C), CANT (spawn/classify/fanout), CONDUIT (manifest handoffs). Does not reference LAFS as a system. No changes needed.
- **orchestrator-prompt.txt** — Correct. LOOM lifecycle summary, CLEO CLI dispatch, wave-order spawning rules. No 4-system model references.
- **manifest-entry.json** — Correct. Version 4.0.0, active, tier 0, core skill.
- **references/** — 9 reference files present: autonomous-operation.md, lifecycle-gates.md, orchestrator-compliance.md, orchestrator-handoffs.md, orchestrator-patterns.md, orchestrator-recovery.md, orchestrator-spawning.md, orchestrator-tokens.md, SUBAGENT-PROTOCOL-BLOCK.md.

### /orchestrator command (`.claude/commands/orchestrator.md`)

Correct. References LOOM lifecycle, two-step spawn pattern, Agent tool spawn templates. No 4-system model references.

The `install.ts` `ClaudeCodeInstallProvider` correctly copies `.md` files from `packages/adapters/src/providers/claude-code/commands/` to `.claude/commands/` at install time — the orchestrator.md is deployed from there.

### ct-cleo skill (`packages/skills/skills/ct-cleo/SKILL.md`)

Correct. 164 operations across 10 canonical domains. References LOOM lifecycle, BRAIN memory, NEXUS, orchestrate (CANT+CONDUIT). No 4-system model.

### ct-task-executor skill (`packages/skills/skills/ct-task-executor/SKILL.md`)

Correct. Implementation task executor with BASE protocol, output format, manifest append requirement. No system-model references at all.

### CLEOOS-IDENTITY.md — FIXED

**Problem**: `.cleo/CLEOOS-IDENTITY.md` (project-level) contained the old 4-system model:
- BRAIN, LOOM, NEXUS, LAFS — the legacy model

**Root cause**: The `init-engine` only deploys from `starter-bundle/CLEOOS-IDENTITY.md` if the project file doesn't already exist (`existsSync` check). The project file predated the 6-system update and was never refreshed.

**Fix**: Replaced project-level `.cleo/CLEOOS-IDENTITY.md` with the canonical 6-system content matching `packages/cleo-os/starter-bundle/CLEOOS-IDENTITY.md`:
- TASKS, LOOM, BRAIN, NEXUS, CANT, CONDUIT

**Impact**: `readIdentityFile()` in `cant-context.ts` checks project path first. The stale project file was shadowing the correct global XDG version. Now both files are consistent.

### Global XDG identity (`~/.local/share/cleo/CLEOOS-IDENTITY.md`)

Already correct — 6-system model. No changes needed.

### cant-context.ts `readIdentityFile()`

Correct. Reads project path first, falls back to global XDG. Search order:
1. `<projectDir>/.cleo/CLEOOS-IDENTITY.md`
2. `$XDG_DATA_HOME/cleo/CLEOOS-IDENTITY.md`

### Pi bridge (`packages/cleo-os/extensions/cleo-cant-bridge.ts` lines 858-964)

Correct. Hardcoded identity block was already replaced with disk reads. Uses same search order: project `.cleo/CLEOOS-IDENTITY.md` then global XDG. Confirmed at lines 867-880.

## Other LAFS References (NOT problems)

Three skill files reference `LAFS` as the envelope protocol name (not as a "system"):
- `ct-grade/references/grade-spec.md` — HTTP API envelope headers
- `ct-memory/SKILL.md` — MVI budget guidance
- `_shared/subagent-protocol-base.cant` — LAFS response success field check

These are correct references to the LAFS envelope contract, not the old 4-system architecture model.

## Quality Gates

| Gate | Result |
|------|--------|
| `pnpm biome check` (TS files only) | PASS — 0 issues on changed files |
| `pnpm run build` | PASS — all packages built successfully |
| `pnpm run test` | PASS — 7275 passed, 0 failed |
| Project CLEOOS-IDENTITY.md exists | PASS |
| Global CLEOOS-IDENTITY.md exists | PASS |
| Both files reference 6 systems | PASS |

## Files Changed

- `/mnt/projects/cleocode/.cleo/CLEOOS-IDENTITY.md` — Updated from 4-system to 6-system model

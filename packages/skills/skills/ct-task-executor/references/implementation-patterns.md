# Implementation Patterns

Canonical patterns for executing CLEO tasks. The executor sits at the
leaf of the orchestrator's pipeline — its job is to take a fully-resolved
task spec and produce concrete deliverables that pass acceptance criteria.
This reference codifies the patterns that succeed most consistently.

## Read-Before-Write (Mandatory)

The repository CLAUDE.md and AGENTS.md make this non-negotiable for CLEO:
"Read first — understand existing code, patterns, and contracts before
writing." For the executor, this means a concrete sequence.

1. `cleo show <TASK_ID>` — full task body, including hidden acceptance
   criteria, gate config, and prior manifest summaries.
2. `cleo memory find "<topic-keyword>"` — prior decisions on the same
   surface area. The BRAIN may already have answers.
3. `Grep` for the symbol or feature name in the target package. Most
   "new" features have a related ancestor that should be extended, not
   rewritten.
4. `gitnexus_impact({target: "<symbol>"})` — blast radius before any
   edit. HIGH/CRITICAL warnings MUST be reported to the orchestrator
   before proceeding.

Skipping any of these steps produces churn the reviewer will flag.

## Smallest-Change Principle

Match the existing pattern even when you could "improve" it in passing.
The contract on the executor is to ship the acceptance criteria — not
to refactor adjacent code. If the existing pattern is genuinely broken,
file a separate task; do not entangle a fix with the requested feature.

```text
GOOD: feat(T1234): add wave-rollup verb
  packages/cleo/src/commands/orchestrate/wave-rollup.ts  (new file)

BAD:  feat(T1234): add wave-rollup verb + clean up unrelated handler
  packages/cleo/src/commands/orchestrate/wave-rollup.ts  (new file)
  packages/cleo/src/commands/orchestrate/spawn.ts        (drive-by refactor)
  packages/cleo/src/dispatch.ts                          (rename in pass)
```

The drive-by changes belong in their own task with their own acceptance
criteria. Reviewers cannot meaningfully approve a mixed-purpose diff.

## File-Placement Patterns

Package boundaries are enforced — see AGENTS.md "Package-Boundary Check".
Use this table when introducing new modules.

| Concern | Package | Why |
|---------|---------|-----|
| Runtime primitive, domain logic, store, memory | `packages/core/` | SDK; provider-neutral |
| CLI command handler, dispatch wiring | `packages/cleo/` | CLI surface only |
| Shared type, envelope, operation, error | `packages/contracts/` | Cross-package contract |
| Harness adapter, Pi runtime, claude-code adapter | `packages/cleo-os/` | Harness layer |
| Studio frontend (SvelteKit) | `packages/studio/` | UI |
| LAFS envelope spec or validator | `packages/lafs/` | Envelope ground truth |
| .cant DSL or parser | `packages/cant/` | DSL |
| Agent manifest packaging | `packages/caamp/` | Packaging |

When in doubt: state runtime concerns go in `core`; CLI handlers stay
thin and call into `core`. The repo has previously had to do T1015-style
relocation epics — avoid creating the next one.

## ESM Import Patterns

The repository uses ESM with `.js` extensions on import paths (TypeScript
strict, kebab-case files). The lint will fail any drift.

```typescript
// CORRECT
import { openCleoDb } from "../store/open-cleo-db.js";
import type { TaskEnvelope } from "@cleocode/contracts";

// WRONG — no .js suffix
import { openCleoDb } from "../store/open-cleo-db";

// WRONG — CommonJS
const { openCleoDb } = require("../store/open-cleo-db");

// WRONG — no relative-path crossing of package boundary
import { something } from "../../../other-package/src/foo.js";
// (use a workspace import: import { something } from "@cleocode/other-package")
```

## Test-First When Possible

For new behavior in `packages/core/` or `packages/contracts/`, write the
test before the implementation. The test file lives alongside the source
under `__tests__/`.

```text
packages/core/src/store/open-cleo-db.ts
packages/core/src/store/__tests__/open-cleo-db.test.ts
```

For CLI changes where the behavior is integration-heavy (touches the
dispatcher, the worktree, the store), prefer an end-to-end test in
`packages/cleo/__tests__/<verb>.test.ts` that exercises the verb via
`runMain()` rather than a unit test of an internal helper.

## Error Handling Pattern

The repository contracts an LAFS envelope `{ success, data?, error?, meta }`
for every command output. Internal helpers throw typed errors; the
dispatcher converts to envelope at the boundary.

```typescript
// Internal: throw typed error
import { TaskNotFoundError } from "@cleocode/contracts";
if (!task) throw new TaskNotFoundError(taskId);

// Boundary: catch and wrap
try {
  const data = await handler(input);
  return { success: true, data, meta: makeMeta() };
} catch (err) {
  return formatError(err, makeMeta());
}
```

Do not introduce `catch (err: unknown)` — the AGENTS.md type-safety rules
ban it. Use the contract's error types and let TypeScript narrow.

## Quality Gate Sequence

Run these IN ORDER before completing. The contract is in AGENTS.md;
shortening this sequence has caused two patch-release hotfixes (v2026.4.67,
v2026.4.69) in past sessions.

```bash
pnpm biome check --write .   # 1. format + lint
pnpm run build               # 2. build (includes typecheck via tsc -b)
pnpm run typecheck           # 3. typecheck — strict TS project refs
pnpm run test                # 4. test (zero new failures)
git diff --stat HEAD         # 5. verify scope matches intent
```

Note: `pnpm run build` (esbuild) does NOT run the strict TS project-reference
typecheck. Always run `pnpm run typecheck` separately before tagging or
marking complete. This was learned the hard way via L-3 in
`feedback_typecheck_vs_build.md`.

## Worktree Discipline

All executor work happens inside the worktree at the path provided in the
spawn prompt's `## Worktree Setup` section. Operations to AVOID:

- `git checkout <other-branch>` — the worktree's branch is sticky.
- `git reset --hard origin/main` — destroys in-flight commits from other
  worktree-spawn agents (caught in T9354 session: cost 3 PRs of recovery
  via reflog cherry-pick).
- Editing files outside the worktree path — the git shim will block
  most forbidden operations but the policy boundary is the worktree.

When done, the orchestrator integrates via `git merge --no-ff task/<id>`
per ADR-062 — preserving commit SHAs and task↔commit traceability. The
executor never touches `main` directly.

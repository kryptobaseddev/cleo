---
id: t9803-paths-rootcause-chokepoint
tasks: [T9803]
kind: fix
prs: []
summary: Root-cause fix for orphan-`.cleo/` synthesis — `getCleoDirAbsolute` now THROWS when `getProjectRoot` fails unless caller passes `{ bootstrap: true }`.
---

The chokepoint at `packages/core/src/paths.ts:305` previously caught the
`getProjectRoot` failure and silently fell back to `<cwd>/.cleo`. Any
downstream `mkdirSync` call then synthesised an orphan `.cleo/` directory
inside the cwd — the root cause of the 25+ leaked `.cleo/` directories
inside `.claude/worktrees/*` documented in the T9801 SG-WORKTREE-CANON
forensic audit (slug `sg-t9800-worktree-forensic-audit`).

Council verdict D009 (T9812) identified this single line as the Meadows
leverage point: under either XDG external or in-project layout, the same
fallback would create the same orphan class. Fix the leverage point and
the bug class disappears regardless of the location verdict.

Post-fix contract:

```ts
// Inside a real project — unchanged behaviour.
getCleoDirAbsolute('/repo/packages/x'); // "/repo/.cleo"

// Outside a project — now THROWS (was silent orphan synthesis pre-T9803).
getCleoDirAbsolute('/tmp/random-dir'); // throws E_NOT_FOUND

// Explicit bootstrap (only `cleo init` legitimately needs this).
getCleoDirAbsolute('/tmp/new-project', { bootstrap: true }); // "/tmp/new-project/.cleo"
```

`initProject()` in `packages/core/src/init.ts` is updated to pass
`{ bootstrap: true }` — the only caller in tree that legitimately CREATES
a fresh project root.

New regression suite `packages/core/src/__tests__/paths-rootcause-chokepoint.test.ts`
covers:

- AC-2: bare directory → throws + no orphan synthesis.
- AC-2: original error message surfaces for diagnosis.
- bootstrap opt-in: `<cwd>/.cleo` resolution + no auto-create.
- AC-3: three-worktree-deep nested dirs all throw + zero orphans.
- absolute `CLEO_DIR` bypass still wins.

Four pre-existing tests in `paths.test.ts` updated to either use
`{ bootstrap: true }` or pin `CLEO_DIR` — they previously asserted the
buggy silent-fallback behaviour.

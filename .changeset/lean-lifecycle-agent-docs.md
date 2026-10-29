---
id: lean-lifecycle-agent-docs
tasks: [T14105, T14109]
kind: docs
summary: "agent docs describe the lean lifecycle: branch, PR naming tasks and ACs, independent per-AC review, merge on green CI, done; a release is cleo release cut"
---

CLEO-INJECTION, CLEO-REFERENCE, ct-cleo, ct-task-executor, ct-orchestrator and
ct-dev-workflow now teach the ADR-099 flow.

**PR work**
1. Work on a branch.
2. Put `Closes: T#### AC1,AC2` (or `Refs:` for partial delivery) in the PR
   body, and check it with `cleo done --from-merge <pr> --dry-run`.
3. A non-author reviewer records `cleo review verdict` for each AC on the PR
   head.
4. Merge on green `CI`.

The merge sweep then closes the task and records `pr:`, `ci:` and
`satisfies:`. No agent step follows the merge.

**No-PR work** keeps the ADR-051 ritual: `cleo done --plan`, then
`cleo verify` with evidence, then `cleo complete`. The ritual is now scoped to
that path. Its atom table moved from INJECTION to the on-demand
`cleo briefing inject --section evidence` reference, and INJECTION shrank by
about 460 characters.

The INJECTION docs trigger row now says to update the existing doc first
(`cleo docs update <slug>`) and only then `cleo docs add` (T14109 AC3).

**Retired**
- Agent-recorded `ci:<pr>` after a merge, except for PRs merged before the
  sweep.
- `cleo done <id> --pr <n>` by agents.
- The "a merged PR cannot automatically satisfy" rule.
- The plan, open, pr-status and hand-tag release steps. Releases are now
  `cleo release cut <v> --dry-run`, then `cleo release cut <v>`.

The docs guide (`docs/guide/cleo-documentation-sop.md`, store slug
`cleo-documentation-sop`) gets two changes:
- It retires a replaced doc with `cleo docs update <old> --status superseded`
  instead of the deprecated `cleo docs supersede`.
- It notes that a ledger row whose file exists only on another device's
  unpushed branch can read as gone, and that republishing the doc restores it.

Version bumps: ct-cleo, INJECTION and REFERENCE 2.25.0; ct-task-executor 2.9.0;
ct-orchestrator 4.2.0; ct-dev-workflow 3.4.0.

Gate 31 (`scripts/lint-skill-commands.mjs`) fix: an argument defined by
reference, such as `pr: prArg` in `review.ts`, is now resolved through a
same-file `const` and judged. Before this fix, `cleo review packet <pr>` was
falsely refused. A reference that cannot be resolved in the file is not
judged.

---
id: t14001-required-gates-by-kind
tasks: [T14001, T14002]
kind: feat
summary: Research and documentation tasks no longer owe testsPassed/qaPassed unless their work touches code
---

The gates a task must pass now depend on its evidence kind
(`classifyEvidenceTask`):

- code: `verification.requiredGates`, unchanged.
- research, spike and documentation: the same list without `testsPassed`
  and `qaPassed`. A project that requires `securityPassed` or `documented`
  keeps them.

**Effect on existing configs.** This is a deliberate relaxation. A
research or documentation task that used to need a test run can now
complete on its document or decision. Override per kind with
`verification.requiredGatesByKind` to keep the old behaviour, for example
`{ "research": ["implemented", "testsPassed", "qaPassed"] }`.

**What the relaxation never covers.** A task whose recorded `implemented`
evidence or change set touches any non-document path owes the full code
gates, whatever its kind or labels. That includes `files:` paths, a `pr:`
atom's changed files (a legacy atom without them counts as code), a
`commit:` diff (merge and root commits included), and the task's own work
found the way `cleo done --plan` finds a change set: any branch whose name
cites the task (`task/`, `feat/`, `fix/`, …), commits on the default branch
whose subject cites it (merge commits, squash merges, direct commits) and
merged PRs from such a branch (the newest 200 merged PRs, matched on
their head branch). It fails closed: when that search cannot finish (no
origin default branch, a failed GitHub lookup, an unreadable commit) and
found nothing, the task owes the code gates, and `cleo complete` and
`cleo done --plan` give the reason. Setting `--kind spike` or a docs label does not let a
code change skip its tests, and a docs label no longer hides declared code
files.

README, LICENSE and CHANGELOG count as documents only when bare or with a
document extension (`src/README.ts` is code), and a bare `.txt`
(`requirements.txt`, `CMakeLists.txt`) is no longer a document. This also
narrows which PRs `pr:` refuses as docs-only.

`cleo verify` (when it computes `passed`), `cleo done --plan`,
`cleo complete` and `cleo release plan` all read the one rule. A task
verified before this release keeps its stored `passed` flag until one
`cleo verify` recomputes it; `cleo complete` says so when that is the only
gap.

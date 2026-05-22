# ADR-077: `.worktreeinclude` at repo root is the canonical worktree-include file (T9983)

| Status     | Accepted |
|------------|----------|
| Date       | 2026-05-22 |
| Saga       | SG-WORKTRUNK-OWN (T9977) |
| Epic       | T9983 — E6-WORKTREEINCLUDE-MIGRATION |
| Implements | T10029, T10030, T10031, T10032, T10033, T10034 |
| Decision   | D010 (vendor worktrunk + canonical `.worktreeinclude` file) |
| Supersedes | The implicit pre-T9983 contract that the file lived at `<repo>/.cleo/worktree-include` |
| Superseded | — |

## Context

The legacy CLEO file location `<repo>/.cleo/worktree-include` was
project-internal. It worked, but it did NOT match industry conventions:

- Claude Code Desktop ships with `.worktreeinclude` at the repo root.
- `worktrunk-core` (the Rust crate CLEO now vendors via T9981 /
  T9982) reads `.worktreeinclude` at the repo root by default.
- The broader git-worktree-tooling ecosystem (Atlassian's docs, GitHub
  Codespaces' worktree primitives, the Jenkins `git-worktree` plug-in,
  etc.) treat `<repo>/.worktreeinclude` as the conventional path.

Keeping the file inside `<repo>/.cleo/` forced agents and humans to
either (a) memorise the CLEO-specific path, or (b) learn that the same
concept lives at two different paths depending on which tool is reading
it. Both are tax that compounds at scale.

## Decision

`<projectRoot>/.worktreeinclude` is the canonical location. Effective
in the release that ships T9983.

Behaviour:

- The reader (`packages/worktree/src/worktree-include.ts`) checks the
  canonical path first; only falls back to the legacy path when the
  canonical file is absent.
- When the legacy fallback fires, the reader emits a one-time
  `process.emitWarning(..., 'DeprecationWarning',
  'CLEO_WORKTREE_INCLUDE_LEGACY')` directing the operator to
  `cleo doctor --migrate-worktree-include`.
- The scaffolder (`ensureWorktreeInclude`, used by `cleo init` and
  `cleo upgrade`) writes the canonical path when neither file exists,
  and SKIPS when only the legacy file is present — migration is always
  explicit.
- A new verb, `cleo doctor --migrate-worktree-include`, copies the
  legacy contents to the canonical path and backs the legacy file up to
  `.cleo/backups/worktree-include-<iso8601>.bak`. The verb supports
  `--dry-run`.

The legacy reader is removed no earlier than the next major release
following T9983 — i.e. one deprecation cycle, matching the policy used
for every other 1-cycle deprecation in the codebase.

## Consequences

Positive:

- Multi-language ergonomics. The file lives where every other dotfile
  lives (`.gitignore`, `.editorconfig`, `.npmrc`, etc.). No CLEO-specific
  subdirectory required.
- Claude Code interop. Agents that bring their own Claude Code Desktop
  conventions see a `.worktreeinclude` they recognise.
- `worktrunk-core` (T9981) drives the reader natively — no per-project
  shim path translation.

Negative / migration cost:

- Existing CLEO projects with a `.cleo/worktree-include` must run
  `cleo doctor --migrate-worktree-include` once (or wait for the
  deprecation warning to remind them). This is a one-time, automated,
  reversible action — the legacy file is backed up rather than deleted.

- One additional dotfile lives at the repo root. Acceptable: the file
  is already conventional in the ecosystems CLEO targets.

## Alternatives considered

- **Keep `.cleo/worktree-include`.** Rejected — perpetuates the
  internal-only convention and forces every consumer (humans, agents,
  worktrunk-core) to learn the CLEO-specific path.

- **Symlink `.cleo/worktree-include` → `.worktreeinclude`.** Rejected —
  git's cross-platform symlink handling is uneven (Windows symlink
  permissions, Linux filesystems that reject symlinks across mount
  points) and confuses worktree provisioning when the symlink is
  rebuilt with the wrong target after a rebase.

- **Read both files and merge.** Rejected — non-determinism in the face
  of conflicting entries. Operators would file bugs when the merged
  pattern set differed from either source file in isolation.

## Implementation tasks

- T10029 — reader: prefer canonical `.worktreeinclude` (already wired
  in PR #487; this PR adds the deprecation-warning regression test).
- T10030 — `cleo init` scaffolds `<root>/.worktreeinclude`.
- T10031 — `cleo doctor --migrate-worktree-include` migration verb.
- T10032 — migrate cleocode itself (commit `.worktreeinclude` at root;
  delete legacy file if any).
- T10033 — `AGENTS.md` updated to document the canonical location +
  deprecation policy.
- T10034 — this ADR.

Saga T9977 / Epic T9983 follow-up: remove the legacy reader and the
`--migrate-worktree-include` verb in the next major release after the
1-cycle deprecation window expires.

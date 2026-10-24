---
name: ct-dev-workflow
description: Development workflow orchestration for task-driven development with atomic commits, conventional commit messages, and systematic release processes. Enforces task traceability, branch discipline, smart test scope selection, and GitHub Actions integration. Use when committing code, creating releases, managing branches, or following contribution protocols. Triggers on commit operations, release preparation, or workflow compliance needs.
version: 3.1.31
protocol: contribution
dependencies: []
sharedResources:
  - subagent-protocol-base
  - task-system-integration
compatibility:
  - claude-code
  - cursor
  - windsurf
  - gemini-cli
license: MIT
metadata:
  version: 3.1.31
  tier: core
  install: harness
  covers:
    - .github/workflows/release-prepare.yml
    - packages/cleo/src/cli/commands/hook.ts
    - packages/core/src/init.ts
    - packages/cleo/src/cli/commands/init.ts
    - packages/core/src/git/hooks-install.ts
    - packages/core/src/hooks.ts
    - packages/core/templates/git-hooks/**
    - packages/contracts/src/git-hooks.ts
  lastReviewed: 2026-10-24
  stability: stable
---

# Development Workflow Context Injection

Opt-in unified-hook releases use the numbered `vYYYY.MM.N-canary.N` channel
through the normal release plan/open and OIDC workflow. The release-preparation
workflow accepts this channel explicitly; publication stays on `canary` and does
not advance to `latest`. Preserve registry retries and installed-package soak
checks. Stable promotion needs the separately retained, source-bound live harness
and hosted VidaPeps pilot evidence; missing or unavailable verification holds it.
The stable target may follow the canary base when npm has already advanced, but
every receipt must still bind to the exact canary and implementation digest.
Reject backward targets and prerelease targets; use the normal stable pipeline.

Before editing, inspect focus/briefing authority and coverage. Missing evidence
means UNKNOWN impact; current static coverage does not prove every runtime caller.
Task start, verification, completion, and handoff expose assessed coverage. Preserve
these limitations in PR and handoff claims, and recheck after source changes.
Use the repair matrix and sourced foreground resolutions; verify postconditions
and retain receipt recovery. Record actionable learning rather than empty traces.

**Protocol**: @src/protocols/contribution.md
**Type**: Context Injection (cleo-subagent)
**Version**: 3.0.0

---

## Purpose

Context injection for development workflow tasks spawned via cleo-subagent. Provides domain expertise for atomic commits with task traceability, conventional commit messages, and systematic release processes.

---

## Core Principle: Task-Driven Development

> **CRITICAL**: NO code changes or commits without a tracked task.

Every commit MUST be traceable to a CLEO task. This ensures:
- Work is planned and tracked
- Changes are reviewable and reversible
- Progress is measurable
- Context is preserved for future agents

---

## Immutable Constraints (WORKFLOW)

| ID | Rule | Enforcement |
|----|------|-------------|
| WF-001 | Task required | NO commits without CLEO task reference |
| WF-002 | Branch discipline | NO commits to main/master |
| WF-003 | Atomic commits | ONE logical change per commit |
| WF-004 | Conventional format | `<type>(<scope>): <description>` |
| WF-005 | Tests before push | Relevant tests MUST pass |

---

## Git hook compatibility (T13349)

Init, upgrade and explicit Git hook installation share the ownership-aware installer.
Resolve the effective hook directory through Git, including `core.hooksPath` and
linked worktrees. Preserve foreign hooks and customized managed hooks; a CLEO
marker alone never authorizes replacement. Refresh only exact shipped legacy
bodies or receipt-owned content, using locked atomic writes and hash-guarded
rollback. Report conflicts with the suggested integration snippet.

Receipts and locks stay in Git-private common metadata, including when
`core.hooksPath` selects tracked files. Default installation preserves hook
paths inside the checkout. Use `cleo init --git-hooks-only --allow-tracked-hooks-path` only after
reviewing the tracked destination; this opt-in still preserves foreign and
customized hooks. Init warnings carry the exact opt-in command.

The pre-push wrapper spools Git stdin once for task IDs and shared project checks.
Besides Merge/Revert/fixup!/squash!/amend!, commit-msg and pre-push accept the exact
subject `initial: cleo init` (the empty commit `cleo init` makes so HEAD resolves; T13577),
only on a parentless first commit (T13582); a later commit with that subject, or any
longer or different subject, still needs a task ID. A template change adds the
previously shipped hash to `legacy-hashes.json` so installed copies refresh.

`cleo init` and `cleo upgrade` no longer seed the CleoOS hub (Pi extensions, CANT
workflows, justfile) into the global CLEO home (T13994, ADR-098); only the deprecated
`cleo admin scaffold-hub` still does.
It probes CLEO_PROJECT_HOOK_V1 before invoking the implemented CLI adapter;
missing or incompatible runners warn and allow. `cleo hook run --probe -- execution`
answers EXEC or INERT (older builds answer V1; stable builds before 2026.10.17 are
inert). Every ungated push, including a hooks-inert `cleo` first on PATH, prints one
pre-push stderr line `WARNING: push NOT gated by project hooks: <reason>`, flagging a
checkout whose activation is on (T13774). Verify nested checkout paths, linked
worktrees, custom hook paths, historical release bodies and corrupt receipts
with focused Git fixtures before changing this delivery path.

The fourth managed hook, `post-merge` (T14010), never blocks. In shell, before
starting anything, it requires the `cleo.nexusReindexOnMerge` git marker and
HEAD on the base branch; otherwise it starts no process. When both hold it
starts `cleo nexus reindex-on-merge` detached. That command runs one at a time
per project (`.cleo/nexus-reindex.lock`) at the lowest admission priority: it
never joins the `cleo run` queue, tries only when nothing is waiting, and
records `deferred` after `nexus.reindexOnMerge.timeoutSeconds` (300). Turn it
on or off with `cleo nexus reindex-on-merge --enable` / `--disable`.

---


## Task Tracking Integration

### Before Any Work

```bash
# 1. Verify you have a task
cleo current

# 2. If no task, find or create one
cleo find "relevant query"
cleo add "Task title" --description "What you're doing" --parent T001
cleo start T123
# 3. If 'cleo start' fails with E_SESSION_UNBOUND (spawned workers and
#    subagents are already bound), bind first, then retry:
#    cleo session start --scope global --name "<what you are doing>"
#    (or: cleo session resume <id>)
```

### Commit Message Format

**MUST** include task reference:

```
<type>(<scope>): <description>

<body explaining why>

Task: T123
Co-Authored-By: Claude <noreply@anthropic.com>
```

**Example:**
```
fix(auth): prevent token expiry race condition

The refresh token was being invalidated before the new access
token was validated, causing intermittent auth failures.

Task: T1456
Co-Authored-By: Claude <noreply@anthropic.com>
```

---

## Branch & Subagent Awareness

### Single Branch Reality

Subagents share the parent session's branch. This means:

- All work happens on the same branch
- No parallel feature branches from subagents
- Commits are sequential, not parallel
- Worktrees needed for true branch isolation

### Branch Strategy

```bash
# Check current branch
git branch --show-current

# Feature work (typical pattern)
main → feature/T123-description → PR → main

# Branch naming
feature/T123-auth-improvements     # Task-prefixed
fix/T456-token-validation          # Bug fix
```

---

## Gate System (Simplified)

Not all gates apply to all changes. Follow the decision matrix. Required gates also follow the task's evidence kind (`verification.requiredGatesByKind`): research and documentation tasks owe the required gates without `testsPassed`/`qaPassed` until their work touches any non-document path, which restores the full code gates.

### G0: Pre-Flight Check

**Always required.**

```bash
# 1. Verify task context
cleo current
# MUST have a current task

# 2. Check branch
git branch --show-current
# MUST NOT be main/master

# 3. Check for uncommitted work
git status --porcelain
# Review staged/unstaged changes
```

### G1: Classify Change

| Type | Description | Tests Needed | Version Bump |
|------|-------------|--------------|--------------|
| `feat` | New feature | Related tests | MINOR |
| `fix` | Bug fix | Regression test | PATCH |
| `docs` | Documentation | None | None |
| `refactor` | Code restructure | Affected tests | PATCH |
| `test` | Test additions | The new tests | None |
| `chore` | Maintenance | None | None |
| `perf` | Performance | Perf tests | PATCH |
| `security` | Security fix | Security tests | PATCH |

### G2: Testing (Smart Scope)

**NOT always full test suite.** CI runs full tests on push.

| Change Type | Test Scope | Command |
|-------------|------------|---------|
| `feat` | Related module tests | `bats tests/unit/feature.bats` |
| `fix` | Regression + affected | `bats tests/unit/affected.bats` |
| `docs` | None (CI validates) | Skip |
| `refactor` | Affected modules | `bats tests/unit/module*.bats` |
| `test` | The new tests only | `bats tests/unit/new.bats` |
| `chore` | Syntax check only | `bash -n scripts/*.sh` |

**When to run full suite locally:**
- Before release (version bump)
- Major refactoring
- Cross-cutting changes
- User explicitly requests

```bash
# Full suite (when needed)
./tests/run-all-tests.sh

# Targeted tests (typical)
bats tests/unit/specific-feature.bats
bats tests/integration/workflow.bats

# Quick syntax check
bash -n scripts/*.sh lib/*.sh
```

### G3: Commit

```bash
# 1. Get task info
task_id=$(cleo current --quiet)

# 2. Stage changes (be specific for atomic commits)
git add scripts/specific-file.sh lib/related.sh

# 3. Create commit with task reference
git commit -m "$(cat <<'EOF'
fix(auth): prevent token expiry race condition

The refresh token was being invalidated before validation.

Task: T1456
Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

### G4: Push (Triggers CI)

```bash
# Push branch (CI runs full tests)
git push origin HEAD

# CI will run:
# - Full test suite
# - ShellCheck linting
# - JSON validation
# - Documentation drift check
# - Installation test
```

### G5: Version Bump (Release Only)

**Only for releases**, not every commit.

```bash
# 1. Preview
./dev/bump-version.sh --dry-run patch

# 2. Execute
./dev/bump-version.sh patch

# 3. Validate
./dev/validate-version.sh

# 4. Reinstall locally
./install.sh --force
cleo version
```

### G6: Tag & Release

**GitHub Actions handles release creation.**

```bash
# 1. Create annotated tag
git tag -a v${VERSION} -m "${TYPE}: ${SUMMARY}"

# 2. Push tag (triggers release workflow)
git push origin v${VERSION}

# 3. Push branch
git push origin HEAD

# GitHub Actions automatically:
# - Builds release tarball
# - Creates GitHub Release
# - Generates release notes
# - Uploads artifacts
```

**Release preflight (`release-prepare.yml`).** `cleo release open <version>`
checks main's HEAD SHA and dispatches with `skip-tests=true` when the `ci.yml`
push run for that SHA, or for an ancestor reached only through release-plan
commits (the plan file, changesets, CHANGELOG; T13140), is green AND ran every
Linux `Unit Tests` shard green (a docs-only push that skipped the tests does
not count). It sets `skip-macos-tests=true` when the newest completed nightly
or `macos-main.yml` (main-push, never cancelled mid-run, pending pushes coalesce;
T13143, T13187) run with macOS jobs for
one of those commits is green. A `ci.yml` push run still queued or in progress
is polled for up to 10 minutes first (T13823). The SHA travels as
`verified-sha` and the proving run's id as `reused-ci-run`; the workflow
ignores the skips if it checks out another commit or `verified-sha` is empty,
and re-reads the reused run from the API (push to main, success, every Linux
shard green, same tree: the exact commit, or one it extends only by
whole-path-allowlisted plan, changeset `.md` and CHANGELOG.md files; T13825)
before it skips the Linux shards, naming the run in the
summary and the bump-PR body. Otherwise the 8 Linux and 8 macOS test shards run, and the reason names
the newest main commit that has a green macOS run. The decision is in the run
summary.

**Bump-PR merge.** Its `pull_request` runs stay `action_required` (no GitHub
App), so the orchestrator admin-merges once the dispatched `CI` run on the PR
head SHA is green: `gh pr merge <n> --admin --merge` — see
`docs/release/merge-queue-runbook.md`.

---

## Quick Decision Matrix

### What Tests to Run?

| Change | Local Tests | Rely on CI |
|--------|-------------|------------|
| Single file fix | Related unit test | Yes |
| New feature | Feature tests | Yes |
| Docs only | None | Yes |
| Schema change | Schema tests | Yes |
| Cross-cutting refactor | Full suite | Yes |
| Release prep | Full suite | Yes |

### Do I Need a Version Bump?

| Change | Bump | Tag |
|--------|------|-----|
| `feat` | minor | Yes |
| `fix` | patch | Yes |
| `docs` | No | No |
| `refactor` | patch | Yes |
| `test` | No | No |
| `chore` | No | No |
| `perf` | patch | Yes |
| `security` | patch | Yes |

---

## Task System Integration

@skills/_shared/task-system-integration.md

### CLEO Integration Commands

```bash
# Task lifecycle
cleo current                 # Current task
cleo start T123              # Start task (on E_SESSION_UNBOUND: bind a session, see above)
cleo complete T123           # Mark done

# Find existing work
cleo find "query"            # Search tasks
cleo list --status pending   # Pending work

# Create new work
cleo add "Title" --parent T001 --description "..."

# Session management
cleo session status          # Current session
cleo session end --note "Completed X, Y, Z"
```

---

## Subagent Protocol

@skills/_shared/subagent-protocol-base.md

### Output Requirements

1. MUST record workflow summary with `cleo docs add {{TASK_ID}} --content - --type note --slug {{TOPIC_SLUG}}` (never a raw file under `.cleo/agent-outputs/`)
2. MUST record ONE manifest entry: `cleo manifest append --entry '<entry JSON>'` (the flat manifest file is retired, ADR-027)
3. MUST return ONLY: "Workflow complete. Manifest appended to pipeline_manifest."
4. MUST NOT return full commit/release details in response

---

## Complete Workflow Examples

### Example 1: Bug Fix (Typical)

```bash
# 1. Verify task
cleo current
# Output: T1456 - Fix token validation

# 2. Make changes
# ... edit files ...

# 3. Run relevant test
bats tests/unit/auth.bats

# 4. Stage specific files
git add lib/auth.sh scripts/login.sh

# 5. Commit with task
git commit -m "$(cat <<'EOF'
fix(auth): prevent token expiry race condition

Task: T1456
Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"

# 6. Push (CI handles full tests)
git push origin HEAD

# 7. Mark task complete
cleo complete T1456
```

### Example 2: Documentation Only

```bash
# 1. Verify task
cleo current  # T1550 - Update README

# 2. Make doc changes
# ... edit docs ...

# 3. No tests needed (CI validates)

# 4. Commit
git add docs/ README.md
git commit -m "$(cat <<'EOF'
docs: update installation instructions

Task: T1550
Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"

# 5. Push
git push origin HEAD

# 6. Complete
cleo complete T1550
```

---

## Anti-Patterns

| Pattern | Problem | Solution |
|---------|---------|----------|
| No task reference | Untracked work | Create/find task first |
| Committing to main | Bypass review | Use feature branches |
| Running full tests always | Slow iteration | Use smart test scope |
| Skipping CI | Missing validations | Always push, let CI run |
| Manual release creation | Inconsistent releases | Use tag, GH Actions |
| Giant commits | Hard to review/revert | Atomic commits |
| Vague commit messages | Lost context | Conventional + task ref |

---

## Critical Rules Summary

1. **Always have a task** before making changes
2. **Always include task reference** in commit message
3. **Never commit to main/master** directly
4. **Run relevant tests** locally, not always full suite
5. **Let CI validate** with full test suite on push
6. **Use tags for releases** - GitHub Actions handles the rest
7. **One logical change** per commit (atomic)
8. **Conventional commit format** with task reference

## Shared project hooks and managed Git delivery

Provider delivery receives canonical SDK file reads and Git discovery through a contracts port.
Adapters do not acquire a runtime dependency on core for these utilities.

CLEO's own harness hooks are separate from project hooks: `cleo hook heavy-command`
(PreToolUse), `cleo hook stop` (Stop; it runs ask-enforce) and, for Claude Code, `cleo hook session-end`
(SessionEnd) and `cleo hook subagent-start` (SubagentStart, the ct-lean rules for Agent-tool subagents) are installed together by
`cleo init`/`cleo upgrade` or `cleo doctor heavy-command-hook --fix`, and fail open.

Project business rules live in tracked `.cleo/hooks.json`; generated provider entries
are delivery outputs. hooks-v1 was promoted in v2026.10.17 and is released in source
(T13776), so every build activates and runs project hooks. The release gate
(`core/src/hooks/release-gate.ts`, T13557) stays for a future hook feature: while one is
unreleased, `cleo hook sync --activate` refuses with `E_HOOKS_V1_UNRELEASED` and existing
receipts report `unreleased` and never run. Preview with `cleo hook sync --dry-run`; explicit local activation
uses `cleo hook sync --activate` and binds definitions, handlers and dependencies to
current hashes. Source drift requires reactivation and runs no handler: Git, worktree, direct
and CI refuse (naming `cleo hook sync --activate`) every event bound by the approved bindings
recorded at activation, the current manifest or a linked checkout's, so a deleted, rebound or
unparseable definition, or a deleted handler or dependency, stays enforced; unbound events
run no hooks (a pre-bindings activation refuses them too), and agents only warn (T13742). Agent project checks are advisory; Git applies project verdicts. Native harness trust remains separately unverified.
Inspect with `cleo doctor hooks`; `--fix` never activates definitions or grants trust.
`cleo hook sync --disable` disables execution and removes only verified managed entries:
it skips providers with no delivery receipt, creates nothing, prunes only containers
activation created, deletes a provider config (and its directory) that activation created
once it is empty, and deletes the receipt (T13743).
CI uses `cleo hook check <id> --ci --candidate <sha>` or an explicit JSON `--input` file;
CLEO infrastructure failure is an unavailable check, never successful CI evidence.
Launcher faults allow locally regardless of checker error policy. File inputs and
provider records use bounded regular-file reads; FIFOs are rejected. Unsupported
provider bindings remain unsupported in delivery summaries, including mixed bindings.

The Stop event has ONE CLEO entry per provider, `cleo hook stop --provider claude-code|codex`
(T13796), in order goal tick → ask-enforce. Stop fires at every turn end, so it NEVER ends the CLEO
session (T13913): ending there deleted the terminal binding every turn. Claude Code's `SessionEnd`
hook (`cleo hook session-end`, always installed) runs `cleo session end --quiet` detached, waited for
at most 20 s; Codex has no session-end event, so its sessions end explicitly. The goal runtime goes first, only when
`.opencode/goals/` exists (`CLEO_GOAL_TICK_COMMAND`, default `ocg tick`, Stop JSON on stdin,
JSON-only stdout, at most 60 s, its process group SIGKILLed at the deadline): a block is
re-serialised as exactly `{decision, reason}` (reason capped) and skips the rest. Otherwise
ask-enforce (T13420) answers. Every step fails open (missing, failing or timed-out tick;
ask-enforce error); `CLEO_GOAL_TICK=off` skips the tick; `CLEO_ASK_ENFORCE=off` or heavy-command
mode `off` (`CLEO_HEAVY_COMMAND_HOOK` / `resources.heavyCommandHook`, read at run time) skips the
ask check, as they removed its separate hook before.
Sync folds the separate ask-enforce and old session-end Stop entries into it in place; Codex's
rides the heavy-command mode, Claude Code's always stays. `cleo doctor heavy-command-hook`
reports the hook `outdated` when the Stop, SessionEnd or SubagentStart entry is missing or was
written by another build (a binary updated without a re-sync, T13960); `--fix` re-syncs them.
`cleo self-update` re-syncs only the project it runs in.

Init, upgrade and inspection share the commit-msg, pre-commit and pre-push installer.
Git determines effective hooksPath and the common directory, including linked worktrees.
Exact known template hashes or local receipts authorize refresh; a marker alone does
not. Customized and foreign hooks are preserved even on forced refresh and report an
integration snippet. Rollback is guarded by the installed-content hash.

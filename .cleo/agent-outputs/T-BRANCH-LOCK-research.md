# T-BRANCH-LOCK — Harness-Agnostic Agent Git-Branch Protection

**Status**: Research report
**Date**: 2026-04-20
**Author**: Deep research agent (ct-research-agent)
**Scope**: Prevent any spawned worker — under any harness — from mutating the orchestrator's git branch state.
**Related**: ADR-041 (worktree handle spawn contract), `worktree-protocol.md` (owner directive 2026-04-08), T335 leak, T399–T406 (Wave 9 spawn hardening)

> This report contains **no code** and runs **no git commands**. It is a design document intended to feed a follow-up epic.

---

## 1. Executive Summary

The incident that triggered this research — a spawned worker running `git checkout feat/t1013-fill-gaps` and moving the orchestrator off `main` — is a **recurrence of T335 Wave 2b**. ADR-041 was authored on 2026-04-08 specifically to close this vector by binding spawned workers to their own git worktrees. The ADR landed but **did not stick** in practice: subsequent sessions regressed because (a) the worktree handle path is not the only code path that spawns workers, (b) the AGENT.md guardrail is *advisory* (an LLM can still ignore its own preamble), and (c) there is no runtime enforcement below the agent reasoning layer.

**Recommended solution: four-layer defense-in-depth, harness-agnostic.**

| Layer | Mechanism | Harness-agnostic? | Cost | Blocks |
|-------|-----------|-------------------|------|--------|
| **L1 — Physical** | Per-agent `git worktree` + `git worktree lock` | YES | Low (already built for T399) | Same-branch collisions, accidental pruning |
| **L2 — Process** | `git` shim on PATH that rejects branch-mutating verbs when `CLEO_AGENT_ROLE=worker` | YES | Medium (one Go/Rust binary) | `git checkout`, `git switch`, `git branch -D`, `git reset --hard`, `git stash pop`, `git worktree add/remove`, `git rebase`, `git clean -fdx` |
| **L3 — Filesystem** | `chmod 400` on the **orchestrator's** `.git/HEAD` + `ORIG_HEAD` during a session (plus `chattr +i` on Linux) | Linux + macOS | Low | Direct writes to HEAD if shim is bypassed |
| **L4 — Harness hook** | Claude Code `PreToolUse` Bash hook (defense-in-depth, NOT the fence) | Claude Code only | Low | Catches violations before the git shim even runs, gives nicer UX |

Only L1 + L2 are **load-bearing**. L3 is belt-and-suspenders for Linux/macOS. L4 is UX polish for Claude Code sessions. Together they form a mesh that works whether the spawned worker is Claude Code, Cursor Composer, Codex CLI, OpenHands, Aider, a Pi extension, a CleoOS-native provider, or a bash script calling `git` directly.

**Key insight**: Git itself provides no native "reject this checkout before it runs" hook. (`pre-commit`, `prepare-commit-msg`, `pre-push`, `pre-receive` exist; there is **no pre-checkout**, only `post-checkout` which runs *after* HEAD has already moved.) The enforcement point must therefore sit **above** git — either by wrapping the `git` binary itself (L2) or by freezing the files git writes to (L3).

---

## 2. Root Cause Analysis — Why ADR-041 Lapsed

From the owner memory file (`worktree-protocol.md`, 2026-04-08) and ADR-041, the original contract was:

1. Orchestrator lives in `/mnt/projects/cleocode/.claude/worktrees/orchestrator-main`.
2. Every spawn carries `opts.worktree: WorktreeHandle` and workers get `cwd = handle.path`, `CLEO_WORKTREE_ROOT`, `CLEO_WORKTREE_BRANCH`, `CLEO_PROJECT_HASH` in env.
3. Workers run a bash guard preamble refusing to execute outside a `.claude/worktrees/agent-*` path.
4. The orchestrator cherry-picks commits onto main; workers never push.

**Observed regression modes** (cross-referenced against memory files):

- **RM-1. Not every spawn path uses the ADR-041 handle.** The T1013 incident used direct Claude Code subagent dispatch; no `WorktreeHandle` threaded. The ADR targets *one* spawn path (`PiHarness.spawnSubagent` in CAAMP) but the runtime has at least four competing injection/spawn paths per memory file `system-architecture-audit-2026-04-14.md`. A worker invoked outside that one path has no worktree binding.
- **RM-2. The bash guardrail is advisory.** It's emitted into the worker's system prompt. An LLM reasoning "I need to fix this on main first" can simply skip the preamble. There is no hard floor below LLM reasoning.
- **RM-3. `isolate: boolean` still exists as a deprecated alias** (ADR-041 §D1). Tests and older code may still pass `isolate: true` which supplies no worktree path, leaving cwd inherited from the parent.
- **RM-4. The guardrail only checks cwd, not mutations.** A worker in a correct worktree can still run `git checkout <some-branch>` inside that worktree. Because per-worktree HEAD is private, this should be harmless — but when the worker accidentally `cd`s up one level (e.g. via `Bash(cd /mnt/projects/cleocode && git checkout ...)`, which T335 Wave 2b hit), the mutation lands on the orchestrator's HEAD.
- **RM-5. No `CLEO_AGENT_ROLE` inheritance.** The spawn protocol does not currently propagate a `role=worker` signal that downstream tooling can gate on. This makes both shims and hooks harder to write unambiguously.

**Corollary**: A re-statement of ADR-041 is *necessary but not sufficient*. The fix must add runtime enforcement, not just stronger protocol prose.

---

## 3. Deep Dive — What Git Worktree Actually Guarantees

### 3.1 Per-worktree vs shared state

From [git-worktree(1)](https://git-scm.com/docs/git-worktree):

> Linked worktrees share the repository and differ mainly in per-worktree files such as `HEAD` and `index`. […] In general, all pseudo refs are per-worktree and all refs starting with `refs/` are shared. Pseudo refs are ones like `HEAD` which are directly under `$GIT_DIR` instead of inside `$GIT_DIR/refs`.

| State | Per-worktree | Shared |
|-------|--------------|--------|
| `HEAD`, `ORIG_HEAD`, `FETCH_HEAD`, `MERGE_HEAD` | YES | — |
| `index`, working directory, per-worktree logs | YES | — |
| `refs/bisect/*`, `refs/worktree/*`, `refs/rewritten/*` | YES | — |
| All other `refs/*` (branches, tags) | — | YES |
| Object database (`.git/objects`) | — | YES |
| Hooks (`.git/hooks`) | — | YES (one shared set) |
| Config (`.git/config`) unless `extensions.worktreeConfig`=true | — | YES |

### 3.2 Can a checkout in worktree X affect worktree Y's HEAD?

**No, not directly.** Each worktree has its own `HEAD` pointer under `.git/worktrees/<name>/HEAD`. Running `git checkout <branch>` inside worktree X only mutates X's HEAD.

**But yes, indirectly, via three vectors:**

1. **Branch exclusivity.** Git refuses to check out a branch that is already checked out in another worktree (without `--force` or `--ignore-other-worktrees`). So if the orchestrator is on `main` in its worktree, a worker cannot check out `main` elsewhere. This is a *safety feature* — but it means if a worker runs `git checkout main --force` (rare but possible), both worktrees end up claiming main, and a subsequent commit on one will silently desync the other's working tree.
2. **Shared branch refs.** If worker X is on `feat/foo` and runs `git reset --hard HEAD~5`, it moves the shared `refs/heads/feat/foo` pointer. If any other worktree or clone expected that ref to be stable, it is now lying about its commit.
3. **cwd drift.** If a worker's cwd somehow ends up at the orchestrator's worktree root (bad absolute path, `cd ..` going too far, or the spawn contract failed to bind cwd), a `git checkout` there mutates the orchestrator's HEAD. **This is the T335 Wave 2b / T1013 failure mode.** Worktrees do not protect against this because filesystem and git have no knowledge of "who is supposed to own which cwd".

**Bottom line**: Worktrees give code isolation (one branch per worktree, private HEAD/index). They do **not** give runtime isolation and they do **not** enforce cwd binding. ADR-041 §D2 is the logical binding (pass `cwd` from the handle to the child process), but nothing prevents the child from `cd`ing away or from running `git -C /mnt/projects/cleocode` explicitly.

### 3.3 `git worktree lock`

Native git provides `git worktree lock [--reason "..."]`. Semantics:

- Writes a sentinel file `.git/worktrees/<name>/locked` containing the lock reason.
- Prevents `git worktree remove`, `git worktree move`, and automatic pruning.
- **Does NOT prevent `git checkout`** inside the locked worktree.
- `--force --force` (twice) overrides locked state for remove/move.

Useful for preventing orchestrator-main from being accidentally removed by cleanup scripts, **but not as a branch mutation fence.**

### 3.4 Cleanup — orphaned worktrees

- `git worktree remove <path>` refuses unclean worktrees without `--force`.
- `git worktree prune` removes stale administrative entries for worktrees whose directories were deleted manually.
- `git worktree list --porcelain` is the canonical enumeration for automated cleanup.
- Per [Augment Code's guide](https://www.augmentcode.com/guides/git-worktrees-parallel-ai-agent-execution): if a worktree was locked, `remove --force` still fails; must unlock first.

### 3.5 Performance cost

- **Creation**: seconds. Only the working tree is checked out; object database is shared.
- **Disk**: ~= working tree size per worktree. On the CLEO monorepo (~500MB working tree, 3,036 files per nexus-bridge), each worktree costs ~500MB of filesystem space (no `node_modules` until `pnpm install` is run, which is explicitly banned per memory `worktree-protocol.md`).
- **Pruning overhead**: negligible.

### 3.6 Cross-platform

| Platform | Worktree support | Caveats |
|----------|------------------|---------|
| Linux | Full | None |
| macOS | Full | None |
| Windows (native) | Full but buggy | `MAX_PATH=260` breaks deep worktree paths unless `core.longpaths=true` + Windows 10 1607+ registry opt-in. Codex issue [#9313](https://github.com/openai/codex/issues) documents `.git` file handling bugs in Windows worktrees; the recommended workaround is to use WSL. |
| Windows (WSL) | Full | Works like Linux. |

For CLEO, the CleoOS/Pi harnesses run on Linux and WSL. Native Windows support is secondary. The worktree primitive is safe to assume on all primary targets.

---

## 4. Deep Dive — Custom `git` Wrapper on PATH (L2)

### 4.1 Feasibility

Shipping a small shim binary named `git` earlier on `PATH` than the real git is a **standard, well-understood pattern**. Examples in the wild:

- Stack Overflow [Git: unconditionally prevent checkout to a different branch](https://stackoverflow.com/questions/30408294/git-unconditionally-prevent-checkout-to-a-different-branch) — documented `git-proxy.sh` pattern aliased from `.bashrc`.
- Homebrew, `asdf`, `pyenv`, `rbenv`, `nvm`, and direnv all use PATH-shim interception as their core mechanism.
- The Git RCE incident on macOS (HN 11517894) demonstrated that system tools routinely resolve `git` via `$PATH`, making PATH-shim a reliable interception point for developer-facing invocations.

### 4.2 Proposed shim contract

A single statically-linked binary `cleo-git-shim` (Go or Rust) that:

1. Reads `argv[1]` (the subcommand) and `argv[1..]` (flags).
2. Reads env vars: `CLEO_AGENT_ROLE`, `CLEO_WORKTREE_ROOT`, `CLEO_ALLOW_BRANCH_OPS` (escape hatch).
3. If `CLEO_AGENT_ROLE=worker` AND the subcommand matches the denylist AND `CLEO_ALLOW_BRANCH_OPS` is unset: print a structured error to stderr, exit 1 with a well-known code (e.g. 77), do **not** invoke real git.
4. Otherwise: `execve` the real git binary with `argv` intact. No wrapping, no perf cost, no interference.

**Denylist (v1)**:
| Subcommand | Match rule |
|------------|------------|
| `checkout` | any — unless `CLEO_ALLOW_BRANCH_OPS=1` |
| `switch` | any |
| `branch -b` / `-B` / `-D` / `-m` / `-M` / `--delete` / `--move` | flag-based |
| `worktree add` / `remove` / `move` / `lock` / `unlock` | second-arg |
| `reset --hard` / `--merge` / `--keep` | flag-based |
| `clean -f` / `-fd` / `-fdx` | flag-based |
| `rebase` (any form, interactive or not) | any |
| `stash pop` / `apply` | third-arg |
| `merge` | any (optional — merges can be legitimate for subagent review) |
| `update-ref` | any |
| `symbolic-ref HEAD` | with second arg |

**Allowlist (always pass through)**:
- `status`, `log`, `diff`, `show`, `ls-files`, `ls-tree`, `rev-parse`, `rev-list`, `cat-file`, `blame`, `describe`
- `add`, `rm`, `mv` (staging within current branch)
- `commit` (workers should commit on their own worktree branch)
- `fetch`, `remote -v` (read-only network)
- `stash push` / `stash list` / `stash show` (writing stash is fine; popping is destructive)
- `worktree list` (read-only)
- `config --get` (reads)

### 4.3 Deployment — how the shim gets on PATH

The **orchestrator** owns the shim binary at a well-known path (e.g. `/mnt/projects/cleocode/.cleo/bin/cleo-git-shim`) that contains a single directory with one file: a symlink named `git → cleo-git-shim`. The spawn contract prepends this directory to `PATH`:

```
PATH="<project>/.cleo/bin/git-shim-worker:$PATH"
CLEO_AGENT_ROLE=worker
CLEO_WORKTREE_ROOT=<worktree-path>
```

Because `PATH` is inherited through `execve` by every child process the worker spawns (bash, node, python, make, pnpm, npm), **any** subprocess that resolves `git` via PATH hits the shim. This is the **harness-agnostic guarantee**: the enforcement point is below the harness, not inside it.

### 4.4 Known bypasses — and answers

| Bypass | Mitigation |
|--------|------------|
| Worker calls `/usr/bin/git` explicitly (absolute path) | Rare in practice; LLMs overwhelmingly write `git foo` not `/usr/bin/git foo`. Defense: add a PreToolUse hook (L4) that also matches absolute paths. Also: the shim is *downstream* from whatever tool ran it; if the tool parses the command before execution, it can normalize. |
| Worker unsets `PATH` or prepends its own | Requires the worker to do unusual shell magic. Mitigate with L3 (chmod HEAD) and L4 (hook catches bash command content before execution). |
| Worker invokes git via libgit2/JGit/nodegit (library, not binary) | True blind spot. But in practice AI coding agents shell out to `git` CLI; they rarely link libgit2. If this becomes a real vector, L3 catches it. |
| Worker edits `.git/HEAD` directly via `Write` tool | Not a `git` subprocess at all. Caught by L3 chmod. |
| Worker inside a Docker/microVM has its own PATH | If the sandbox is correctly set up (OpenHands, Docker Sandbox microVM), the worker literally cannot reach the orchestrator's filesystem, so the problem is moot. |

### 4.5 Env var propagation patterns (references)

- Posix `execve(2)` inherits the entire environment by default. Shells preserve it unless the user calls `env -i`.
- Node's `child_process.spawn` inherits `process.env` by default; CLEO's spawn adapters (per ADR-041 §D2) already merge env vars.
- `ssh` / `docker exec` require explicit `SendEnv` / `-e VAR`; containerized workers need the shim and vars baked into the image or `-v`/`-e` mounted.
- The CLEO spawn contract should add `CLEO_AGENT_ROLE` and the shim-PATH prefix to the same env-merge block ADR-041 §D2 already defines.

---

## 5. Filesystem-Level Locks (L3)

### 5.1 `chmod 400 .git/HEAD`

Makes the file read-only for owner, prevents writes from non-privileged processes. **Works on Linux and macOS.** git will fail with `error: unable to lock HEAD` when attempting to mutate it.

**Downsides**:
- File's owner can always `chmod` it back (no protection against a worker running `chmod 600 .git/HEAD && git checkout ...`). Mitigated by L2 (which blocks `chmod` via bash content matching) — but `chmod` isn't typically denylisted.
- git operations that legitimately modify HEAD in the **orchestrator's** shell (e.g. cherry-picking a worker commit) require the orchestrator to unlock, operate, relock. This can be scripted.
- Inside a linked worktree, the per-worktree HEAD lives at `.git/worktrees/<name>/HEAD`; this must be locked per-worktree if used for workers, not just the main `.git/HEAD`.

### 5.2 `chattr +i .git/HEAD` (Linux only)

Makes the file truly immutable. **Even root cannot modify the file** without first running `chattr -i`. Provides defense against a worker that has sudo or any file-level trickery.

**Downsides**:
- **Linux-only.** macOS does not ship `chattr`; ext4/xfs-style immutable attribute is not portable. The macOS equivalent is `chflags uchg` (user-immutable flag) which works on APFS/HFS+ but has different semantics (owner-mutable with sudo).
- Requires `CAP_LINUX_IMMUTABLE` capability, typically means the user setting it must have sudo.
- If cleo crashes with HEAD immutable, the user needs to manually `chattr -i` to recover. The session-end cleanup must be robust (trap signals, systemd unit, etc).

### 5.3 Verdict on L3

Use L3 as **belt-and-suspenders for Linux**. Don't depend on it. Specifically:

- On session start (orchestrator session only), `chmod 400` the orchestrator-main worktree's `.git/worktrees/orchestrator-main/HEAD`.
- On session end, `chmod 644` it back.
- Optionally, with opt-in flag `CLEO_HARD_LOCK=1`, use `chattr +i` on Linux (sudo required, logged).

L3 is **not** the primary fence because portability is Linux-first-and-only, and because the owner can always unlock their own files. Its job is to give a last-line refusal when L2 was bypassed for any reason.

---

## 6. Git Native Hooks — Why They Don't Solve This

Git's hook inventory (from [githooks(5)](https://git-scm.com/docs/githooks)):

| Hook | Fires | Can block? |
|------|-------|------------|
| `pre-commit` | before commit | Yes |
| `prepare-commit-msg` | during commit message creation | No |
| `commit-msg` | after message drafted | Yes |
| `post-commit` | after commit finalized | No |
| `pre-rebase` | before rebase | Yes |
| **no `pre-checkout`** | — | — |
| `post-checkout` | after checkout completes | No |
| `pre-push` | before push | Yes |
| `pre-receive`, `update`, `post-receive` | server-side on push | Yes |
| `pre-auto-gc` | before auto gc | Yes |

**There is no `pre-checkout` hook.** The closest is `post-checkout` which runs *after* HEAD has already moved — too late to prevent the mutation. This is the core reason L2 (git wrapper) is required: git itself provides no native block-before-checkout mechanism.

`pre-rebase` exists but only covers rebase; it does not cover `checkout`, `switch`, `reset`, `branch -D`, etc.

Conclusion: native hooks contribute nothing to the branch-protection problem. They can help *after* the fact (e.g. `post-checkout` to log a violation for debrief) but cannot prevent it.

---

## 7. Process Isolation — Namespaces, Containers, Sandboxes

### 7.1 Options

| Mechanism | Blocks branch mutation? | Cross-platform? | Cost |
|-----------|-------------------------|-----------------|------|
| Linux `unshare --mount --pid --user` | Indirectly, via bind-mount readonly | Linux only | Medium |
| Bind-mount `.git/HEAD` read-only | Yes | Linux-only | Low |
| `chroot` worker | Yes if worker can't see orchestrator's repo | Linux-only | High |
| `seccomp` filters | No (syscall-level; `openat(.git/HEAD, O_WRONLY)` still syntactically valid) | Linux-only | Very high engineering cost |
| Docker container (OpenHands, Docker Sandbox) | Yes, if orchestrator's repo is not mounted into the container | All hosts that run Docker | Medium; requires image |
| microVM (Docker sbx, Firecracker) | Yes, hard VM boundary | Docker Desktop 4.60+ | Medium |
| macOS `sandbox-exec` (App Sandbox) | Yes via sandbox profile | macOS only | High (deprecated API) |
| Windows Sandbox / Hyper-V containers | Yes | Windows 10 Pro+ only | High |

### 7.2 Verdict

Heavyweight. The OpenHands / Docker Sandbox model — `DockerWorkspace`, microVM per agent, no host FS access — is the **correct endgame** for full isolation, and it's what Codex's Windows native sandbox does now ([digitalapplied.com guide, March 2026](https://www.digitalapplied.com/blog/codex-windows-native-desktop-agent-sandbox-app-guide)). But:

- Requires every harness to support container execution.
- Claude Code, Cursor Composer, Aider, and most current tools run the agent as a **host process** with host filesystem access. Containerizing them means re-architecting the agent runtime.
- Not achievable in the near-term for the cross-harness scope this research is about.

Put it on the roadmap as the L5 long-term solution (one worktree = one microVM, pattern already adopted by Docker Sandbox for Claude/Codex/Copilot/Gemini/Kiro per Docker's [2026 announcement](https://www.docker.com/blog/building-ai-teams-docker-sandboxes-agent/)). Out of scope for the immediate fence.

---

## 8. Claude Code PreToolUse Hook (L4 — Defense-in-Depth)

Documented in [code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks). The pattern:

```
.claude/settings.json →
  "hooks": { "PreToolUse": [ { "matcher": "Bash", "if": "Bash(git checkout*)", "command": ".cleo/hooks/block-branch-mutation.sh" } ] }
```

The hook script reads the tool input JSON from stdin, matches against the denylist, and either:
- exits 0 to allow, or
- returns `{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "..." } }`, or
- exits 2 with stderr to block and feed the reason back to Claude.

This is exactly Matt Pocock's `git-guardrails-claude-code` skill pattern ([aihero.dev post](https://www.aihero.dev/this-hook-stops-claude-code-running-dangerous-git-commands)). It's well-established.

**Important: L4 is NOT harness-agnostic.** Claude Code PreToolUse hooks only fire inside Claude Code. Codex CLI uses a different hook system (`.codex/hooks.json`), Cursor has a different one, OpenHands relies on sandbox runtime gates, Aider has no hook system. L4 therefore:

- Is strictly additive — a nicer UX inside Claude Code that blocks the command before it ever runs, so the LLM gets immediate feedback.
- Does **not** replace L2 (the git shim), which is the harness-agnostic fence.

The correct mental model: **L2 is the fence, L4 is the early warning sign.**

---

## 9. Comparison — Which Combination Wins?

| Criterion | L1 worktree only | L1+L2 (wrapper) | L1+L2+L3 (chmod) | L1+L2+L3+L4 (Claude hook) | L5 microVM only |
|-----------|------------------|-----------------|------------------|--------------------------|-----------------|
| Harness-agnostic | Partial (needs cwd binding) | YES | YES | Partial (L4 is Claude-only, but L2 covers the rest) | YES |
| Blocks LLM reasoning bypass | NO | YES | YES | YES | YES |
| Cross-platform | Linux/macOS/WSL (Windows fiddly) | Linux/macOS/Windows (shim is platform-specific builds) | Linux/macOS (L3) | Linux/macOS/Windows | Requires Docker |
| Engineering cost | Already built (T399) | Medium (new binary + spawn plumbing) | Low (shell) | Low (hook script) | Very high |
| Blast radius on failure | High (the whole protocol) | Low (fails closed) | Low | Low | N/A |
| Runtime overhead | None | ~1ms per git call (exec) | None | ~5ms per Bash tool call | Large (VM boot) |
| User ergonomics | Good | Good (transparent) | Awkward on failure (manual unlock) | Best (immediate LLM feedback) | Slow startup |
| Works for ssh/docker exec/pi remote workers | Yes, if worktree mounted | Yes, if shim present on remote | Yes, if orchestrator's .git reachable | No | Yes (that's the point) |

**Winner: L1 + L2 + L3 (opt-in) + L4 (Claude Code defense-in-depth).**

- L1 + L2 is the **mandatory** pair. L1 gives physical isolation; L2 gives runtime enforcement. Neither alone suffices.
- L3 is opt-in for Linux sessions (orchestrator users can set `CLEO_HARD_LOCK=1`).
- L4 is automatic when Claude Code is the harness (shipped by CAAMP's injection system per memory `injection-architecture.md`). A sibling "Codex hook", "Cursor hook", "OpenHands policy" ships alongside as each harness's equivalent lands.
- L5 microVM is a future epic.

---

## 10. Precedent Survey — What Other Systems Do

| System | Strategy | Source |
|--------|----------|--------|
| **OpenAI Codex CLI** | Sandbox modes (`read-only`, `workspace-write`, `danger-full-access`) + per-task git worktrees (`codex --worktree` proposal, Mar 2026) + Windows native sandbox with filesystem ACLs and dedicated sandbox users | [developers.openai.com/codex/concepts/sandboxing](https://developers.openai.com/codex/concepts/sandboxing), [windowsforum.com Codex Windows](https://windowsforum.com/threads/openai-codex-arrives-on-windows...) |
| **Claude Code** | `--worktree` flag for parallel tasks; PreToolUse hooks for per-project denylists; trusted/untrusted approval policies | [code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks) |
| **OpenHands (OpenDevin)** | Agent runs inside a Docker container by default; `DockerWorkspace` API; host workspace mounted read-write into `/workspace`; microVM via Docker Desktop 4.60+ sandbox | [docs.openhands.dev/sdk/guides/agent-server/docker-sandbox](https://docs.openhands.dev/sdk/guides/agent-server/docker-sandbox), [noze.it OpenHands tutorial](https://www.noze.it/en/insights/openhands-sandbox-ricerca/) |
| **Aider** | `--no-auto-commits`, `--no-dirty-commits`, `--no-git` flags; commits use author "aider (via LLM name)"; operates directly on user's repo with no sandbox by default | [aider.chat/docs/git.html](https://aider.chat/docs/git.html) |
| **Docker Sandbox (Docker Agent)** | microVM-per-agent via `docker sandbox run <agent>`; supports Claude Code / Codex / Copilot / Gemini / Kiro / OpenCode; `--branch` flag auto-creates worktree in `.sbx/-worktrees/` | [docker.com/blog/building-ai-teams-docker-sandboxes-agent](https://www.docker.com/blog/building-ai-teams-docker-sandboxes-agent/) |
| **Augment Code "Intent" / "Spaces"** | 1:1 mapping of logical Space → git worktree → dedicated branch; sibling-directory physical layout (`~/code/myproject-feature-a/`) | [augmentcode.com/guides/git-worktrees-parallel-ai-agent-execution](https://www.augmentcode.com/guides/git-worktrees-parallel-ai-agent-execution) |
| **CrewAI / LangGraph / AutoGPT / BabyAGI** | No native git isolation; git operations are agent tools delegated to individual tool implementations; relies on user to sandbox externally | [developersdigest.tech AI agent frameworks compared](https://www.developersdigest.tech/guides/ai-agent-frameworks-compared), [crewaiinc/crewai](https://github.com/crewaiinc/crewai) |
| **Matt Pocock `git-guardrails-claude-code`** | Single-harness PreToolUse hook denylist. Pattern: read bash command from stdin, grep against `git push`, `git reset --hard`, `git clean -f`, `git branch -D`, `git checkout .`; exit 2 with stderr to block. Installable via `npx skills add` | [aihero.dev this-hook-stops-claude-code-running-dangerous-git-commands](https://www.aihero.dev/this-hook-stops-claude-code-running-dangerous-git-commands) |

**Key observations:**

1. **Worktree-per-agent is the dominant pattern** (Codex, Claude Code, OpenHands branch mode, Augment, Docker Sandbox `--branch`). CLEO's ADR-041 is in the mainstream.
2. **Nobody relies on worktrees alone** for anything beyond code isolation. Runtime isolation is consistently recognized as a separate problem solved by either sandboxing (OpenHands, Docker Sandbox) or by user-managed environment boundaries.
3. **The git-wrapper/shim pattern is not widespread in AI agent frameworks.** Matt Pocock's skill is the closest published analog, and it's single-harness (Claude Code only). CLEO implementing a harness-agnostic git-shim would be a small innovation.
4. **Container-first systems (OpenHands, Docker Agent) don't need this layer** because the worker literally cannot reach the orchestrator's filesystem. For CLEO's mixed-harness reality (Claude Code + Codex + Pi + CleoOS all running natively on host), the shim is the right fit.

---

## 11. Integration Design — `cleo orchestrate spawn`

Based on the existing ADR-041 `SpawnOptions` contract, the spawn path needs three additions to implement L1 + L2 (+ L3 opt-in):

### 11.1 New `SpawnOptions` fields

```
interface SpawnOptions {
  worktree?: WorktreeHandle;                // existing (ADR-041 §D1)
  branchProtection?: 'strict' | 'permissive' | 'off';  // NEW — default 'strict' for worker role
  hardLock?: boolean;                       // NEW — opt-in L3 (Linux only)
  agentRole?: 'orchestrator' | 'worker';    // NEW — threaded into env as CLEO_AGENT_ROLE
}
```

No breaking changes beyond ADR-041's already-planned deprecation window. All new fields default to the safe branch (worker + strict).

### 11.2 Spawn-time enforcement sequence

When `cleo orchestrate spawn` fires for a worker:

1. **L1 Verify**: assert `opts.worktree` is set and `opts.worktree.path` exists + is a valid git worktree. Refuse spawn otherwise.
2. **L1 Lock** (opt-in): `git worktree lock --reason "cleo-session <sid>"` on the worker's worktree to prevent accidental pruning.
3. **L2 Materialize**: ensure `<project>/.cleo/bin/git-shim-worker/git` symlink exists and points at `cleo-git-shim`. Rebuild if missing (idempotent, costs ~5ms).
4. **L2 Env merge** (extends ADR-041 §D2):
   ```
   PATH                       = <project>/.cleo/bin/git-shim-worker:<inherited PATH>
   CLEO_AGENT_ROLE            = worker
   CLEO_WORKTREE_ROOT         = opts.worktree.path
   CLEO_WORKTREE_BRANCH       = opts.worktree.branch
   CLEO_PROJECT_HASH          = opts.worktree.projectHash
   CLEO_BRANCH_PROTECTION     = opts.branchProtection
   CLEO_ORCHESTRATOR_ROOT     = <orchestrator-main path>   // for the shim's "don't touch this" logic
   ```
5. **L3 Lock (if `hardLock`)**: `chmod 400` orchestrator HEAD files. Register a trap to unlock on session end (including crash).
6. **cwd bind**: `cwd = opts.worktree.path` (ADR-041 §D2 already in contract).
7. **L4 Install (per-harness)**: if the harness is Claude Code, CAAMP injection ensures `.claude/settings.json` contains the PreToolUse hook (this piggybacks on the existing injection system — see memory `injection-architecture.md`).
8. **Spawn** the worker subprocess.

### 11.3 Orchestrator-side escape hatch

The orchestrator is NOT a worker; `CLEO_AGENT_ROLE=orchestrator` bypasses the shim entirely. This means the orchestrator can freely cherry-pick, push, and manage branches in its own worktree — exactly as the original `worktree-protocol.md` cherry-pick cycle requires.

For *worker* legitimate needs (e.g. a worker that truly needs to `git checkout` a specific commit to inspect it), the escape hatch is `CLEO_ALLOW_BRANCH_OPS=1` in the specific command's env, scoped narrowly. This is logged for debrief.

### 11.4 Cleanup

On session end (`cleo session end`):

- `chattr -i` / `chmod 644` orchestrator HEAD files (L3 cleanup).
- `git worktree unlock` worker worktrees.
- Run cleanup script: `git worktree list --porcelain` → for each worker worktree → `git worktree remove --force` → `git branch -D <worker-branch>`.
- Existing autosnapshot (`vacuumIntoBackupAll`) continues to fire per ADR-013 §9.

---

## 12. Migration Plan

### Wave 1 — Publish the shim (small, mergeable)

- Build `cleo-git-shim` binary (Rust preferred for static link, ~200 lines). Single subcommand dispatch, denylist hardcoded, escape-hatch env vars.
- Ship as a `packages/core/src/shim/` module with a postinstall step that compiles + places the binary in `<project>/.cleo/bin/git-shim-worker/git`.
- Add smoke tests: spawn a shell with `PATH=.cleo/bin/git-shim-worker:$PATH CLEO_AGENT_ROLE=worker`, assert `git checkout foo` exits 77, `git status` exits 0.

### Wave 2 — Wire spawn contract

- Extend `SpawnOptions` per §11.1 (non-breaking).
- Update `PiHarness.spawnSubagent`, `CleoOsSpawn`, the Claude Code subagent dispatcher, and any other spawn-emitting call sites identified by the audit in memory `system-architecture-audit-2026-04-14.md` (4 injection paths).
- Deprecate the remaining `isolate: boolean` call sites; ADR-041's deprecation window closes here.

### Wave 3 — Claude Code PreToolUse hook via CAAMP

- Add a `cleo-branch-guardrail` template to `packages/caamp/src/templates/` that emits `.claude/settings.json` with the PreToolUse hook script.
- Include hook script in the project skills package so it lives at `.cleo/hooks/block-branch-mutation.sh`.
- CAAMP injection already owns the `.claude/settings.json` generation path (per memory `injection-architecture.md`); append the hook there.

### Wave 4 — Documentation & protocol update

- Supersede / amend ADR-041 with a new ADR-054 "Harness-agnostic worker git fence" referencing L1–L4.
- Update `~/.cleo/templates/CLEO-INJECTION.md` with a short "branch protection" section that explains `CLEO_AGENT_ROLE` and the shim.
- Refresh `worktree-protocol.md` memory (point it at the new runtime enforcement rather than the advisory bash guard).
- Add a `cleo doctor branch-protection` subcommand that verifies: shim symlink exists, shim is executable, PATH prefix lands, denylist blocks `git checkout` from a worker-role shell.

### Wave 5 — Codex / Cursor / OpenHands adapters (opportunistic)

- Each additional harness that CLEO integrates gets its equivalent of L4 (if the harness has a hook system). Codex has `.codex/hooks.json`; Cursor has policy config; OpenHands runs in Docker so L2 still applies inside the container.
- These ship as they're needed; L1 + L2 cover the default case harness-agnostically.

### Rollout gates

- Wave 1 must pass: `cleo doctor branch-protection` green on CI for Linux, macOS, and WSL.
- Wave 2 must pass: a deliberate "misbehaving worker" fixture that runs `git checkout main` inside its prompt — expectation: exit 77 from the shim, orchestrator's branch unchanged.
- Wave 3 must pass: same fixture in Claude Code — expectation: PreToolUse hook fires before the shim is even reached; LLM sees the deny reason and adjusts.

---

## 13. Proof Points — Why This Works Across Harnesses

| Harness | How L1+L2 enforces |
|---------|-------------------|
| **Claude Code** | CAAMP injects worktree cwd + shim PATH + `CLEO_AGENT_ROLE=worker` into subagent env. L4 PreToolUse hook gives immediate deny feedback. |
| **Cursor Composer** | When CLEO spawns a Cursor worker, same env injection. Cursor's `Run Terminal` feature uses the subprocess's PATH → shim wins. |
| **OpenAI Codex CLI** | Codex reads env from the parent shell. CLEO spawn sets `PATH`+`CLEO_AGENT_ROLE` before exec. Codex's own sandbox modes are orthogonal and additive (defense-in-depth). |
| **Aider** | Aider shells out to `git` directly via Python subprocess. Shim intercepts. `auto-commits` still work (commit is allowed), but `git checkout` to a different branch fails. |
| **OpenHands** | Docker Sandbox image bakes in the shim; the mount mapping injects env. If the container doesn't mount the orchestrator's repo at all, the problem is moot. |
| **Pi extensions** | Pi harness is CLEO-owned code; ADR-041 binding is native. Shim propagates to any nested subprocess Pi spawns. |
| **CleoOS runtime** | CleoOS *is* CLEO's sovereign harness per ADR-050. Built-in support for the spawn contract. |
| **Custom bash script calling `git` directly** | PATH prefix applies; shim intercepts. This is the case that existing Claude Code-only hooks cannot catch — and the primary reason L2 exists. |
| **Future harness X** | As long as CLEO spawns it via `cleo orchestrate spawn` with the contract applied, X inherits the shim transparently. Zero X-specific code required. |

The guarantee: **any subprocess that resolves `git` via `PATH` hits the shim.** This includes every harness mentioned above, every language runtime (Node, Python, Go, Rust), every build tool (make, cargo, npm), and every container that inherits the parent's env.

The only path that escapes is a process that (a) hardcodes `/usr/bin/git` or `/opt/homebrew/bin/git` as an absolute path, or (b) embeds libgit2/JGit/nodegit and never shells out. In practice, neither occurs in mainstream AI coding agents. If it becomes a real vector, L3 filesystem locks catch it as a last line of defense on Linux/macOS.

---

## 14. Risks & Open Questions

1. **Windows-native support.** The shim is easy to build for Windows but the chmod/chattr layer doesn't port. Windows workers should rely on WSL or microVM (Docker Sandbox). Flag as a known limitation; do not block Wave 1 on it.
2. **Shim binary distribution.** Must ride along with CLEO install (`cleo init` / npm postinstall). If the binary is missing at spawn time, fail loudly — don't silently fall through to real git.
3. **Orchestrator's own mistakes.** The shim exempts `CLEO_AGENT_ROLE=orchestrator`. A human operator (or a top-level CLEO session not spawned as a worker) can still mistype `git checkout`. L3 opt-in locks help. Training / CLI aliases (`cleo git checkout`) can be layered on top later.
4. **Session end cleanup robustness.** If the orchestrator crashes with L3 `chattr +i` active, the HEAD file stays immutable. Need a `cleo recover` command that audits + unlocks orphaned locks.
5. **Cherry-pick workflow vs push-from-worker.** The original `worktree-protocol.md` says workers never push; orchestrator cherry-picks. The shim denylist should NOT block `git push` for workers by default, because some harnesses want the worker to push its branch so the orchestrator can fetch and cherry-pick from the remote. Explicit `CLEO_DENY_PUSH=1` can be set per orchestrator policy.
6. **Interaction with git-guardrails-claude-code and other third-party hooks.** They should layer cleanly (both return exit 2 with stderr); test that CAAMP's hook doesn't conflict with a user's preinstalled skill.
7. **Performance on CI.** Every `git` call goes through an extra `execve`. Measured at ~1ms on Linux; negligible for AI workloads (dominated by LLM latency) but worth flagging for pre-commit hooks that call `git status` hundreds of times.
8. **Worktree still allows `git checkout --ignore-other-worktrees main`**. The shim blocks `checkout` entirely under worker role, so this doesn't apply — but without the shim, Git's own branch exclusivity can be bypassed with `--ignore-other-worktrees`. Good argument for why L1 alone is insufficient.

---

## 15. References

### Git primary sources

- [git-worktree(1) — git-scm.com/docs/git-worktree](https://git-scm.com/docs/git-worktree)
- [git-worktree(1) — kernel.org](https://www.kernel.org/pub/software/scm/git/docs/git-worktree.html)
- [Git environment variables — git-scm.com/book/en/v2/Git-Internals-Environment-Variables](https://git-scm.com/book/en/v2/Git-Internals-Environment-Variables)
- [githooks(5) — implied by hook list in §6](https://git-scm.com/docs/githooks)

### AI-agent-specific worktree writeups

- [Git Worktrees Need Runtime Isolation for Parallel AI Agent Development — Penligent, 2026](https://www.penligent.ai/hackinglabs/git-worktrees-need-runtime-isolation-for-parallel-ai-agent-development/)
- [How to Use Git Worktrees for Parallel AI Agent Execution — Augment Code](https://www.augmentcode.com/guides/git-worktrees-parallel-ai-agent-execution)
- [Extending Claude Code Worktrees for True Database Isolation — Damian Galarza](https://www.damiangalarza.com/posts/2026-03-10-extending-claude-code-worktrees-for-true-database-isolation/)
- [From 3 Worktrees to N: AI Agents Changed My Parallel Development Workflow — Laurent Kempé, Mar 2026](https://laurentkempe.com/2026/03/31/from-3-worktrees-to-n-ai-powered-parallel-development-on-windows/)
- [Running AI agents safely in a microVM using docker sandbox — Andrew Lock](https://andrewlock.net/running-ai-agents-safely-in-a-microvm-using-docker-sandbox/)

### Harness-specific documentation

- [Claude Code Hooks reference — code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks)
- [Claude Code Hook Control Flow — stevekinney.com](https://stevekinney.com/courses/ai-development/claude-code-hook-control-flow)
- [This Hook Stops Claude Code Running Dangerous Git Commands — Matt Pocock, aihero.dev](https://www.aihero.dev/this-hook-stops-claude-code-running-dangerous-git-commands)
- [Codex Sandbox — developers.openai.com/codex/concepts/sandboxing](https://developers.openai.com/codex/concepts/sandboxing)
- [Codex Windows Native Sandbox — digitalapplied.com, Mar 2026](https://www.digitalapplied.com/blog/codex-windows-native-desktop-agent-sandbox-app-guide)
- [How to Use Git Worktrees with OpenAI Codex CLI — inventivehq.com](https://inventivehq.com/knowledge-base/openai/how-to-use-git-worktrees)
- [codex issue #12862: --worktree and --tmux flags — github.com/openai/codex](https://github.com/openai/codex/issues/12862)
- [OpenHands Docker Sandbox — docs.openhands.dev/sdk/guides/agent-server/docker-sandbox](https://docs.openhands.dev/sdk/guides/agent-server/docker-sandbox)
- [Don't Sleep on Single-agent Systems — openhands.dev blog, Graham Neubig](https://openhands.dev/blog/dont-sleep-on-single-agent-systems)
- [Aider git integration — aider.chat/docs/git.html](https://aider.chat/docs/git.html)
- [Aider options reference — aider.chat/docs/config/options.html](https://aider.chat/docs/config/options.html)
- [Building AI Teams with Docker Sandboxes & Docker Agent — docker.com blog](https://www.docker.com/blog/building-ai-teams-docker-sandboxes-agent/)

### Wrapper/shim and filesystem lock precedent

- [Git: unconditionally prevent checkout to a different branch — Stack Overflow 30408294](https://stackoverflow.com/questions/30408294/git-unconditionally-prevent-checkout-to-a-different-branch)
- [chattr immutable file — unix.stackexchange.com/67508](https://unix.stackexchange.com/questions/67508/how-do-i-make-a-file-not-modifiable)
- [Linux: Prevent Overwriting Files With chattr — The New Stack](https://thenewstack.io/linux-prevent-overwriting-files-with-chattr/)
- [Remote code execution, git, and OS X — HN 11517894 (on PATH-shim interception)](https://news.ycombinator.com/item?id=11517894)

### CLEO internal references

- `/mnt/projects/cleocode/.cleo/adrs/ADR-041-worktree-handle-spawn-contract.md` — existing spawn contract
- `/mnt/projects/cleocode/.cleo/adrs/ADR-035-pi-v2-v3-harness.md` — Pi harness spawn canon
- `/mnt/projects/cleocode/.cleo/adrs/ADR-049-harness-sovereignty.md` — harness neutrality principle
- `/mnt/projects/cleocode/.cleo/adrs/ADR-050-cleoos-sovereign-harness.md` — CleoOS harness identity
- `/home/keatonhoskins/.claude/projects/-mnt-projects-cleocode/memory/worktree-protocol.md` — owner's 2026-04-08 directive
- `/home/keatonhoskins/.claude/projects/-mnt-projects-cleocode/memory/gotchas-critical.md` — `isolate: boolean` flaw, config lock race
- `/home/keatonhoskins/.claude/projects/-mnt-projects-cleocode/memory/system-architecture-audit-2026-04-14.md` — 4 competing injection paths audit
- `/home/keatonhoskins/.claude/projects/-mnt-projects-cleocode/memory/injection-architecture.md` — CAAMP injection chain
- `/home/keatonhoskins/.claude/projects/-mnt-projects-cleocode/memory/feedback_orchestration_model.md` — subagent spawn rules

---

## 16. Appendix — One-Paragraph Summary for the Next Epic Brief

CLEO already has git worktrees and a handle-based spawn contract (ADR-041). What it lacks is a runtime fence that catches a worker that *ignores the contract* — which keeps happening. The fix is a small statically-linked `cleo-git-shim` binary that sits on the worker's `PATH` ahead of real git. When `CLEO_AGENT_ROLE=worker` it rejects `checkout`, `switch`, `branch -D`, `reset --hard`, `worktree`, `rebase`, `stash pop`, and `clean -fdx` before real git ever runs. Any harness that spawns a subprocess with the CLEO env — Claude Code, Codex, Cursor, OpenHands, Aider, Pi, CleoOS, bash scripts — is covered, because PATH inheritance is universal. Linux/macOS sessions get an opt-in `chattr/chmod` hard lock on the orchestrator's HEAD as a last line of defense, and Claude Code gets a PreToolUse hook as a faster LLM-feedback loop. This is five days of engineering, zero breaking changes to existing callers, and closes a vector that has cost us at least two production incidents. Net win. Ship it.

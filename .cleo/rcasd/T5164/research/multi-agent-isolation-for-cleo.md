# Multi-Agent Isolation for CLEO: Workspaces

**Status**: Research
**Date**: 2026-02-28
**Scope**: First-class provider-neutral workspace isolation for concurrent epic development

---

## The Problem

A solo developer runs 5 terminal windows. Each terminal has an AI agent (Claude, Codex, Gemini, or any other) working on a different epic via CLEO sessions. When one agent runs `git checkout feature-x`, every other terminal's working directory shifts underneath them. Work gets clobbered, branches collide, agents lose context.

This is not a provider-specific problem. It affects **any** multi-agent workflow where agents share a single git working directory:

- Agent A rewrites `src/auth.ts` while Agent B modifies the same file for a different epic
- Agent C checks out `feature/T5200` and Agent A's uncommitted changes are now on the wrong branch
- Subagents spawned by an orchestrator collide with the parent agent's working tree

**CLEO must own the solution.** Per the [CLEO Vision](../docs/concepts/vision.md), CLEO is provider-neutral. The isolation layer cannot depend on any specific coding tool's worktree implementation. CLEO manages the workspace lifecycle through its own MCP operations and CLI commands, making isolation available to any agent that speaks [LAFS](https://github.com/kryptobaseddev/lafs-protocol).

---

## Industry Landscape

### The Underlying Technology: Git Worktrees

[Git worktrees](https://git-scm.com/docs/git-worktree) (available since Git 2.5) create additional working directories linked to the same repository. Each worktree has its own `HEAD`, staging index, and working files while sharing the object database, refs, and remote configuration.

**Key properties for automated use:**

| Shared (all worktrees) | Per-worktree (isolated) |
|---|---|
| `.git/objects/` (commits, blobs, trees) | `HEAD` (current commit) |
| `.git/refs/` (branches, tags) | `index` (staging area) |
| `.git/config` (repo configuration) | Working tree files |
| Remote configuration | Lock state |

**Constraints:**
- A branch can only be checked out in one worktree at a time ([git-worktree docs](https://git-scm.com/docs/git-worktree))
- Concurrent `git gc` + write operations can corrupt shared refs ([auto-worktree #174](https://github.com/caarlos0/auto-worktree/issues/174))
- Worktrees do not include gitignored files (`node_modules`, `.env`, etc.)
- Stale `.lock` files from crashed processes can block operations

**Performance:** Negligible impact on most operations. A [known fetch regression](https://lore.kernel.org/git/) proportional to worktree count was fixed in Git 2.37.

### How Others Solve This

Several tools address multi-agent git isolation, but none integrate with a structured task/lifecycle system:

| Tool | Approach | Limitation for CLEO |
|---|---|---|
| [parallel-code](https://github.com/johannesjo/parallel-code) | Electron GUI, auto worktree + symlinks per task | Tied to specific agent CLIs, no lifecycle awareness |
| [Grove](https://grove.dev) | Rust TUI, tmux-based worktree management | No task/epic binding, no provenance tracking |
| [Container Use (Dagger)](https://github.com/dagger/container-use) | MCP server with container + git branch isolation | Heavy infrastructure, overkill for solo developer |
| [Docker AI Sandboxes](https://docs.docker.com/ai/sandboxes/) | MicroVM per agent with dedicated Docker daemon | Requires Docker, high memory footprint |
| Provider-specific flags (e.g. `claude --worktree`) | Built-in worktree creation per session | Provider-locked, no cross-agent coordination |

**Key insight:** All existing solutions either lock you into a specific provider or lack structured lifecycle management. None bind isolation to an epic/session/lifecycle system with cross-terminal conflict detection.

### Isolation Strategy Comparison

| Approach | Disk | Speed | Git Safety | Cross-Platform | Provider-Neutral |
|---|---|---|---|---|---|
| **Git Worktrees** | Low (shared `.git`) | <1s create | Medium (shared refs) | Yes (Git 2.5+) | Yes |
| **Separate Clones** | High (full `.git` dup) | 10-30s | High (fully independent) | Yes | Yes |
| **Containers** | Medium | 5-60s | High | Requires Docker | Yes |
| **FS Overlays** | Very low | <1s | High | Linux only | Yes |
| **Branch-only (no isolation)** | None | N/A | N/A | Yes | Yes |

**Recommendation:** Git worktrees as primary strategy. They are provider-neutral (pure git), fast, lightweight, and the industry standard for this use case. Separate clones as fallback for edge cases where shared-ref concurrency is a concern.

---

## What CLEO Builds: Workspaces

A **CLEO Workspace** is a first-class concept that binds an epic to an isolated git worktree, managed entirely through CLEO's own operations. No provider dependency.

```
CLEO Workspace = Epic + Isolated Working Directory + Session Binding

The workspace lifecycle is managed by CLEO, not by any coding tool.
Any agent that speaks LAFS can operate within a CLEO workspace.
```

### Architecture

```
project-root/
  .cleo/                             (portable brain — metadata only)
    tasks.db                         (workspace records in new table)
      workspaces table:
        id, epicId, worktreePath, branchName, createdAt, status, lastSessionId
    config.json                      (workspace config: branchPrefix, init hook, etc.)
    ...

  .cleo-workspaces/                  (CLEO-managed worktrees, gitignored)
    epic-T5112/                      (worktree for epic T5112)
      .git                           (file pointing to main .git/worktrees/)
      src/                           (isolated working tree)
      ...
    epic-T5200/                      (worktree for epic T5200)
      .git
      src/
      ...

  .git/worktrees/                    (git's own metadata, automatic)
    epic-T5112/
    epic-T5200/
```

**Why `.cleo-workspaces/` and not `.cleo/workspaces/`:** The `.cleo/` directory is the [portable brain](../docs/concepts/vision.md) -- "Move the `.cleo/` directory, and the entire brain moves with it." Worktrees contain full project source code (potentially gigabytes). Putting them inside `.cleo/` would break the portability contract. A sibling directory keeps the brain lightweight and portable while keeping worktrees discoverable.

**Why not `.claude/worktrees/`:** CLEO is provider-neutral. Using a provider-specific namespace would create an implicit dependency. `.cleo-workspaces/` is CLEO's own namespace, managed by CLEO's operations, usable by any agent.

The workspace directory is configurable via `workspace.directory` in `.cleo/config.json` (default: `.cleo-workspaces`). Git worktrees can also be created outside the repository tree entirely (e.g., `/tmp/cleo-workspaces/epic-T5112`) using absolute paths.

### How It Works

```
┌──────────────────────────────────────────────────────────┐
│  CLEO Workspace = Epic + Isolated Worktree + Session     │
│                                                          │
│  Terminal 1 (any agent — Claude, Codex, Gemini, etc.):   │
│    ct workspace create T5112                             │
│    ct session start --scope epic:T5112 --workspace       │
│    → Creates .cleo-workspaces/epic-T5112/                │
│    → Branch: epic/T5112-auth-refactor                    │
│    → All agent work scoped to this directory             │
│                                                          │
│  Terminal 2 (any agent):                                 │
│    ct workspace create T5200                             │
│    ct session start --scope epic:T5200 --workspace       │
│    → Creates .cleo-workspaces/epic-T5200/                │
│    → Branch: epic/T5200-engine-consolidation             │
│    → Completely isolated from Terminal 1                 │
│                                                          │
│  Terminal 3 (tries T5112):                               │
│    ct session start --scope epic:T5112 --workspace       │
│    → CLEO detects existing workspace, offers:            │
│      a) Resume in existing workspace (cd to worktree)    │
│      b) Create parallel workspace (epic-T5112-2)        │
│      c) Fail with conflict warning (exit 67)            │
└──────────────────────────────────────────────────────────┘
```

### CLEO Owns the Lifecycle

The critical differentiator: CLEO manages workspace creation, conflict detection, cleanup, and metadata. The agent never calls `git worktree` directly. CLEO does.

```
Agent (any provider)
  |
  | LAFS: cleo_mutate workspace.create { epicId: "T5112" }
  |
  v
CLEO Core (src/core/workspace/)
  |
  | 1. Validate epic exists and is active
  | 2. Check for existing workspace (conflict detection)
  | 3. Compute branch name from epic title
  | 4. Execute: git worktree add .cleo-workspaces/epic-T5112 -b epic/T5112-title
  | 5. Run workspace.init hook (project-specific bootstrapping)
  | 6. Record workspace in tasks.db
  | 7. Return workspace metadata via LAFS envelope
  |
  v
Agent receives: { worktreePath, branchName, epicId }
Agent operates within the worktree directory
```

---

## Extension Points in Current Architecture

CLEO's existing architecture provides strong natural integration points:

| Component | Current State | Workspace Extension |
|---|---|---|
| `SessionScope` | Has `epicId`, `rootTaskId` | Add optional `workspaceId` field |
| `startSession()` | Conflict detection (one active per scope) | Hook to create/resume workspace |
| `endSession()` | Computes handoff data | Include git state (branch, SHA, dirty files) |
| `orchestrate.bootstrap` | Provides brain state to subagents | Include `worktreePath`, `branchName` |
| `SpawnContext` | Has `taskId`, `protocol`, `prompt` | Add `workspacePath` for agent CWD |
| Session handoff (T4959) | `previousSessionId`/`nextSessionId` | Include branch/commit SHA for continuity |
| RCASD paths | `.cleo/rcasd/{epicId}/` | Store branch name in `_manifest.json` |
| Git checkpoint | `.cleo/.git` for state sharing | Separate from workspace worktrees (no cross-pollution) |

---

## Design Decisions

### 1. Opt-in vs. Automatic

Should `ct session start --scope epic:T5112` automatically create a workspace?

| Strategy | Behavior | Trade-off |
|---|---|---|
| **Opt-in flag** | `--workspace` on session start or workspace create | Least disruptive, explicit control |
| **Config-based** | `workspace.autoCreate: true` in `.cleo/config.json` | Set-and-forget for multi-agent workflows |
| **Smart default** | Auto-create when CLEO detects multiple active sessions | Magic behavior, harder to reason about |

**Recommendation:** Config-based with opt-in flag override. Projects that use multi-agent workflows set it once in config. Others aren't affected.

### 2. Environment Bootstrapping

New worktrees lack `node_modules`, `.env`, and other gitignored files. Projects need a way to bootstrap their environment.

| Strategy | Speed | Isolation | Complexity |
|---|---|---|---|
| **Symlink gitignored dirs** | Fast | Shared (read-safe, write-risky) | Low |
| **Full install** (`npm install`) | Slow | Full | Low |
| **CLEO hook** (`workspace.init`) | Configurable | Configurable | Medium |

**Recommendation:** CLEO hook system. Add a `workspace.init` hook in `.cleo/config.json` that runs after worktree creation. Each project defines its own bootstrapping. The [parallel-code](https://github.com/johannesjo/parallel-code) project validates the symlink approach for `node_modules` and other large gitignored directories.

```json
{
  "workspace": {
    "autoCreate": false,
    "init": "npm install && cp .env .cleo-workspaces/$CLEO_WORKSPACE_NAME/.env",
    "branchPrefix": "epic/",
    "directory": ".cleo-workspaces"
  }
}
```

### 3. Branch Naming Convention

| Pattern | Example | Notes |
|---|---|---|
| `epic/{epicId}-{slug}` | `epic/T5112-auth-refactor` | Human-readable, tied to epic |
| `cleo/{epicId}` | `cleo/T5112` | Minimal, CLEO-namespaced |
| Configurable prefix | User's choice | Maximum flexibility |

**Recommendation:** Configurable via `workspace.branchPrefix` in config, default `epic/`. Branch name derived from epic ID + slugified title.

### 4. Cleanup Lifecycle

Workspaces should be tied to the RCASD lifecycle:

| Event | Action |
|---|---|
| `ct session end` | Record git state in debrief; workspace persists |
| `ct session start` (same epic) | Resume existing workspace (no re-creation) |
| Epic reaches `released` stage | Prompt for workspace cleanup |
| `ct workspace gc` | Prune workspaces for completed/archived epics |
| `ct workspace remove T5112` | Manual removal with safety checks |

### 5. Conflict Detection

CLEO already enforces one active session per scope. Workspaces extend this:

- **Same epic, same machine:** Detect existing workspace via `tasks.db` record + filesystem check
- **Stale workspace:** Workspace record exists but directory is missing (pruned/deleted) -> auto-recreate
- **Orphaned workspace:** Directory exists but no active session -> offer cleanup or resume

---

## Concurrency Safety

Git worktrees share `.git/objects/` and `.git/refs/`. Concurrent agents create contention risks:

| Risk | Mitigation |
|---|---|
| `git gc` + concurrent writes | CLEO disables `gc.auto` when workspaces are active |
| Concurrent rebases across worktrees | CLEO serializes ref-modifying operations |
| Stale `.lock` files from crashed agents | CLEO detects and cleans stale locks before operations |
| Shared index corruption | Each worktree has its own index (safe by design) |

**Critical:** CLEO MUST run `git config gc.auto 0` when creating the first workspace and restore it when the last workspace is removed.

---

## CLEO State Sharing Across Worktrees

### The Problem

CLEO's `.cleo/` directory uses a [deny-by-default `.gitignore`](../.cleo/.gitignore) strategy: everything is ignored, then specific files are allowed. This means git worktrees receive a **partial** `.cleo/`:

| File | Tracked? | In worktree? | Notes |
|---|---|---|---|
| `.cleo/config.json` | Yes | Yes | Runtime configuration |
| `.cleo/project-context.json` | Yes | Yes | LLM agent guidance |
| `.cleo/project-info.json` | Yes | Yes | Project identity |
| `.cleo/tasks.db` | No (gitignored) | **No** | All task/session/workspace data |
| `.cleo/tasks.db-wal` | No | **No** | SQLite write-ahead log |
| `.cleo/backups/` | No | **No** | Operational backups |
| `.cleo/rcasd/` | No | **No** | Lifecycle artifacts |
| `.cleo/metrics/` | No | **No** | Compliance/telemetry |

The worktree gets config files but **not the database**. An agent running `ct show T5112` from inside a worktree would find `.cleo/config.json` but not `.cleo/tasks.db`.

### The Solution: CLEO_ROOT Environment Variable

CLEO's path resolution (`src/core/paths.ts`) already supports the `CLEO_ROOT` environment variable (line 83-84):

```typescript
export function getProjectRoot(cwd?: string): string {
  if (!cwd && process.env['CLEO_ROOT']) {
    return process.env['CLEO_ROOT'];
  }
  // ... falls back to deriving from CWD
}
```

When `CLEO_ROOT` is set, all CLEO operations resolve `.cleo/` relative to that root — not the current working directory. This means:

```bash
# Without CLEO_ROOT — FAILS
cd /project/.cleo-workspaces/epic-T5112
ct show T5112  # Looks for .cleo-workspaces/epic-T5112/.cleo/tasks.db — missing!

# With CLEO_ROOT — WORKS
export CLEO_ROOT=/project
cd /project/.cleo-workspaces/epic-T5112
ct show T5112  # Looks for /project/.cleo/tasks.db — found!
```

### Automatic Detection via Git

CLEO can also detect the main repo root automatically from inside a worktree using git introspection:

```bash
# From inside a linked worktree:
git rev-parse --git-common-dir    # Returns: /project/.git
# Parent of .git = project root = /project

# Detect if we're in a linked worktree (vs main):
# In main worktree: .git is a DIRECTORY
# In linked worktree: .git is a FILE containing "gitdir: /path/to/.git/worktrees/<name>"
```

**Implementation approach:** When `CLEO_ROOT` is not set, `getProjectRoot()` can check if `.git` is a file (indicating a linked worktree), parse `git rev-parse --git-common-dir` to find the main repo's `.git`, and derive the project root from that. This makes CLEO worktree-aware without requiring manual environment setup.

**Detection algorithm:**

```
getProjectRoot(cwd):
  1. If CLEO_ROOT env is set → return it (explicit override, highest priority)
  2. If CWD/.cleo/tasks.db exists → return CWD (we're in the main repo)
  3. If CWD/.git is a FILE (not directory) → we're in a linked worktree
     a. Run: git rev-parse --git-common-dir → /main-repo/.git
     b. Main repo root = parent of .git → /main-repo
     c. If /main-repo/.cleo/tasks.db exists → return /main-repo
  4. Fall back to current behavior (CWD-relative)
```

### Workspace Bootstrap

When CLEO creates a workspace, it MUST set `CLEO_ROOT` in the workspace environment. This is done through the `workspace.init` hook or by writing a `.cleo-workspace-env` file that agents source:

```bash
# .cleo-workspaces/epic-T5112/.cleo-workspace-env (auto-generated by CLEO)
export CLEO_ROOT=/absolute/path/to/project-root
export CLEO_WORKSPACE_NAME=epic-T5112
export CLEO_WORKSPACE_EPIC=T5112
export CLEO_WORKSPACE_BRANCH=epic/T5112-auth-refactor
```

---

## Agent CWD: How Agents Actually Work in Worktrees

### The Problem

"Agent receives `{ worktreePath }` and operates within it" -- but how? The agent's process is already running in the main repo directory. CLEO cannot change a running process's CWD. The agent needs to be **launched** in the worktree, or **directed** to it.

### Three Approaches (not mutually exclusive)

**Approach 1: Launch agent in the worktree directory**

The user opens a new terminal, `cd`s to the worktree, and starts their agent there:

```bash
# CLEO creates the workspace
ct workspace create T5112

# User starts their agent in the worktree
cd $(ct workspace path T5112)
# Now start any agent — Claude, Codex, Gemini, etc.
claude                         # or codex, or gemini, or any CLI
```

CLEO provides `ct workspace path T5112` which prints the absolute path, usable with `cd $()` in any shell. This is the simplest and most provider-neutral approach.

**Approach 2: Shell integration (subshell with environment)**

CLEO can spawn a subshell pre-configured with the correct CWD and environment:

```bash
ct workspace enter T5112
# Spawns: cd /project/.cleo-workspaces/epic-T5112 && source .cleo-workspace-env && $SHELL
# Agent starts in the correct directory with CLEO_ROOT set
```

This is analogous to Python's `source venv/bin/activate` pattern — the user enters the workspace, does their work, then exits.

**Approach 3: MCP-directed CWD (for orchestrator-spawned agents)**

When CLEO's orchestrator spawns subagents via MCP, the workspace path is included in the bootstrap payload:

```json
{
  "worktreePath": "/project/.cleo-workspaces/epic-T5112",
  "branchName": "epic/T5112-auth-refactor",
  "epicId": "T5112",
  "env": {
    "CLEO_ROOT": "/project"
  }
}
```

The orchestrator launches each subagent with the worktree as its working directory. This is the automated path — no human `cd` required.

### Recommendation

All three approaches should be supported:

| Approach | Who uses it | Automation level |
|---|---|---|
| `ct workspace path` + manual `cd` | Human developer opening a terminal | Manual |
| `ct workspace enter` (subshell) | Human developer wanting one command | Semi-automatic |
| MCP bootstrap with `worktreePath` | Orchestrator spawning subagents | Fully automatic |

---

## VCS Neutrality: Beyond Git

### Git is Primary, Not Exclusive

CLEO Workspaces are initially git-only. Git worktrees are the underlying mechanism, and git is the dominant VCS for the target audience. However, CLEO's vision includes provider neutrality, and VCS is analogous to a "provider" in this context.

### Other VCS Equivalents

Research confirms that worktree-like concepts exist in other VCS systems:

| VCS | Feature | Command | Shares repo data? | Notes |
|---|---|---|---|---|
| **Git** | Worktrees | `git worktree add` | Yes (shared `.git/objects/`) | Branch can only be in one worktree |
| **Mercurial** | Share extension | `hg share` | Yes (shared store) | No branch exclusivity; destructive ops risky across shares |
| **Perforce** | Workspaces | `p4 client` | Server-managed | First-class concept; each workspace has independent sync state |
| **Jujutsu** | Workspaces | `jj workspace add` | Yes (shared repo) | Native support, not built on `git worktree`; automatic snapshotting |
| **SVN** | Multiple checkouts | `svn checkout` (repeated) | No (each independent) | No equivalent; each checkout is fully independent |

Sources: [Git worktree docs](https://git-scm.com/docs/git-worktree), [Jujutsu Git compatibility docs](https://docs.jj-vcs.dev/latest/git-compatibility/), [Perforce client spec docs](https://help.perforce.com/helix-core/server-apps/cmdref/current/Content/P4Guide/configuration.workspace.html)

### Abstraction Strategy

CLEO Workspace operations SHOULD be designed with a VCS abstraction layer in mind, even though the initial implementation is git-only:

```typescript
// Future interface (not for Phase 1)
interface WorkspaceVcsAdapter {
  createIsolatedCopy(epicId: string, branchName: string, targetPath: string): Promise<void>;
  removeIsolatedCopy(targetPath: string): Promise<void>;
  listIsolatedCopies(): Promise<WorkspaceCopyInfo[]>;
  getCurrentBranch(worktreePath: string): Promise<string>;
  getMainRepoRoot(worktreePath: string): Promise<string>;
}

// Phase 1: GitWorkspaceAdapter implements this for git worktrees
// Future: HgWorkspaceAdapter, JjWorkspaceAdapter, etc.
```

The key insight: CLEO's `workspace.create` / `workspace.remove` / `workspace.list` operations are VCS-agnostic at the MCP/CLI level. The VCS-specific logic is an implementation detail behind the adapter. An agent calling `cleo_mutate workspace.create { epicId: "T5112" }` never needs to know whether the underlying mechanism is `git worktree add` or `jj workspace add`.

---

## Clone Fallback Strategy

### When Worktrees Aren't Enough

Git worktrees share `.git/objects/` and `.git/refs/`. In edge cases, this shared state can cause problems:

- Heavy concurrent `git gc` across many agents
- Agents that need to check out the **same branch** (worktrees enforce branch exclusivity)
- Extremely large repos where shared ref contention becomes measurable
- Repos with complex submodule configurations that interact poorly with worktrees

### Clone as Alternative Isolation

CLEO SHOULD support `git clone --local` as a fallback isolation strategy. Local clones on the same filesystem use hardlinks for `.git/objects/`, reducing disk overhead significantly while providing fully independent git state.

```bash
# Local clone (hardlinks objects, ~instant for large repos)
git clone --local /project /project/.cleo-workspaces/epic-T5112-clone

# Branch checkout in the clone
cd /project/.cleo-workspaces/epic-T5112-clone
git checkout -b epic/T5112-auth-refactor
```

| Aspect | Worktree | Local Clone |
|---|---|---|
| Disk usage | Minimal (shared objects) | Low (hardlinked objects) |
| Git state | Shared refs (contention risk) | Fully independent |
| Branch exclusivity | Enforced (one worktree per branch) | None (same branch in multiple clones) |
| `git gc` safety | Requires coordination | Safe independently |
| Fetch sync | Automatic (shared refs) | Manual (`git fetch` per clone) |
| Cleanup | `git worktree remove` | `rm -rf` (or `git worktree prune` if registered) |

### Configuration

```json
{
  "workspace": {
    "strategy": "worktree",
    "fallbackStrategy": "clone"
  }
}
```

The `strategy` field selects the default isolation mechanism. If `workspace.create` fails with a worktree-specific error (e.g., branch already checked out), CLEO can automatically fall back to a local clone if `fallbackStrategy` is set.

Both strategies use the same MCP operations, CLI commands, and `CLEO_ROOT` environment setup. The agent never knows (or needs to know) whether its workspace is a worktree or a clone.

---

## Proposed MCP Operations

### Query Operations

```
workspace.list          # All active workspaces with epic status
workspace.show          # Single workspace details (path, branch, session)
workspace.status        # Git status within a specific workspace
```

### Mutate Operations

```
workspace.create        # Create workspace for epic (git worktree add)
workspace.remove        # Remove workspace with safety checks (git worktree remove)
workspace.gc            # Prune workspaces for completed/archived epics
```

### CLI Commands

```bash
ct workspace list                    # Show all active workspaces
ct workspace create T5112            # Create workspace for epic
ct workspace remove T5112            # Remove workspace (confirms if dirty)
ct workspace gc                      # Clean up stale workspaces
ct workspace status                  # Git status of current workspace
ct workspace path T5112              # Print absolute path (for cd, scripts, agent CWD)
ct workspace enter T5112             # Spawn subshell in workspace with CLEO_ROOT set
```

---

## Proposed Implementation Phases

### Phase 1: Foundation (`src/core/workspace/`)

- `WorkspaceRecord` type and `workspaces` table in `tasks.db` (drizzle schema migration)
- Core operations: `create`, `remove`, `list`, `show`, `gc`, `path`, `enter`
- `GitWorkspaceAdapter` implementing VCS-agnostic interface (git worktree add/remove/list)
- Worktree detection in `getProjectRoot()`: if `.git` is a file, resolve via `git rev-parse --git-common-dir`
- `.cleo-workspace-env` auto-generation with `CLEO_ROOT`, `CLEO_WORKSPACE_NAME`, `CLEO_WORKSPACE_EPIC`
- Conflict detection: check for existing workspace before creation
- `gc.auto` management: disable on first workspace, restore on last removal
- `.cleo-workspaces/` added to project `.gitignore`

### Phase 2: Session Integration

- Extend `SessionScope` with optional `workspaceId`
- `startSession()` hook: auto-create workspace if config says so
- `endSession()` hook: record git state (branch, SHA, dirty files) in debrief
- `workspace.init` hook support for project-specific bootstrapping
- MCP operations: `workspace.*` in query and mutate gateways
- CLI commands: `ct workspace *`

### Phase 3: Orchestration Integration

- `orchestrate.bootstrap` includes `{ worktreePath, branchName }` in brain state
- `SpawnContext` includes `workspacePath` for subagent CWD
- Protocol injection tells agents their working directory is isolated
- Wave computation ensures all agents in a wave target the same workspace
- LAFS envelope includes workspace metadata in `_meta`

### Phase 4: Lifecycle & Provenance

- RCASD `released` stage triggers workspace cleanup prompt
- Workspace branch name stored in `.cleo/rcasd/{epicId}/_manifest.json`
- Branch merge-back workflow via `ct workspace merge T5112` (creates PR)
- Handoff data includes full git state for session continuity
- Provenance records include workspace branch and commit SHA

**RCASD Consolidation Integration (T5100):** The following modules from the RCASD provenance consolidation are available for workspace lifecycle:

| Module | Integration |
|---|---|
| `src/core/lifecycle/rcasd-paths.ts` | `getEpicDir()`, `getManifestPath()`, `ensureStagePath()` for workspace lifecycle artifacts |
| `src/core/lifecycle/evidence.ts` | `recordEvidence(epicId, stage, uri, 'file')` to log workspace creation, branch, commits as lifecycle evidence |
| `src/core/lifecycle/sync.ts` | Dual-write pattern (JSON canonical + SQLite mirror) to follow for the `workspaces` table |
| `src/core/lifecycle/frontmatter.ts` | `buildFrontmatter(epicId, stage)` for Obsidian-style backlinks on workspace artifacts |
| `src/core/lifecycle/index.ts` | `completeStage()` auto-rebuilds RCASD-INDEX.json; hook cleanup into `released` stage |
| `src/core/skills/injection/subagent.ts` | `{{RCASD_STAGE_PATH}}` token + `worktreePath` compose for agent CWD + output paths |

**Gaps to build:**
1. Workspace metadata fields in `_manifest.json` (`workspaceBranch`, `workspaceCommitSha`)
2. Lifecycle stage hook system for extensible callbacks on stage transitions
3. Enhanced `getProjectRoot()` for linked worktree detection via `git rev-parse --git-common-dir`

---

## Provider Integration (Optional, Not Required)

Provider-specific tools MAY optimize the workspace experience but MUST NOT be required:

| Provider | Optional Integration | CLEO Dependency |
|---|---|---|
| Claude Code | `--worktree` flag, `isolation: worktree` in agent frontmatter | None. CLEO manages its own workspaces. |
| Codex CLI | Working directory parameter | None. Agent receives `worktreePath` from CLEO. |
| Gemini CLI | Working directory parameter | None. Same LAFS interface. |
| Any future agent | Reads `worktreePath` from CLEO bootstrap | None. Pure LAFS. |

CLEO provides the workspace. The agent operates within it. The agent never needs to know about git worktrees -- it just receives a directory path and works there.

---

## Summary

CLEO Workspaces fill a gap that no existing tool addresses: **provider-neutral, lifecycle-aware, epic-scoped git isolation** for concurrent multi-agent development. Git worktrees solve filesystem isolation, but what no existing tool provides is the **orchestration intelligence layer** on top — binding isolation to structured epics, sessions, and lifecycle gates.

1. **CLEO owns isolation** -- Agents don't call `git worktree`. CLEO creates, tracks, and cleans up workspaces via its own MCP operations and CLI.
2. **Provider-neutral** -- Any agent that speaks LAFS can use workspaces. No dependency on Claude Code, Codex, or any specific tool. Any agent receives `worktreePath` and `branchName` through standard bootstrap — no provider-specific mechanism required.
3. **Epic-scoped** -- Each workspace is bound to a structured CLEO epic ID with provenance, not a random name. CLEO knows which epics are active where.
4. **Conflict-aware** -- Cross-terminal detection prevents agents from colliding, regardless of which provider's agent is running. One workspace per epic, with explicit parallel workspace creation.
5. **Lifecycle-integrated** -- Workspaces live until the epic reaches `released` in RCASD, not ad-hoc cleanup. Cleanup is tied to lifecycle gates.
6. **Session-continuous** -- Handoff data includes git state with branch/commit SHA preserved in debrief. Resume a session and pick up exactly where the previous agent left off.

**No other task management tool links git worktrees to a structured epic/session/lifecycle system.** This is CLEO's differentiator — provider-neutral workspace isolation that any LAFS-speaking agent can use, managed entirely through CLEO's own MCP operations and CLI.

---

## Sources

### Git Documentation
- [Git Worktree Official Documentation](https://git-scm.com/docs/git-worktree) -- Canonical reference for worktree internals, linked worktree `.git` file format, path resolution (`$GIT_DIR` vs `$GIT_COMMON_DIR`), lock/prune lifecycle
- [Git rev-parse Documentation](https://git-scm.com/docs/git-rev-parse) -- `--git-common-dir`, `--show-toplevel`, `--git-dir` for programmatic worktree detection
- [Git Repository Layout](https://git-scm.com/docs/gitrepository-layout) -- `.git/worktrees/` directory structure and per-worktree vs shared state

### Multi-Agent Isolation Tools
- [parallel-code (GitHub)](https://github.com/johannesjo/parallel-code) -- Open-source multi-agent orchestrator with automatic worktree isolation and `node_modules` symlink optimization
- [Container Use / Dagger (GitHub)](https://github.com/dagger/container-use) -- MCP server combining container isolation with git branch management
- [Docker AI Sandboxes](https://docs.docker.com/ai/sandboxes/) -- MicroVM-based agent isolation with dedicated Docker daemons

### Concurrency & Safety
- [auto-worktree Concurrency Issue #174](https://github.com/caarlos0/auto-worktree/issues/174) -- Documents concurrent access hazards with shared `.git` state (gc + write corruption)
- [Running Multiple AI Sessions in Parallel (DEV Community)](https://dev.to/datadeer/part-2-running-multiple-claude-code-sessions-in-parallel-with-git-worktree-165i) -- Community patterns for multi-session worktree workflows

### Non-Git VCS References
- [Jujutsu Git Compatibility Docs](https://docs.jj-vcs.dev/latest/git-compatibility/) -- Confirms `jj workspace` is native (not built on `git worktree`); automatic snapshotting advantage
- [Perforce Client Spec Documentation](https://help.perforce.com/helix-core/server-apps/cmdref/current/Content/P4Guide/configuration.workspace.html) -- Perforce workspace (client spec) architecture for multi-workspace isolation

### CLEO Internal References
- [CLEO Vision Charter](../docs/concepts/vision.md) -- Provider-neutral identity, portable brain contract, architectural constraints
- [LAFS Protocol (GitHub)](https://github.com/kryptobaseddev/lafs-protocol) -- Agent communication contract that enables provider-neutral workspace operations
- [`src/core/paths.ts`](../src/core/paths.ts) -- CLEO path resolution: `CLEO_ROOT` env var support (line 83), `getProjectRoot()` algorithm

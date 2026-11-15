# New Contributor Walkthrough

**Audience**: a new contributor who knows Git and Node and nothing about CLEO.

**Goal**: pick up a task, do the work, open a PR that closes it, and record what you learned.

CLEO is a CLI for tasks, memory and docs. Agents and people use it through
`cleo <command> [args]`, and every call prints one JSON envelope on stdout
(ADR-086). Seven commands cover most day-to-day work. `cleo <command> --help`
is the reference for every flag; this page only shows the common case.

---

## 1. `cleo briefing`

**What**: prints the context to resume a session: the latest handoff, the next
ready tasks and recent learnings from memory.

**Why**: it is the one place to find out what is going on. Do not read old
handoff markdown files instead; they go stale.

```bash
cleo briefing
```

Run it first in every session.

---

## 2. `cleo focus <taskId>`

**What**: one call that orients you on a task, epic or saga: its identity,
scope, blockers, ready wave, linked docs and memory context.

**Why**: it replaces about eight separate calls (`show`, `list --parent`,
`memory find`, `docs list` and others).

```bash
cleo focus T1234
```

Use `cleo show T1234 --full` only when you need the raw record, including the
description and verification that a bare `cleo show` withholds.

---

## 3. `cleo orchestrate spawn <taskId>`

**What**: prepares the spawn for a worker: the chosen agent, role, tier and the
full prompt. `cleo orchestrate spawn-execute <taskId>` then provisions the
task's worktree and starts a harness worker in it. See the
[orchestration flow](../concept/orchestration-flow.md).

**Why**: each worker gets its own checkout and branch (`task/<taskId>`), so
parallel workers never touch each other's files. Worktrees live under
`<cleoHome>/worktrees/<projectHash>/<taskId>/`, where `<cleoHome>` is
`~/.local/share/cleo` on Linux and `~/Library/Application Support/cleo` on
macOS (`CLEO_HOME` overrides it).

```bash
cleo orchestrate spawn T1234             # the default tier
cleo orchestrate spawn T1234 --tier 0    # minimal prompt
cleo orchestrate spawn T1234 --tier 2    # adds skill excerpts
cleo orchestrate spawn T1234 --no-worktree   # tasks that only run commands
```

**Common mistake**: starting a worker by hand without a worktree. It then works
on `main`. Provision the worktree through CLEO first.

---

## 4. `cleo docs add` and `cleo docs fetch`

**What**: the only way to write and read canonical docs (ADRs, specs, guides,
plans, research, notes and the other kinds). The docs store holds the content,
and `cleo docs publish` writes the mirror under `docs/<kind>/`.

**Why**: never write `docs/`, `.cleo/adrs/`, `.cleo/research/` or
`.cleo/agent-outputs/` by hand. A raw write skips the slug, kind and naming
checks, and CI's canon drift check fails it. Before adding a doc, look for an
existing one (`cleo docs query "<topic>"`) and update it instead
(`cleo docs update <slug> --file <path>`).

```bash
# add a note owned by a task, from a file
cleo docs add T1234 ./walk.md --type note --slug onboarding-walk

# add an ADR (the number is allocated for you)
cleo docs add T1234 ./decision.md --type adr --title "Use Drizzle for migrations"

# read by slug
cleo docs fetch onboarding-walk --content

# list the doc kinds
cleo docs schema
```

Slugs and file names are lowercase kebab-case, at most 64 characters, with no
task id, session id or date (D11210). The how-to is the
[documentation SOP](../guide/cleo-documentation-sop.md).

---

## 5. Open a PR that names its tasks

**What**: work on your task branch, then open a ready PR to `main` whose body
says which acceptance criteria it delivers:

```text
Closes: T1234 AC1,AC2
```

Use `Refs: T1234 AC1` for partial delivery. Check the lines before asking for a
merge:

```bash
cleo done --from-merge <pr> --dry-run
```

**Why**: a PR closes its tasks only through these lines. A reviewer who is not
the author records a verdict per criterion on the PR's head:

```bash
cleo review packet <pr> --task T1234
cleo review verdict <pr> --task T1234 --ac AC1 --met --reason "..." --packet <packetSha256>
cleo review check <pr> --task T1234
```

When the PR merges with its required checks green, the merge sweep closes the
named tasks and records the `pr:`, `ci:` and `satisfies:` evidence (ADR-099).
There is no verify or complete step after the merge. See the
[merge runbook](../guide/merge-runbook.md).

**Common mistake**: pushing again after the verdict. A new push moves the head,
and verdicts on the old head no longer count.

---

## 6. Work without a PR: `cleo done`, `cleo verify`, `cleo complete`

**What**: for work that ships no PR, record each gate's evidence yourself, then
complete the task.

```bash
cleo done T1234 --plan       # names the gates and the evidence each needs
cleo verify T1234 --gate implemented --evidence "commit:<sha>;files:src/a.ts,src/b.ts"
cleo verify T1234 --gate testsPassed --evidence "tool:test"
cleo verify T1234 --gate qaPassed --evidence "tool:lint;tool:typecheck"
cleo complete T1234
```

A decision-only task uses `decision:<id>` as its `implemented` evidence.

**Why**: evidence is checked against git, files and tools (ADR-051), not taken
on trust. `cleo verify --all` without evidence is refused with
`E_EVIDENCE_MISSING`. `cleo complete` checks every atom again, so a file changed
after `verify` fails with `E_EVIDENCE_STALE`; verify again with the new
evidence.

**Common mistake**: `cleo complete --force`. The flag was removed and fails with
`E_FLAG_REMOVED`. Owner overrides are audited and owner-only; see
`cleo briefing inject --section evidence`.

---

## 7. `cleo memory observe`

**What**: records a learning in project memory, searchable in later sessions.

**Why**: future agents, and future you, find it through `cleo briefing` and
`cleo memory find` instead of repeating the mistake.

```bash
cleo memory observe "A shard that times out after a failure hides a real red; read the log first" \
  --title "Timed-out shard hid a failure"

cleo memory find "timed-out shard"
cleo memory timeline <memoryId>
```

Record one after every non-trivial task.

---

## One task, end to end

```bash
cleo briefing                         # 1. resume
cleo focus T1234                      # 2. orient

# 3. do the work on the task branch, in the task's worktree
git switch -c task/T1234              # or let spawn-execute provision it

# 4. a doc change goes through the store, never a raw write
cleo docs update onboarding-walk --file ./walk.md --message "Add the PR flow"
cleo docs publish onboarding-walk --for T1234 --to docs/note/onboarding-walk.md

# 5. check, commit and open a PR that names the task
pnpm biome check --write <changed files>
git add <changed files>
git commit -m "docs(T1234): onboarding walk covers the PR flow"
git push -u origin task/T1234
gh pr create --title "docs(T1234): onboarding walk covers the PR flow" \
  --body "Closes: T1234 AC1,AC2"
cleo done --from-merge <pr> --dry-run

# 6. a reviewer records verdicts; the PR merges on green CI;
#    the merge sweep closes T1234

# 7. record what you learned
cleo memory observe "..." --title "..."
```

Stage explicit paths only; never `git add -A`. Run heavy work (tests, builds)
through `cleo run --wait --class <test|build|full-build> -- <command>`.

---

## Cross-references

- CLEO protocol: `packages/core/templates/CLEO-INJECTION.md`
- [ADR-051: programmatic gate integrity](../adr/adr-051-programmatic-gate-integrity.md)
- [Merge runbook](../guide/merge-runbook.md): PR, verdict and merge sweep (ADR-099)
- [Orchestration flow](../concept/orchestration-flow.md): spawn, worktree, worker
- [CLEO architecture guide](../concept/cleo-architecture-guide.md)

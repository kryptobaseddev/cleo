# CLEO 7-Concept CLI Walkthrough (new contributor onboarding)

**Audience**: A new contributor on day 2. Assumes Git + Node familiarity; assumes zero CLEO knowledge.

**Goal**: After reading this doc you should be able to pick up a task, do the work, prove it passed gates, and ship it.

CLEO is a CLI-driven task + memory protocol. Everything flows through `cleo <verb> [args]`. There are no GUIs, no markdown handoff files to read, no scattered config — just commands. The seven concepts below cover ~95% of day-to-day work.

---

## Concept 1 — `cleo briefing`

**WHAT**: Prints the canonical session-resume context: most recent handoff note, next ready tasks, and a BRAIN digest of recent learnings.

**WHY**: This is the ONLY canonical source of "what's going on" in your project. Reading `NEXT-SESSION-HANDOFF.md`, `HONEST-HANDOFF-*.md`, or any other markdown file as a substitute is forbidden — they go stale and have historically caused agents to act on false information.

**TYPICAL INVOCATION**:

```bash
cleo briefing
```

That's it. It's always the FIRST command of any session. No flags needed for the common case.

**COMMON FOOTGUN**: Grepping the filesystem for handoff notes instead of running `cleo briefing`. If you find yourself running `cat .cleo/agent-outputs/*.md` to figure out what to do next — STOP and run `cleo briefing` instead.

---

## Concept 2 — `cleo focus <TaskId>`

**WHAT**: Single-call orient surface for one task. Returns identity + scope + blockers + ready wave + linked docs + BRAIN context in ONE envelope (≤ 1500 tokens). Replaces 8 separate calls (`show`, `list --parent`, `memory find`, `docs list`, `git log --grep`, etc.).

**WHY**: Token-efficient orientation. Before `cleo focus` shipped, agents would spend 3000+ tokens calling 8 different sub-commands just to find out what a task was about. Now it's one call.

**TYPICAL INVOCATION**:

```bash
cleo focus T10382
```

Use this BEFORE you start any work on a task. Use it instead of `cleo show <id>` unless you specifically need the raw task record.

**COMMON FOOTGUN**: Falling back to `cleo show` or `cleo list --parent <id>` out of habit when `cleo focus` would do the same job in ¼ the tokens. The fallback is fine — but check `cleo focus` first.

---

## Concept 3 — `cleo orchestrate spawn <TaskId>`

**WHAT**: Provisions a worker agent for a task. Creates a git worktree under `~/.local/share/cleo/worktrees/<projectHash>/<taskId>/`, builds a fully-resolved spawn prompt (tier 0/1/2), and returns the prompt for dispatch.

**WHY**: Worktree isolation. Every worker gets its own checkout, its own branch (`task/<TaskId>`), and its own context boundary. Workers MUST NOT write outside their worktree. This is how CLEO runs 4–12 parallel agents on the same project without them stepping on each other.

**TYPICAL INVOCATION**:

```bash
# default tier 1 — embeds CLEO-INJECTION protocol
cleo orchestrate spawn T9999

# minimal — quick workers, no protocol embed
cleo orchestrate spawn T9999 --tier 0

# full — embeds ct-cleo + ct-orchestrator skill excerpts
cleo orchestrate spawn T9999 --tier 2

# meta-tasks that ONLY run CLI commands (no code edits)
cleo orchestrate spawn T9999 --no-worktree
```

**COMMON FOOTGUN**: Spawning a generic agent (e.g. `Agent({subagent_type: "general-purpose"})`) WITHOUT first running `cleo orchestrate spawn` to provision a worktree. This is a protocol violation — the agent will operate on `main` and you'll spend 30+ minutes salvaging the patch. ALWAYS provision the worktree first.

---

## Concept 4 — `cleo docs add` / `cleo docs fetch`

**WHAT**: The SSoT routing layer for canonical documents (ADRs, specs, research notes, handoffs, plans, llm-readme, changesets, release notes, RCASD docs, generic notes). `add` writes via the central allocator + writer registry; `fetch` reads by slug.

**WHY**: NEVER raw-fs-write `.cleo/adrs/`, `.cleo/research/`, `.cleo/agent-outputs/`, or `docs/`. The `cleo docs add` path enforces slug uniqueness, doc-kind validation, and dual-write (blob-store SSoT + human-readable mirror). Raw writes bypass these guards and trigger the CI canon-drift gate.

**TYPICAL INVOCATION**:

```bash
# write a note
cleo docs add --type note \
  --slug my-onboarding-walk \
  --title "Onboarding walkthrough" \
  --content-file /tmp/walk.md

# write an ADR (slug auto-allocates as adr-NNN-<title-slug>)
cleo docs add --type adr --title "Use Drizzle for migrations"

# read by slug
cleo docs fetch my-onboarding-walk

# list available kinds
cleo docs list-types
```

**COMMON FOOTGUN**: Writing to `.cleo/adrs/ADR-XXX.md` directly with the `Write` tool or `echo > file`. CI will fail on `Canon Drift Check`. Even when you "know" the slug — let the central allocator allocate it; collision returns `E_SLUG_RESERVED` with 3 alternative suggestions.

---

## Concept 5 — `cleo verify --gate <name> --evidence "atom1;atom2"`

**WHAT**: Records programmatic evidence that a quality gate passed. Per ADR-051, gate writes MUST be backed by atoms CLEO can verify against git, the filesystem, or the toolchain. Naked `cleo verify --all` is REJECTED with `E_EVIDENCE_MISSING`.

**WHY**: Before ADR-051 agents would self-attest "tests pass" without actually running tests. Evidence atoms close that loop — `commit:<sha>` must reference a reachable commit, `files:<list>` files must hash-match, `tool:test` must exit 0, `pr:<num>` must be MERGED with all required workflows SUCCESS or SKIPPED.

**TYPICAL INVOCATION**:

```bash
# Per gate — code change
cleo verify T9999 --gate implemented --evidence "commit:abc123;files:src/foo.ts,src/bar.ts"
cleo verify T9999 --gate testsPassed --evidence "tool:test"
cleo verify T9999 --gate qaPassed --evidence "tool:lint;tool:typecheck"
cleo verify T9999 --gate documented --evidence "files:docs/spec.md"

# Single-atom shortcut — AFTER your PR merges (pr:<num> satisfies BOTH testsPassed AND qaPassed)
cleo verify T9999 --gate implemented --evidence "pr:357"
cleo verify T9999 --gate testsPassed --evidence "pr:357"
cleo verify T9999 --gate qaPassed --evidence "pr:357"
cleo verify T9999 --gate documented --evidence "files:.cleo/notes/my-walk.md"

# Decision-only task (no code change)
cleo verify T9999 --gate implemented --evidence "decision:D-arch-001;note:decision recorded in BRAIN"
```

**COMMON FOOTGUN**: Using `commit:<sha>` AFTER the branch has been deleted (e.g. post-merge with squash). The commit is no longer reachable from any ref and `cleo verify` rejects it. Use `pr:<num>` for post-merge verification — same atom satisfies all 3 gates.

---

## Concept 6 — `cleo complete <TaskId>` (+ the AC-coverage gate)

**WHAT**: Marks a task done. CLEO re-validates every hard atom recorded by `cleo verify` (commit reachable, file sha256 match, test-run hash match, PR still MERGED). On post-T10509 builds, an additional **AC-coverage gate** checks that each acceptance criterion on the task is bound to at least one piece of evidence.

**WHY (the AC-coverage gate specifically)**: Pre-T10509, agents could complete a task whose AC list said "passes 5 integration tests" with evidence that proved only 1 of them ran. The AC-coverage gate forces a 1-to-1 binding so the AC list and the shipped evidence agree.

**TYPICAL INVOCATION**:

```bash
# Standard happy path
cleo complete T9999

# AC-coverage gate fires — you genuinely covered the work but some ACs are not directly bindable
cleo complete T9999 \
  --waive-ac "ac3,ac5" \
  --waive-reason "self-bootstrap: docs-only task validated via documented evidence atom"
```

Modifying source files AFTER `cleo verify` but BEFORE `cleo complete` triggers `E_EVIDENCE_STALE` — re-verify with the updated atoms.

**COMMON FOOTGUN**: Trying `cleo complete --force` to bypass a failing gate. The `--force` flag was REMOVED in ADR-051. Legitimate emergency overrides go through `CLEO_OWNER_OVERRIDE=1` with a reason and append to `.cleo/audit/force-bypass.jsonl`. Use sparingly.

---

## Concept 7 — `cleo memory observe "<learning>" --title "..."`

**WHAT**: Records a learning into BRAIN (the persistent project memory). Searchable across sessions via `cleo memory find`.

**WHY**: Every non-trivial completed task SHOULD record what was learned — what went wrong, what worked, what to do differently next time. Future agents (including future-you) pull these via `cleo briefing` and `cleo memory find` to avoid repeating mistakes.

**TYPICAL INVOCATION**:

```bash
cleo memory observe \
  "GHA workflow_runs?head_sha=<sha> returns empty when webhook is stuck on stale PR ref. Rebase + force-push fixes 70% of cases; recreating branch as <branch>-v2 fixes 95%." \
  --title "T10382: GHA webhook stuck-ref recovery"

# search later
cleo memory find "GHA webhook stuck"

# pull timeline of context around an entry
cleo memory timeline <memoryId>
```

**COMMON FOOTGUN**: Skipping `cleo memory observe` on non-trivial work because "the commit message says enough". Commit messages aren't searchable across the BRAIN substrate and don't surface in `cleo briefing`. If a future agent could trip on the same rake, write the observation.

---

## Putting it together — one task end-to-end

A fictional task: T9999, "doc: add CLI walkthrough for new contributors".

```bash
# 1. Resume context.
cleo briefing

# 2. Orient on the assigned task.
cleo focus T9999

# 3. Provision a worker (yourself, in this case).
cleo orchestrate spawn T9999
# → prints a worktree path under ~/.local/share/cleo/worktrees/<hash>/T9999/
# → first action: cd to that path.

cd ~/.local/share/cleo/worktrees/abc123/T9999

# 4. Do the work. Write the doc body to a temp file.
$EDITOR /tmp/walk.md

# 5. File the doc through the SSoT — NOT a raw write.
cleo docs add --type note \
  --slug new-contributor-walk \
  --title "New contributor CLI walkthrough" \
  --content-file /tmp/walk.md

cleo docs fetch new-contributor-walk  # sanity-check it landed

# 6. Add a changeset.
cat > .changeset/t9999-walk.md <<'EOF'
---
id: t9999-walk
tasks: [T9999]
kind: docs
---
doc: new contributor CLI walkthrough
EOF

# 7. Quality gates locally.
pnpm biome check --write .
node scripts/lint-changesets.mjs
git diff --stat HEAD

# 8. Commit, push, open PR.
git add -A
git commit -m "docs(T9999): new contributor CLI walkthrough"
git push -u origin task/T9999
gh pr create --title "docs(T9999): new contributor CLI walkthrough" --body "Closes T9999."

# 9. Wait for CI green, then admin-merge (or merge-queue).
gh pr merge --squash --admin <PR_NUM>

# 10. Record evidence — pr:<num> satisfies 3 of the 4 gates in one atom.
cleo verify T9999 --gate implemented --evidence "pr:<PR_NUM>"
cleo verify T9999 --gate testsPassed --evidence "pr:<PR_NUM>"
cleo verify T9999 --gate qaPassed --evidence "pr:<PR_NUM>"
cleo verify T9999 --gate documented --evidence "files:.cleo/notes/new-contributor-walk.md"

# 11. Complete. If AC-coverage gate fires on a docs-only task, waive with reason.
cleo complete T9999
#  OR
cleo complete T9999 \
  --waive-ac "ac3" \
  --waive-reason "self-bootstrap: docs-only task validated via documented evidence atom"

# 12. Record what you learned.
cleo memory observe \
  "pr:<num> atom satisfies implemented + testsPassed + qaPassed in one shot — much cheaper post-merge than re-running the full monorepo suite." \
  --title "T9999: pr:<num> atom is the post-merge shortcut"
```

That's the full loop. Twelve commands, one PR, one task closed, one BRAIN entry. Everything else in CLEO (`saga`, `orchestrate ready`, `nexus impact`, `lifecycle`, `playbook`, `sentient`) is variations on those seven concepts.

---

## Cross-references

- **CLEO-INJECTION protocol** (full canonical injection): `packages/core/templates/CLEO-INJECTION.md`
- **ADR-051** (evidence-based gate ritual): `cleo docs fetch adr-051-evidence-based-gate-ritual`
- **ADR-055** (worktree-by-default spawn): `cleo docs fetch adr-055-worktree-by-default-spawn`
- **AC-stable-IDs migration plan** (SAGA T10377 wave 4): cross-references this doc as the contributor-side companion.

Closes **Council action #3** (T10377 SG-IVTR-AC-BINDING).

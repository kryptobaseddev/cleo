# T145x team worker spawn pattern

For each domain worker (T1451-T1458), spawn as teammate:

```
Agent({
  description: "Worker: <domain> domain Core normalization",
  subagent_type: "general-purpose",
  model: "sonnet",
  team_name: "t1449-ssot-alignment",
  name: "<domain>-worker",  // e.g. "admin-worker", "tasks-worker"
  prompt: <prompt>
})
```

## Per-domain context

| Task | Domain | Worktree | Branch | Contract file | Special handling |
|---|---|---|---|---|---|
| T1451 | admin | ~/.local/share/cleo/worktrees/1e3146b7352ba279/T1451 | task/T1451 | `packages/contracts/src/operations/admin.ts` | — |
| T1452 | check | ~/.local/share/cleo/worktrees/1e3146b7352ba279/T1452 | task/T1452 | `packages/contracts/src/operations/validate.ts` | NO `check.ts` — uses validate types |
| T1453 | conduit | ~/.local/share/cleo/worktrees/1e3146b7352ba279/T1453 | task/T1453 | `packages/contracts/src/operations/conduit.ts` | — |
| T1454 | nexus | ~/.local/share/cleo/worktrees/1e3146b7352ba279/T1454 | task/T1454 | `packages/contracts/src/operations/nexus.ts` | Has engine wrapper |
| T1455 | pipeline | ~/.local/share/cleo/worktrees/1e3146b7352ba279/T1455 | task/T1455 | `packages/contracts/src/operations/lifecycle.ts` + `release.ts` | Multi-contract domain |
| T1456 | playbook | ~/.local/share/cleo/worktrees/1e3146b7352ba279/T1456 | task/T1456 | NO contract file — `@cleocode/playbooks` types | Document SSoT exception OR create new contract |
| T1457 | sentient | ~/.local/share/cleo/worktrees/1e3146b7352ba279/T1457 | task/T1457 | `packages/contracts/src/operations/sentient.ts` | — |
| T1458 | tasks | ~/.local/share/cleo/worktrees/1e3146b7352ba279/T1458 | task/T1458 | `packages/contracts/src/operations/tasks.ts` | INCLUDES alias removal (parent/parentId, role/kind) per ADR-057 D2 |

## Worker prompt template

```
You are <domain>-worker, a teammate on team t1449-ssot-alignment. Your task: T145N (<domain> domain Core API alignment).

## REQUIRED reading (in order)
1. /mnt/projects/cleocode/.cleo/agent-outputs/T1449-CORE-API-AUDIT.md — audit + decisions (Q1+Q2 resolved)
2. /mnt/projects/cleocode/.cleo/agent-outputs/T1450-MIGRATION-PATTERN.md — proven pattern from session PROOF
3. /mnt/projects/cleocode/.cleo/agent-outputs/T145x-augmentation-template.txt — recipe template
4. T1450 commits (your reference): `git log main..task/T1450 --oneline; git show <sha> --stat`
5. cleo show T145N

## Worktree (FIRST ACTION)
cd /home/keatonhoskins/.local/share/cleo/worktrees/1e3146b7352ba279/T145N

## Cherry-pick OpsFromCore helper from T1450 (5220aeef2 OR 338bc56fe via task/T1450)
git fetch origin
git cherry-pick 338bc56fe  # OpsFromCore helper, already cherry-picked to T1450

## Refactor scope (per audit + PROOF pattern)
- Read packages/contracts/src/operations/<contract-file>.ts — list every <Op>Params and <Op>Result
- For each Core fn that backs a dispatch op (in packages/core/src/<domain>/):
  - Refactor to: async function <name>(projectRoot: string, params: <Op>Params): Promise<<Op>Result>
  - Body destructures params; remove inline option types
  - Per ADR-057 D1 uniform Core API
- Update internal Core callers (cleo.ts facade, tests, scripts, any internal sibling file callers)
- Engine wrapper layer (if domain has one): treat as legitimate intermediate per ADR-057 D4 — only touch if directly broken by Core changes
- Dispatch handler: refactor to OpsFromCore<typeof coreOps> if engine layer collapse is feasible; else leave dispatch alone (engine still wraps Core)

## Special: T1458 tasks ONLY
Also remove aliases per ADR-057 D2:
- Delete `parentId?` from TasksAddParams, TasksUpdateParams, TasksUpdateQueryParams
- Delete `kind?` from TasksAddParams (where it duplicates `role`)
- Move CLI flag aliasing into packages/cleo/src/cli/commands/tasks.ts (`.option('--parent-id <id>')` maps to params.parent before dispatch)
- Update packages/studio/src/routes/api/tasks/+server.ts AND [id]/+server.ts if they referenced aliases
- Remove `params.parent ?? params.parentId` and `params.role ?? params.kind` from dispatch

## Special: T1456 playbook ONLY
No contract file exists. Either:
- Create packages/contracts/src/operations/playbook.ts re-exporting Playbook* types from @cleocode/playbooks AND defining PlaybookXParams/Result, OR
- Document SSoT-EXEMPT: @cleocode/playbooks owns its own types
Document your choice.

## Quality gates (BEFORE complete)
pnpm install  # fixes pre-existing caamp module-resolution
pnpm biome check --write .
pnpm run build 2>&1 | tail -30   # exit 0
pnpm run test 2>&1 | tail -30    # zero new failures vs main
git diff --stat HEAD

## Atomic commits
Conventional commit messages: feat(T145N): <action>

## Evidence + complete (do NOT skip)
HEAD_SHA=$(git rev-parse HEAD)
FILES=$(git diff --name-only main..HEAD | tr '\n' ',' | sed 's/,$//')
cleo verify T145N --gate implemented --evidence "commit:$HEAD_SHA;files:$FILES"
cleo verify T145N --gate testsPassed --evidence "tool:pnpm-test"
cleo verify T145N --gate qaPassed --evidence "tool:biome;tool:tsc"
cleo verify T145N --gate documented --evidence "files:.cleo/agent-outputs/T1450-MIGRATION-PATTERN.md"
cleo verify T145N --gate cleanupDone --evidence "note:<domain> normalized; followed PROOF pattern"
cleo verify T145N --gate securityPassed --evidence "note:type/signature refactor; no network surface"
cleo memory observe "T145N <domain> Core normalization. Per ADR-057 D1." --title "T145N <domain> SSoT alignment"
cleo manifest append --task T145N --type implementation --content "<domain> normalized per ADR-057. <ops_count> Core fns refactored. Gates green." --status completed
cleo complete T145N

## When done
Send message via SendMessage to team-lead-2: "T145N done. <one line summary>. Hand back."

## Hard constraints
- NEVER `any` or `unknown` shortcuts.
- NEVER inline-define types that should come from `@cleocode/contracts`.
- NEVER skip quality gates.
- If you hit a real blocker, STOP and report partial via SendMessage AND `cleo manifest append --status partial`.
- The shim blocks `git checkout`, `git switch`, `git reset --hard`.

Begin with reading the audit doc.
```

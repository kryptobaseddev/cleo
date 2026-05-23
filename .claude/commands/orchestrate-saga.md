---
description: Generate strict <3900-char goal-orchestrator prompt for a saga and lock via /goal
argument-hint: <sagaId> [--docs slug1,slug2] [--decisions D001,D002] [free-text intent]
allowed-tools: Bash, Read, Write, SlashCommand, Task, AskUserQuestion
model: opus
---

# Orchestrate Saga

Generate a strict, structured Prime-Orchestrator goal prompt for the saga in `$ARGUMENTS` and lock it via `/goal`. Generated prompt MUST be ≤3900 characters. Target 3700 for safety.

## Argument parsing

First token = saga ID (e.g. `T10176`). Optional flags:

- `--docs <comma-list>` — research doc slugs to include
- `--decisions <comma-list>` — memory decision IDs to include
- Anything else = free-text intent appended to the generated prompt's final line

If `--docs` omitted, auto-discover via `cleo docs find "<sagaTitle>"`. If `--decisions` omitted, auto-discover via `cleo memory find "<sagaTitle>" --type decision`.

## Execute in order

### Step 1 — Gather saga context (read-only, batched in ONE bash block)

```bash
SAGA="<sagaId from $ARGUMENTS>"
cleo show $SAGA 2>&1 | python3 -c "import json,sys; d=json.load(sys.stdin)['data']; t=d['task']; print(f\"TITLE={t['title']}\"); print(f\"AC_COUNT={len(t.get('acceptance',[]))}\"); print(f\"STATUS={t['status']}\")"
cleo saga rollup $SAGA 2>&1 | python3 -c "import json,sys; d=json.load(sys.stdin)['data']; print(f\"TOTAL={d['total']} DONE={d['done']} PCT={d['completionPct']}\")"
# Try saga groups relation first; fall back to parent-edge enumeration if empty.
MEMBERS=$(cleo saga members $SAGA 2>&1 | python3 -c "import json,sys; d=json.load(sys.stdin)['data']
ms = d.get('members', d.get('items', []))
out = []
for m in ms:
    if isinstance(m, dict) and m.get('id'):
        out.append(f\"EPIC {m['id']} {(m.get('title') or '')[:60]}\")
print('\n'.join(out))")
if [ -z "$MEMBERS" ]; then
  # Fallback: enumerate child Epics via parent edge.
  # T9658 wired `cleo list --parent <saga>` through saga.groups in packages/core/src/tasks/list.ts,
  # so this branch + the primary `cleo saga members` cover every shipped saga shape.
  MEMBERS=$(cleo list --parent $SAGA --limit 50 2>&1 | python3 -c "import json,sys; d=json.load(sys.stdin)['data']
for t in d['tasks']:
    if t.get('type') == 'epic':
        rollup = t.get('childRollup', {})
        nt = rollup.get('total', 0) if isinstance(rollup, dict) else 0
        print(f\"EPIC {t['id']} {t['title'][:55]} ({nt}t)\")")
fi
if [ -z "$MEMBERS" ]; then
  echo "WARN: could not auto-enumerate Epic members for $SAGA. Ask user to supply --epics T9978,T9979,..."
  exit 2
fi
echo "$MEMBERS"
```

For each `--docs <slug>`: `cleo docs fetch <slug>` — capture description ONLY (not full body — too large for the generated prompt; we reference by slug).

For each `--decisions <id>`: `cleo memory fetch <id>` — capture decision text 1-line summary.

If auto-discover: `cleo docs find "$SAGA"` + `cleo memory find "$SAGA_TITLE" --type decision`. Pick top-1 of each.

### Step 2 — Compose the generated prompt

Emit the prompt below substituting `<placeholders>` from Step 1. Keep epic list to ID + 60-char title. Cap at 10 epics displayed; if more, say "+ N more — see cleo saga members".

```
SAGA <sagaId> <short-title> (<epicCount>E/<taskCount>T): ship 100% + install + dogfood.

ROLE: Prime Orchestrator. NEVER solo. TeamCreate per active Epic (lead + 3-5 workers). AskUserQuestion ONLY when blocked, 3 ranked researched options — never make user dig.

SESSION START:
1. cleo briefing
2. cleo show <sagaId> ; cleo saga rollup <sagaId>
3. cleo docs fetch <primary-research-slug>
4. cleo memory fetch <primary-decision-id>

EPICS (dep order):
<auto: one line per Epic "Eid — title (Nt)">

EXEC: TeamCreate continuous loop, never idle.
- Pull: `cleo orchestrate ready --epic <Eid>`. Spawn: `cleo orchestrate spawn <Tid>`.
- After every merge, re-pull next ready. Loop until rollup = N/N.
- Cross-team handoff via SendMessage on wave-block clear.

WORKTREE (NON-NEGOTIABLE):
- Orchestrator + teams stay on local main.
- Worker: `git worktree add -b feat/<Tid>-<slug> ~/.local/share/cleo/worktrees/<projectHash>/<Tid> origin/main` (projectHash via @cleocode/paths — NEVER literal name, NEVER /mnt/projects/* siblings, NEVER .claude/worktrees/).
- Worker's FIRST action: `cd <worktree>` BEFORE any Edit/Write/Bash.

PER-TASK FLOW (one PR/Task):
worktree → implement → `pnpm biome check --write . && pnpm run build && pnpm exec vitest run <scope>` → `.changeset/<Tid>.md` → conventional commit (Closes <Tid>; Saga: <sagaId>; Decision: <Did>) → push → `gh pr create` → `gh pr checks <num> --watch` → `gh pr merge --merge --delete-branch` → `cleo verify <Tid> --gate {implemented,testsPassed,qaPassed} --evidence "pr:<num>" --shared-evidence` → `cleo complete <Tid>` → `git worktree remove` → re-pull.

ZERO-TOLERANCE:
- SOLID + DRY + boundary per ADR-078 (slug adr-078-boundary-registry); TOOLS-in-CORE = crates/<X>-core → <X>-napi → packages/<X> thin → @cleocode/core → @cleocode/cleo (dispatch-only).
- DELETE Rust↔TS dupes; no compat shims unless ADR amendment.
- File bugs vs EXISTING epics first (`cleo find "<symptom>" --status pending`); new epic only if no fit.
- NO admin-merge unless flake is documented saga-precedent (T9407/T9775). Diagnose, fix, re-push.
- Hierarchy (ADR-073): Saga→Epic→Task→Subtask. Task MUST fit one context window else split to Subtasks.

FINAL EPIC POST-MERGE:
1. `cleo release plan v<calver> --epic <sagaId>`
2. `cleo release open v<calver>` → release PR → merge → tag → npm publish
3. `npm i -g @cleocode/cleo@<calver>` → `cleo --version` confirms
4. DOGFOOD: `cleo orchestrate spawn <real-task>` → p50<5s, canonical projectHash path, zero new orphans
5. `cleo docs add closure-report` + `cleo memory observe`

NEVER STOP UNTIL: `cleo saga rollup <sagaId>` = N/N + release installed + dogfood green.
<free-text intent if any>
```

### Step 3 — Self-check character budget

```bash
GENERATED_PROMPT_FILE=/tmp/orchestrate-saga-prompt-${SAGA}.txt
echo "<composed prompt>" > "$GENERATED_PROMPT_FILE"
CHARS=$(wc -c < "$GENERATED_PROMPT_FILE")
echo "Generated prompt: $CHARS / 3900 chars"
if [ "$CHARS" -gt 3900 ]; then
  echo "OVER BUDGET. Auto-trim attempts: (a) drop HIERARCHY section, (b) drop POST-MERGE detail, (c) shorten epic titles to 50 chars, (d) drop ZERO-TOLERANCE non-essentials."
  exit 1
fi
```

If over budget, attempt auto-trim in this priority order:
1. Truncate epic-list to top 7; append "+ N more — see cleo saga members"
2. Shorten epic titles to 50 chars
3. Drop the HIERARCHY one-liner (covered by ADR-073 reference)
4. Drop POST-MERGE steps 4-5 if release already shipped
5. Fail loudly if still over budget — ask user to manually trim free-text intent

### Step 4 — Emit prompt to file + instruct fresh-context lock

**CRITICAL**: NEVER call `/goal` in the same context that generated the prompt. Context pollution from the generation conversation will distract the Prime Orchestrator on first activation. The goal MUST be locked in a fresh context window.

Steps:

1. Write the generated prompt to `/tmp/orchestrate-saga-prompt-<sagaId>.txt`.
2. Print to user:
   - File path
   - Char count + budget margin
   - 5-line preview (head + tail of prompt)
3. Use `AskUserQuestion` with options:
   - **"I'll lock in a new chat"** (Recommended) — user runs `/clear` or starts a new Claude Code conversation, then `/goal <pastes file contents>`
   - **"Show full prompt"** — `cat` the file to the conversation
   - **"Modify free-text intent and re-emit"** — re-prompt for additional intent, regenerate, overwrite file
   - **"Cancel"** — leave the file in /tmp for later use, do nothing

4. On "I'll lock in a new chat": print explicit instructions:

   ```
   To activate this goal:
   1. Run `/clear` (or open a new chat in this project).
   2. In the fresh context, paste the goal text from /tmp/orchestrate-saga-prompt-<sagaId>.txt as:
      /goal <paste contents>
   3. The Prime Orchestrator activates immediately and follows the saga's SESSION START + EXEC flow.
   ```

NEVER invoke `/goal` via `SlashCommand` from inside this command's flow — the calling context is by definition polluted with the generation work.

### Step 5 — Done

After emitting the file + instructions, end the response. The user controls when to switch contexts and activate the goal.

## Hard rules

- NEVER emit a generated prompt >3900 chars. Fail loudly + auto-trim.
- NEVER make the user dig — auto-fetch via `cleo docs find` / `cleo memory find` before asking.
- NEVER lock `/goal` in the same context that generated the prompt — emit to `/tmp/orchestrate-saga-prompt-<sagaId>.txt` and instruct the user to `/clear` first. Context pollution defeats the Prime-Orchestrator clean-start contract.
- ALWAYS include the START EVERY SESSION block, projectHash worktree constraint, and NEVER STOP UNTIL final line.
- ALWAYS reference the saga's primary research doc + decision by slug/id (not by body — the body lives in cleo docs/memory and gets fetched per session).
- NEVER bypass the worktree protocol or admin-merge gate.

## Examples

```
/orchestrate-saga T10176
```
→ Auto-discovers docs + decisions for T10176 SG-BOUNDARY-REGISTRY, composes prompt, locks via /goal.

```
/orchestrate-saga T10180 --docs sg-boundary-signaldock-canonical-homes --decisions D010 "prioritize crates.io publish in wave 4"
```
→ Uses explicit slug + decision, appends free-text intent.

```
/orchestrate-saga T9977 --docs sg-t9977-research,sg-worktrunk-own-closure-report --decisions D010
```
→ Multi-doc saga with closure report referenced for continuity.

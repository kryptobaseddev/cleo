# T553 — Fresh Agent Experience Report

**Date**: 2026-04-13
**Agent**: Fresh drop — zero prior context
**Mission**: Test whether CLEO's memory and context systems work for a new agent

---

## Step 1: What does the system tell me about this project?

**Commands run**:
```
cleo dash --json 2>&1 | head -30
cleo session status --json 2>&1 | head -10
```

**Output received**:
- `dash` returned: project name "Unknown Project", 77 pending tasks, 49 done, 1 cancelled, 425 archived (552 total). Active session exists. 41 high-priority tasks. First critical task: T234 (Agent Domain Unification epic).
- `session status` returned: active session `ses_20260413151357_3744a2` named "T553 JIT Agent Integration — Pi + CI + Real Testing". No current focus. Long list of session notes showing previous work history going back to March 2026.

**Did it help?** PARTIAL

**What was missing?**
- Project name is "Unknown Project" — this is a significant gap. A fresh agent cannot immediately know this is the CLEO CLI project without reading external files.
- The `dash` output dumps a full critical task description in the JSON response, which is verbose but useful at the same time.
- No plain-English summary of what the project does or is for.
- Session name references "JIT Agent Integration" but the session was started by whoever set up this test — it could confuse a new agent about what they should be doing.

**What would I need to be productive?**
- A project name and one-line description in the `dash` output.
- A "project goal" field distinguishable from task descriptions.

---

## Step 2: What should I work on?

**Commands run**:
```
cleo next --json
cleo current --json
```

**Output received**:
- `next` returned T234 (Agent Domain Unification epic) with score 111. Only 1 suggestion shown. 77 total candidates.
- `current` returned null — no active focus.

**Did it help?** PARTIAL

**What was missing?**
- Only 1 task suggested by `next`. A fresh agent has no basis for evaluating whether T234 is the right thing to work on vs. the 76 other candidates.
- T234 has `cancelledAt` set (2026-03-31T15:13:19.029Z) but status is "pending" — this is contradictory and confusing. A new agent would not know if this task is safe to pick up.
- No explanation of *why* T234 was chosen (score = 111 but no scoring rationale).
- The score of 100 for several tasks in `briefing` with zero leverage is not interpretable without context.
- `next` returns `suggestions[0]` only — new agents would benefit from seeing 3-5 options ranked.

**What would I need to be productive?**
- Top 3-5 suggested tasks, not just 1.
- A brief "why" field explaining the score composition.
- Warning if a task has `cancelledAt` set but is in pending status.

---

## Step 3: Can I understand the codebase?

**Commands run**:
```
cleo nexus status --json
cleo nexus clusters --json
```

**Output received**:
- `nexus status`: 11,248 nodes, 20,276 relations, 10,938 files, last indexed 2026-04-13 ~1 hour ago. 23 stale files.
- `nexus clusters`: 235 communities. Top clusters: Commands (264 symbols, 0.89 cohesion), Engines (261 symbols), Engines (212 symbols), Memory (209 symbols).

**Did it help?** PARTIAL

**What was missing?**
- 235 communities is too many to be useful for orientation. A new agent needs a curated "top 10" view.
- Two clusters both labeled "Engines" — ambiguous without drilling in.
- No description of what each cluster does, only symbol counts and cohesion scores.
- `nexus context <symbol>` and `nexus impact <symbol>` are the useful commands but a new agent would not know what symbol to look up without already knowing the codebase.
- The `.cleo/nexus-bridge.md` file (auto-generated) was significantly more useful than the raw CLI output — it gave a human-readable summary including top entry points and a command reference table.

**What would I need to be productive?**
- `nexus clusters` should show a brief description per cluster, not just label + count.
- A "start here" entry point recommendation — e.g., "the main dispatch function is `query` in `packages/cleo/src/dispatch/domains/admin.ts`."
- The nexus-bridge.md content should be surfaced by `cleo dash` or `cleo briefing` automatically.

---

## Step 4: Can I access project memory?

**Commands run**:
```
cleo memory find "architecture" --json
cleo memory find "brain" --json
cleo memory graph-stats --json
```

**Output received**:
- `memory find "architecture"`: 5 results — observations and one Pi v2+v3 item. Titles are truncated at ~70 chars. All results have `_next.fetch` pointers.
- `memory find "brain"`: 26 results — mix of patterns, learnings, and observations. Many are near-duplicate patterns ("Recurring label brain seen in N completed tasks" repeating for N=3 through N=12). These are noise.
- `memory graph-stats`: 300 total nodes (120 tasks, 112 patterns, 50 observations, 7 stickies, 5 learnings, 3 decisions, 3 sessions). 230 edges (119 applies_to, 107 derived_from, 3 produced_by, 1 references).

**Did it help?** PARTIAL

**What was missing?**
- The 26 brain search results include many duplicate-ish "Recurring label" patterns that do not help a fresh agent understand anything. These are graph noise artifacts.
- The `architecture` search returned only 5 results — all observations and Pi-related — but nothing explaining the overall system architecture.
- No "architecture overview" or "key concepts" entry in memory that a new agent can find with a simple keyword.
- `graph-stats` is interesting metadata but not directly actionable for onboarding.
- To get actual content from any result, you need a second `cleo memory fetch <id>` call, which adds latency.
- Only 3 decisions in the entire graph — very sparse for decision history.

**What would I need to be productive?**
- A curated "key decisions" memory entry with architecture decisions summarized.
- De-duplication of pattern entries (112 patterns is too many if most are "recurring label X seen in N tasks").
- A `cleo memory summary` command that returns the most recent 3 decisions + 3 learnings in one call.
- An "architecture" tag or canonical entry that `memory find "architecture"` reliably returns.

---

## Step 5: Can I get task context quickly?

**Command run**:
```
cleo context pull T234 --json
```

**Output received**:
- Task metadata (id, title, status, acceptance criteria).
- `relevantMemory`: empty array.
- `lastHandoff`: "T549 Waves 0-6 shipped as v2026.4.33. Starting JIT agent integration with Pi first-class support + CI fix."

**Did it help?** PARTIAL

**What was missing?**
- `relevantMemory` was empty — no memory was surfaced for an epic that presumably has significant history.
- The `lastHandoff` note referenced T549 (a completely different task), not T234. This is a session-level note, not a T234-specific note.
- No parent/child task relationships shown in context pull.
- T234 has `cancelledAt` set — this is not flagged in the context pull output, which would mislead a new agent into thinking it's a clean task.
- No links to related code files, ADRs, or design documents.

**What would I need to be productive?**
- `context pull` should flag anomalies (e.g., "WARNING: This task has cancelledAt set but status is pending").
- The handoff note should be task-specific, not just the most recent global session note.
- `relevantMemory` should always return at least the most recent 2-3 memory entries that touch this task by label or keyword.

---

## Step 6: Can I understand code I'm about to edit?

**Commands attempted**:
```
cleo nexus context observeBrain --json
```

**Output received**:
- Error: `Invalid query syntax: observeBrain. Expected: T001, project:T001, .:T001, or *:T001`
- The `cleo nexus context` command expects a task ID format, not a symbol name. This is incorrect — `nexus context` should take a symbol name.

**Follow-up**:
```
cleo nexus query "observeBrain" --json
```
- Same error: `Invalid query syntax` — the nexus query subcommand also appears to expect task references, not code symbols.

**Did it help?** NO

**What was missing?**
- `cleo nexus context <symbol>` appears to be either broken or mis-documented. The help text says "What calls this function? `cleo nexus context <symbol>`" but the command rejects non-task-ID input.
- A fresh agent trying to look up a function by name before editing it will hit this error with no fallback.
- The nexus-bridge.md helpfully lists the correct commands, but those commands don't work as documented.

**What would I need to be productive?**
- Fix `cleo nexus context <symbol>` to accept symbol names.
- Or clearly document the correct command to look up a symbol in the CLI help output.
- The error message should suggest: "Did you mean `cleo nexus symbol <name>`?" or similar.

---

## Step 7: Can I see what happened in past sessions?

**Command run**:
```
cleo briefing --json
```

**Output received**:
- Last session ended at 2026-04-13T15:13:55 (very recent — 1 minute ago).
- Last session duration: 648 minutes.
- Handoff note: "T549 Waves 0-6 shipped as v2026.4.33. Starting JIT agent integration with Pi first-class support + CI fix."
- Next suggested: T234, T483, T506.
- No open blockers, no open bugs.
- `nextTasks`: T234, T514, T515, T516, T548 — 5 options with scores.
- Memory context: 2 patterns, 5 recent observations, 1 recent learning.

**Did it help?** YES

**What was missing?**
- The handoff note is minimal ("T549 Waves 0-6 shipped...") — it does not say what T549 IS or what the JIT agent integration involves.
- `memoryContext.recentDecisions` is empty even though `graph-stats` shows 3 decisions exist.
- Observation titles are truncated — "Session note: MEGA-SESSION: T523 BRAIN Integrity + T513 Code Intelligence Pipeli..." — the ellipsis hides the actual content.
- No summary of what code areas were touched in the last session.

**What would I need to be productive?**
- Handoff notes should be structured: what was done, what's next, key decisions made.
- Recent decisions should always be surfaced in `briefing` (currently returns empty even when decisions exist).
- Full observation titles, or at least longer truncation (150 chars vs. current ~70).

---

## Step 8: Can I find relevant decisions?

**Commands run**:
```
cleo memory find "tiered memory" --json
cleo memory find "quality scoring" --json
```

**Output received**:
- `tiered memory`: 0 results.
- `quality scoring`: 8 results — 2 decisions (T545 test/final), 1 pattern, 1 learning (Wave C-2: Wire quality scoring into store functions), 5 observations.

**Did it help?** PARTIAL

**What was missing?**
- "Tiered memory" returns nothing despite memory tiers being a core CLEO concept — the terminology in memory does not match the terminology an agent would naturally use.
- "Quality scoring" found relevant results, but the top result was a test decision ("T545 test decision") which is noise.
- All results require a follow-up `memory fetch` call to see actual content.
- The `_next.fetch` hint is helpful for knowing which call to make next, but adds a required extra round trip.

**What would I need to be productive?**
- Search should be fuzzy/semantic, not keyword-only.
- First-class "decision" entries for major architectural choices (not just test decisions).
- Option for `memory find` to include a brief excerpt from the entry body (e.g., first 80 chars of content).

---

## Step 9: What's in the memory bridge?

**Command run**:
```
cat .cleo/memory-bridge.md | head -30
```

**Output received**:
- Auto-generated at 2026-04-13T15:13:56.
- Last session, next suggested tasks, 5 recent decisions, 8 key learnings, 8 patterns, 8 recent observations — all as single-line items with IDs and titles.

**Did it help?** YES

**What was missing?**
- Learnings have low-value titles like "Completed: Wave C-2: Wire quality scoring into store functions — Add quality_sco..." — useful for tracking what was done but not for understanding the system.
- Patterns section is dominated by "Recurring label X seen in N completed tasks" entries — these are statistical artifacts, not actionable patterns for a new agent.
- No "project summary" or "what is this project" section at the top.
- The bridge is auto-@included in AGENTS.md, so it IS automatically loaded — this is a genuine strength of the system.

**What would I need to be productive?**
- Add a 2-3 sentence "Project Summary" section at the top of memory-bridge.md.
- Filter out pure pattern-noise (recurring label entries) from the Patterns section.
- Include a "current focus area" line (e.g., "Active epic: T523 Brain Integrity + T513 Code Intelligence").

---

## Step 10: What's in the nexus bridge?

**Command run**:
```
cat .cleo/nexus-bridge.md | head -30
```

**Output received**:
- Auto-generated from nexus index.
- 2,482 files indexed. 11,248 symbols (breakdown by type). 20,276 relations. 6 functional clusters. 75 traced processes.
- Top 5 entry points with file paths and callee counts.
- Functional cluster list with symbol counts.
- Command reference table.

**Did it help?** YES — this was the most useful single artifact encountered.

**What was missing?**
- Two clusters labeled "Engines" with no distinguishing description — ambiguous.
- Top entry points show call depth but not purpose. "runUpgrade (39 callees)" tells a new agent nothing about what upgrade does.
- 75 execution flows are listed as a count — a fresh agent needs to know which 3-5 flows are the most important to understand first.
- The bridge is NOT auto-@included in AGENTS.md (memory-bridge.md is, but nexus-bridge.md does not appear to be loaded automatically). New agents may not find it.

**What would I need to be productive?**
- Auto-@include nexus-bridge.md alongside memory-bridge.md in AGENTS.md.
- Add 1-sentence descriptions to each cluster in the bridge.
- Surface the top 3 "critical path" execution flows — not just a count of 75.

---

## Summary

### Overall Experience Score: 5/10

The system has genuine infrastructure — tasks, memory, nexus indexing, bridging files — but the fresh-agent experience has significant friction. An agent can get oriented in ~5-8 tool calls but will be working with incomplete information and will make at least one wrong assumption.

---

### What the System Does Well

1. **`cleo briefing`** is genuinely useful — it surfaces the last handoff note, next task suggestions, and memory context in a single call. If the handoff note were richer, this would be the killer orientation command.

2. **`nexus-bridge.md`** is excellent — top entry points with file paths, cluster list, command reference table. A new agent reading this file can immediately start navigating the codebase intelligently.

3. **`memory-bridge.md` is auto-loaded via AGENTS.md** — this means every new agent session starts with recent decisions and learnings in context without any extra calls. The auto-refresh on `session end` and `tasks complete` is smart design.

4. **`cleo dash`** provides a useful at-a-glance health check — total tasks, blocked count, high-priority items, recent completions, top labels.

5. **`cleo memory find` + `_next.fetch` pointers** — the two-step search-then-fetch pattern is clean and prevents context bloat. The pointers make the next call obvious.

---

### What Is Broken or Missing

1. **Project name is "Unknown Project"** — fundamental first impression failure. Every agent starting fresh sees this. The project-info metadata is missing or not surfaced by `cleo dash`.

2. **`cleo nexus context <symbol>` is broken** — rejects symbol names, expects task IDs. This is the primary command for understanding code before editing. It does not work as documented in nexus-bridge.md.

3. **`cleo context pull T234` returned empty `relevantMemory`** — an epic with significant history surfaces no memory. The relevance matching is not working for this case.

4. **T234 has contradictory state** — `cancelledAt` is set but status is "pending." `cleo next` recommends it as the top task. A new agent will act on this without knowing it may be defunct.

5. **Pattern noise in memory** — 112 pattern nodes, many are "Recurring label X seen in N completed tasks" duplicates. These crowd out real patterns in memory search results.

6. **`nexus-bridge.md` is not auto-loaded** — it is the most useful orientation artifact but is not @-referenced in AGENTS.md the way memory-bridge.md is.

7. **`briefing` returns empty `recentDecisions`** even though `graph-stats` shows 3 decisions exist. The query is missing entries.

---

### Top 5 Improvements for "Just Knows" Experience

1. **Fix project identity**: Set `project` name in `project-info.json` and add a 1-sentence project description. Every `cleo dash` response should open with "Project: CLEO CLI — A task and memory management CLI for AI agent workflows."

2. **Fix `cleo nexus context <symbol>`**: Accept symbol names (not just task IDs). This is the #1 code navigation command. A new agent trying to look up a function before editing will hit a dead end right now.

3. **Auto-include nexus-bridge.md in AGENTS.md**: The memory bridge is already loaded. The nexus bridge should be too. These two files together give an agent 80% of what they need to start contributing.

4. **Add a contradiction check to `cleo next`**: If a recommended task has `cancelledAt` set, `verification.passed = false`, or conflicting state, surface a warning. "T234: recommended (score: 111) — NOTE: has cancelledAt set, verify this task is still active."

5. **Enrich `cleo briefing` handoff structure**: The note "T549 Waves 0-6 shipped as v2026.4.33. Starting JIT agent integration with Pi first-class support + CI fix." is a sentence. It should be structured: `{ done: [...], next: [...], decisions: [...], codeAreas: [...] }`. A new agent can orient in 1 call instead of 5.

---

### Can an Agent Be Productive Within 5 Tool Calls?

**Currently: No.**

The minimum viable orientation path is:

| Call # | Command | What it gives |
|--------|---------|---------------|
| 1 | `cleo briefing` | Last handoff + next tasks (but note is minimal) |
| 2 | `cleo show T514` | Full task details for a concrete next task |
| 3 | `cleo context pull T514` | Task context + memory (often empty) |
| 4 | `cat .cleo/nexus-bridge.md` | Codebase map and entry points |
| 5 | `cleo memory find "quality scoring"` | Specific topic research |

After 5 calls, an agent knows: what the last session did, which task to work on next, what that task requires, and the rough codebase architecture. But they do NOT know: why the project exists, whether the recommended task is safe to pick up, or what architectural decisions have been made.

**With the 5 improvements above, a productive state in 3 calls would be possible:**

| Call # | Command | What it would give |
|--------|---------|-------------------|
| 1 | `cleo briefing` | Structured handoff: done/next/decisions + nexus bridge auto-loaded |
| 2 | `cleo show <next task>` | Full task details with no contradictions flagged |
| 3 | `cleo nexus context <function>` | Callers + callees + execution flows for the function to edit |

The infrastructure is nearly there. The gaps are fixable.

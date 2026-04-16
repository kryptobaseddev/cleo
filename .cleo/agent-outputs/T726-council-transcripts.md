> SUPERSEDED — see `.cleo/agent-outputs/T726-council-synthesis.md` and `docs/specs/memory-architecture-spec.md`

# T726 — Memory Council Lead A: Transcript Lifecycle Audit + Design

**Lead**: Memory Council Lead A — Transcript Lifecycle Councilor
**Date**: 2026-04-15
**Status**: complete
**Epic**: T726 — Memory Architecture Reality Check + Long-Term Tier Wire-Up + Transcript Lifecycle

---

## 1. Executive Summary

Agent transcripts are stored as JSONL files under `~/.claude/projects/` with zero garbage collection, no size cap, and no extraction pipeline currently wired to consume subagent content. As of 2026-04-15 the cleocode project alone holds **754MB** of transcript data across **86 root sessions** and **964 subagent files**. Total across all 44 Claude Code projects: **3.5GB**. The LLM extraction pipeline (`llm-extraction.ts`) exists and is architecturally correct but is fed broken input — `getTranscript` reads the wrong directory level and returns null silently. This means the memory extraction chain that fires on `SessionEnd` has never successfully processed a transcript. This is a P0 bug with a two-line fix. The design below closes the full loop.

---

## 2. Current State Audit

### 2.1 Storage Layout

```
~/.claude/projects/
  -mnt-projects-cleocode/        ← project-slug dir (44 total across machine)
    <uuid>.jsonl                  ← ROOT-LEVEL: main session transcript (JSONL)
    <uuid>/                       ← SESSION DIR: created when subagents spawned
      subagents/
        agent-<agentId>.jsonl     ← subagent transcript (JSONL)
        agent-<agentId>.meta.json ← {"agentType":"...", "description":"..."}
      tool-results/
        <toolUseId>.json          ← raw tool result payloads
        <toolUseId>.txt
```

`~/.temp/claude-1000/` contains **symlinks only** — all 925 symlinks and 644 "files" there point back into `~/.claude/projects/`. `.temp` adds zero storage overhead; it is a Claude Code internal bookkeeping alias and can be ignored for GC purposes. Real storage is `~/.claude/projects/`.

### 2.2 JSONL Turn Schema

Every line in a session JSONL is one of these `type` values:

| type | frequency | value for extraction |
|------|-----------|---------------------|
| `user` | 352/990 turns | HIGH — contains prompts, task assignments, owner directives |
| `assistant` | 516/990 turns | HIGH — contains tool calls, reasoning, decisions |
| `system` | 46/990 | LOW — injected context (CLAUDE.md etc.) |
| `queue-operation` | 48/990 | MEDIUM — task create/update operations |
| `file-history-snapshot` | 23/990 | LOW — git state snapshots |
| `permission-mode` | 2/990 | NONE |
| `attachment` | 2/990 | CONTEXT — file attachments |
| `last-prompt` | 1/990 | NONE |

Key fields on each turn: `type`, `message.role`, `message.content[]`, `timestamp`, `sessionId`, `agentId`, `uuid` (turn ID), `parentUuid` (thread parent), `cwd`, `gitBranch`, `slug`.

Tool call distribution in one sampled 990-turn session:

| tool | count | extraction relevance |
|------|-------|---------------------|
| TaskUpdate | 79 | HIGH — shows what was completed/changed |
| Edit | 74 | HIGH — file modifications (what was built) |
| Bash | 64 | MEDIUM — commands run, build/test results |
| Agent | 29 | HIGH — subagent spawns with prompt (shows delegation) |
| Grep | 27 | LOW |
| Read | 25 | LOW |
| TaskCreate | 20 | HIGH — shows task decomposition decisions |
| Glob | 4 | NONE |

### 2.3 Volume Profile (cleocode project)

| metric | value |
|--------|-------|
| Root session JSONLs | 86 files |
| Root session size range | 1KB – 13.6MB |
| Root session average size | 3.1MB |
| Root session average turns | 1,263 |
| Root session max turns | 4,205 |
| Subagent JSONL files | 964 files |
| Subagent size range | 7KB – 3MB |
| Subagent average size | 328KB |
| Total root session storage | 259MB |
| Total subagent storage | 309MB |
| Tool-results storage | ~182MB (3.5MB avg × 51 dirs) |
| **Total cleocode transcripts** | **~750MB** |
| **Total all projects** | **3.5GB** |

### 2.4 Age Distribution (cleocode, 2026-04-15)

| age bucket | session count | notes |
|-----------|---------------|-------|
| < 1 day | 7 | Active/very recent |
| 1–7 days | 27 | Recent, still hot |
| 7–30 days | 52 | Oldest file: 27.6 days |
| > 30 days | 0 | None yet — but will accumulate |

No GC has ever run. All 86 sessions are under 28 days because the project is ~4 weeks old. The clock is ticking: at current velocity (3–7 sessions/day) the cleocode project will exceed **1GB within 2 weeks** and **5GB within 2 months** without intervention.

### 2.5 Who Reads Transcripts

**Currently wired but broken:**
- `packages/adapters/src/providers/claude-code/hooks.ts` → `getTranscript()` — called on every `SessionEnd` via `session-hooks.ts:handleSessionEnd()`
- `packages/core/src/memory/auto-extract.ts` → `extractFromTranscript()` — called by the above
- `packages/core/src/memory/llm-extraction.ts` → `extractFromTranscript()` — the actual Anthropic API call

**BUG (P0): `getTranscript` reads the wrong path level.**
The implementation at `hooks.ts:364` iterates `~/.claude/projects/<project-slug>/` subdirectories and looks for `*.jsonl` files inside UUID directories. But UUID directories contain only `subagents/` and `tool-results/` — no root JSONL. The root-level session JSONLs are siblings to the UUID directories, not inside them. Result: `getTranscript` always returns `null`. The LLM extraction pipeline has never received a transcript since it was built.

**Confirmed non-readers:**
- No cron job reads transcripts
- `cleo-sync.service` syncs `tasks.db` only — no transcript handling
- No grading/observer pipeline consumes raw transcripts (the `session-grade.ts` referenced in session-hooks operates on task data, not JSONL files)
- Agents get fresh context on spawn — no retry path reads prior transcripts
- `systemd-tmpfiles-clean.service` runs nightly but has no `.claude/projects` rule

**Shared transcript-reader (`packages/adapters/src/providers/shared/transcript-reader.ts`):**
- Used by Gemini CLI and Codex hooks only
- Reads "most recent file in a flat directory" — correct for those providers but not for Claude Code's nested layout

---

## 3. Lifecycle Design: Three-Tier Model

```
HOT (0–24h)           WARM (1–7d)             COLD (>7d)
─────────────────     ──────────────────      ─────────────────
Full JSONL retained   Pending extraction      Only brain.db
Agents can re-read    Scheduled by session    entries remain
No modification       end hook                JSONL deleted
                      LLM extracts →          Tombstone record
                      brain.db                in brain_observations
```

### 3.1 Hot Tier (0–24 hours)

**What lives here:** Full JSONL files exactly as written by Claude Code. Root session JSONL + subagent JSONLs + tool-results.

**Who reads it:** The session end hook's `getTranscript` call (once the P0 bug is fixed). In theory, retry/handoff agents could read hot transcripts for context — currently no code does this, but the path should remain open.

**Policy:** No modification. No extraction. No deletion. If a session is resumed within 24h, the transcript must be intact.

**Size concern:** 7 sessions × avg 3.5MB = ~25MB. Negligible.

### 3.2 Warm Tier (1–7 days)

**What lives here:** Session JSONLs scheduled for extraction. The `session.end` hook writes a `transcript_pending_extraction` record to `brain_observations`. Nightly GC processes these.

**Extraction target (what to pull from warm transcripts):**
1. **Decisions** — `Agent` tool calls where the prompt reveals architectural choices; assistant reasoning blocks that reach a decision
2. **File modifications** — `Edit` tool calls with filename and summary of change (not full diff — too large)
3. **Task completions** — `TaskUpdate` calls with status transitions to `done`
4. **Errors encountered** — bash commands with non-zero exits + the subsequent assistant recovery
5. **Learnings** — assistant text that uses "I learned", "the issue was", "this means", "we should"
6. **Owner directives** — user turns that contain "never", "always", "must", "do not" patterns

**What NOT to extract:** Raw tool inputs/outputs (too large, mostly noise), system prompt injections, file-history snapshots, permission events.

**Extraction method:** Existing `llm-extraction.ts` pipeline. The LLM receives a condensed transcript (user+assistant turns only, tool results summarized as one-liners) and returns typed `ExtractedMemory[]`. This is already built and tested — it just needs correct input.

**Post-extraction:** Delete root JSONL and subagent JSONLs. Retain `tool-results/` until cold transition (tool results are small and may be useful for debugging within the week). Write tombstone `brain_observations` entry with `type=transcript-extracted`, `source_session_id`, timestamp, and extraction count.

### 3.3 Cold Tier (>7 days)

**What lives here:** Only the extracted artifacts in `brain.db`. Raw JSONL gone. Tool-results directory deleted. The UUID session directory itself is removed.

**Recovery path:** Tombstone record in `brain_observations` contains the session ID and extraction summary. If the owner wants to reconstruct what happened, the brain.db entries tagged with `source_session_id=<uuid>` are the canonical record.

**Cross-council note for Lead B (Memory Tiers):** Extracted transcript memories enter the brain at the `short` tier. Promotion to `medium` and `long` follows the standard consolidation pipeline (T549 / `brain-lifecycle.ts`). This council does NOT define tier promotion logic — Lead B owns that.

---

## 4. Hard Caps and Circuit Breakers

| cap | threshold | action |
|-----|-----------|--------|
| Per-session directory | 100MB | Trigger immediate warm extraction (do not wait for 7d schedule) |
| Total `~/.claude/projects/` | 5GB | Emergency prune: extract all warm sessions NOW, delete cold immediately |
| API key absent | ANTHROPIC_API_KEY unset | Skip extraction; delete only sessions >30d (raw preservation fallback) |
| Extraction failure rate | >50% of batch | Abort prune; log error; do NOT delete un-extracted files |

---

## 5. Implementation Pieces

### 5.1 CLI Surface: `cleo transcript`

```
cleo transcript scan                     # inventory: counts, sizes, age buckets
cleo transcript scan --pending           # show sessions queued for extraction
cleo transcript extract <session-id>     # run extraction on one session now
cleo transcript extract --all-warm       # extract all sessions in warm tier
cleo transcript prune --older-than 7d    # dry-run by default
cleo transcript prune --older-than 7d --confirm  # destructive
cleo transcript migrate                  # one-time backfill of existing sessions
cleo transcript migrate --dry-run        # report only
```

**Task**: T728

### 5.2 Fix `getTranscript` (P0 Bug)

**Current (broken):**
```typescript
// Iterates UUID subdirs, looks for *.jsonl inside — finds none
const projectDirs = await readdir(projectsDir, { withFileTypes: true });
for (const entry of projectDirs) {
  if (!entry.isDirectory()) continue;  // UUID dir
  const subDir = join(projectsDir, entry.name);
  const files = await readdir(subDir);  // finds subagents/ and tool-results/ — no *.jsonl
```

**Fix (two-pass read):**
1. Read root-level `*.jsonl` files (these ARE the session transcripts)
2. Sort by mtime descending to find the most recent session
3. Also read `<uuid>/subagents/agent-*.jsonl` for the matching session UUID

**Task**: T729

### 5.3 LLM Extraction Pipeline (warm→cold)

New `TranscriptExtractor` service at `packages/core/src/memory/transcript-extractor.ts`:
- Input: session file path + session ID
- Condenses transcript to user+assistant turns (drops system/queue/snapshot turns)
- Calls existing `llm-extraction.ts` with condensed text
- Writes extracted memories with `source_session_id` + `transcript-warm-extract` tag
- Writes tombstone record
- Deletes JSONL files

**Cross-council dependency (Lead C):** Lead C owns the extraction algorithm internals. This service defines the trigger contract and tombstone protocol; Lead C's output feeds into the `llm-extraction.ts` call.

**Task**: T730

### 5.4 systemd Timer

New `cleo-transcript-gc.timer` + `cleo-transcript-gc.service`:
- Timer: `OnCalendar=*-*-* 02:00:00` (nightly 2am)
- Service: `ExecStart=cleo transcript prune --older-than 7d --confirm`
- Budget cap check: pre-service hook checks total size, triggers emergency prune if >5GB

Install script: `cleo pi setup-gc` (or `caamp pi install-transcript-gc`)

**Task**: T731

### 5.5 session.end Hook

New handler `handleSessionEndTranscriptSchedule` registered at priority 3 in `session-hooks.ts`:
- Writes `transcript_pending_extraction` to `brain_observations`
- Fields: `session_id`, `file_path` (root JSONL path), `subagent_count`, `created_at`
- Idempotent: upsert on `session_id`

**Task**: T732

### 5.6 Migration Command

`cleo transcript migrate` for one-time extraction of all existing 86 sessions:
- Iterates `~/.claude/projects/<project>/*.jsonl`
- Skips sessions with existing tombstone
- Processes oldest-first to maximize value before any manual deletion
- Reports: sessions processed, memories extracted, bytes freed

**Task**: T733

### 5.7 ADR + Tests

ADR covers: storage layout, tier definitions, extraction triggers, budget caps, cross-council interfaces.

Tests cover: hot/warm/cold classification, dry-run idempotency, tombstone dedup, budget cap trigger.

**Task**: T735

---

## 6. Decision Matrix for Owner

| # | Question | Proposed default | Alternative | Impact |
|---|----------|-----------------|-------------|--------|
| Q1 | Hot retention window | 24 hours | 48h (safer for multi-day sessions) | Longer = more disk; shorter = risk of losing context for interrupted sessions |
| Q2 | Warm retention window | 7 days | 3d (faster GC) or 14d (more cautious) | 7d balances recency vs disk budget |
| Q3 | What gets extracted | All 6 categories in §3.2 | Errors only (minimal) or full summary (broadest) | Full extraction produces richer brain.db but costs more API tokens; ~$0.01–0.05 per session |
| Q4 | Extraction API | Anthropic (Claude API via ANTHROPIC_API_KEY) | Local LLM via Ollama (free, lower quality) | Claude API gives better extraction quality; Ollama fallback means extraction works on air-gapped machines |
| Q5 | Pruning automation | Automatic (systemd timer, silent) | Owner-confirmed (interactive prompt before each GC run) | Auto is less friction; confirmed is safer during early rollout |
| Q6 | Subagent JSONL retention | Delete at same time as root JSONL | Keep subagents 7d longer than root (more granular) | Subagents are 309MB of the 750MB total; deleting them is high-impact |
| Q7 | tool-results retention | Delete at cold transition (7d) | Retain indefinitely (small, useful for debugging) | Tool results avg 3.5MB/dir × 51 dirs = ~182MB; low cost to keep |

**Owner flags:**
- **Q4** (local vs cloud extraction) needs decision before T730 is spawned — it changes the architecture of `transcript-extractor.ts`
- **Q5** (auto vs confirmed) needs decision before T731 timer is installed — safety implications

---

## 7. Cross-Council Dependencies

| dependency | this council | other council | interface |
|------------|-------------|--------------|-----------|
| Memory tier routing | Defines: extracted memories enter `short` tier | Lead B (Memory Tiers): defines promotion from short→medium→long | `ExtractedMemory` objects tagged `transcript-warm-extract` |
| Extraction algorithm | Defines: triggers, tombstone protocol, condensation pass | Lead C (Extraction Pipeline): defines LLM prompt, scoring thresholds, type classification | `extractFromTranscript({ projectRoot, sessionId, transcript })` contract in `llm-extraction.ts` |

---

## 8. Bug Summary

| ID | severity | location | description |
|----|----------|----------|-------------|
| B1 | P0 | `packages/adapters/src/providers/claude-code/hooks.ts:364` | `getTranscript` iterates UUID subdirs for *.jsonl but root-level session JSONLs are siblings to UUID dirs. Returns null always. LLM extraction has never received a transcript. Fix: read `projectSlugDir/*.jsonl` not `projectSlugDir/<uuid>/*.jsonl`. |
| B2 | P1 | Same file | `getTranscript` does not read subagent JSONLs from `<uuid>/subagents/agent-*.jsonl`. Subagent work (964 files, 309MB) is invisible to the extraction pipeline. |
| B3 | P1 | No code exists | No GC/prune mechanism. 3.5GB of transcripts with no rotation. At current velocity exceeds filesystem budget within 2 months. |

---

## 9. Child Tasks Created

| task | priority | size | title |
|------|----------|------|-------|
| T728 | high | medium | Implement cleo transcript scan / extract / prune CLI commands |
| T729 | critical | small | Fix getTranscript bug: reads UUID subdirs not root-level session JSONLs |
| T730 | high | medium | LLM extraction pipeline: warm-to-cold tier transition for agent transcripts |
| T731 | medium | small | systemd timer + budget cap circuit breaker for nightly transcript GC |
| T732 | high | small | session.end hook: schedule warm-tier extraction for completed session transcripts |
| T733 | high | medium | Migration: extract value from existing .temp/.claude/projects sessions before first GC run |
| T735 | medium | small | ADR + tests: transcript lifecycle policy (hot/warm/cold) and GC behavior |

---

## 10. Evidence Trail

| claim | evidence |
|-------|----------|
| Storage layout (symlinks) | `file ~/.temp/claude-1000/-mnt-projects-cleocode/b11c611c.../tasks/a136.output` → symlink to `~/.claude/projects/...` |
| 3.5GB total size | `du -sh ~/.claude/projects/` |
| 86 root sessions, 964 subagent files | `ls *.jsonl \| wc -l` + `find ... -name 'agent-*.jsonl' \| wc -l` |
| getTranscript bug | `hooks.ts:364-415` — iterates UUID dirs, none contain *.jsonl at that depth |
| LLM extraction pipeline exists | `packages/core/src/memory/llm-extraction.ts` + `auto-extract.ts` + `session-hooks.ts` |
| No GC exists | `systemctl --user list-timers` shows no transcript timer; `crontab -l` shows no prune job |
| Turn type distribution | Python analysis of `0181a645.jsonl` — 990 turns, tool call counts |
| Age distribution | `stat()` mtime on all 86 root JSONLs — oldest is 27.6 days |

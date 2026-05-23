---
name: ct-documentor
description: Documentation coordinator with CLEO style guide compliance. Routes every canonical-doc write (spec, adr, research, handoff, note, llm-readme) through the docs SSoT via `cleo docs add` / `cleo docs publish` / `cleo docs fetch` — never raw filesystem writes. Coordinates ct-docs-lookup, ct-docs-write, ct-docs-review, ct-spec-writer, and ct-adr-recorder. Use when creating or updating documentation files, consolidating scattered documentation, or validating documentation against style standards. Triggers on documentation tasks, doc update requests, or style guide compliance checks.
version: 3.3.0
tier: 3
core: false
category: specialist
protocol: null
dependencies:
  - ct-docs-lookup
  - ct-docs-write
  - ct-docs-review
  - ct-spec-writer
  - ct-adr-recorder
sharedResources:
  - subagent-protocol-base
  - task-system-integration
compatibility:
  - claude-code
  - cursor
  - windsurf
  - gemini-cli
license: MIT
---

# Documentation Specialist Context Injection

**Protocol**: @src/protocols/implementation.md
**Type**: Context Injection (cleo-subagent)
**Version**: 3.0.0

---

## Purpose

Context injection for documentation tasks spawned via cleo-subagent. Orchestrates documentation workflows by coordinating specialized skills for lookup, writing, and review.

---

## Skill Coordination

| Skill | Purpose | Invoke When |
|-------|---------|-------------|
| `ct-docs-lookup` | Query existing docs, find references via `cleo docs fetch`/`list` | Discovery phase, checking what exists |
| `ct-docs-write` | Create/edit docs via `cleo docs add` with CLEO style | Writing or updating content |
| `ct-docs-review` | Check compliance with style guide, read through `cleo docs fetch` | Quality validation before completion |
| `ct-spec-writer` | Author specs (REQ-XXX requirements) via `cleo docs add --type spec` | Formal specification work |
| `ct-adr-recorder` | Author ADRs via `cleo docs add --type adr --slug adr-NNN-...` | Architecture decisions promoted from consensus |

The coordinator never writes content itself — it routes the work to the
specialist skill that owns the doc type, and every specialist routes its
filesystem write through the docs SSoT (see "Coordinator Pattern" below).

---

## Coordinator Pattern: SSoT-First Routing

ct-documentor is a router. It dispatches each doc-type to its owning skill,
and every owner writes through `cleo docs add` — not raw filesystem writes.

| Doc Type | Owner Skill | SSoT Command |
|----------|-------------|--------------|
| `spec` (REQ-XXX requirements) | `ct-spec-writer` | `cleo docs add <ownerId> <path> --type spec --slug spec-<feature>` |
| `adr` (architecture decisions) | `ct-adr-recorder` | `cleo docs add <ownerId> <path> --type adr --slug adr-<NNN>-<rest>` |
| `research` (multi-source investigation) | `ct-research-agent` | `cleo docs add <ownerId> <path> --type research --slug research-<topic>` |
| `handoff` (session/agent transition) | `ct-documentor` (this skill) | `cleo docs add <ownerId> <path> --type handoff --slug handoff-<context>` |
| `note` (conversational prose) | `ct-docs-write` | `cleo docs add <ownerId> <path> --type note --slug <kebab-topic>` |
| `llm-readme` (agent-facing) | `ct-docs-write` | `cleo docs add <ownerId> <path> --type llm-readme --slug <kebab-topic>` |

Hard rule: EVERY canonical-type write goes through the SSoT. The coordinator
rejects any subagent return that wrote raw markdown into `.cleo/adrs/`,
`.cleo/research/`, `.cleo/agent-outputs/`, or `docs/` without first
materializing through `cleo docs add` + (optionally) `cleo docs publish`.

---

## Through SDK (preferred)

Documentation work flows through the docs SSoT in three steps —
add, publish, fetch. Use the slug-based contract so downstream consumers
can retrieve docs without grepping the filesystem.

### Add a doc attached to a task

```bash
cleo docs add T1234 docs/drafts/feature-x.md \
  --type note \
  --slug feature-x-overview \
  --desc "Conversational overview — pre-review"
```

- `--type` MUST be one of `spec | adr | research | handoff | note | llm-readme`.
  Pick the type by the document's purpose, not its filename.
- `--slug` is the human-friendly retrieval handle (kebab-case). If taken the
  CLI returns `E_SLUG_RESERVED` (legacy alias `E_SLUG_TAKEN`) with 3
  alternatives — pick one, do not overwrite.
- The owner ID (`T1234` above) auto-classifies the attachment by prefix:
  `T###` → task, `ses_*` → session, `O-*` → observation.

### Strict flag validation (T10359 · closes T10238)

`cleo docs add` rejects unknown flags with `E_UNKNOWN_FLAG` + Levenshtein
"did you mean" suggestions and exits with code `6` (`VALIDATION_ERROR`).
This closes the silent-absorption footgun where citty's underlying
`parseArgs({ strict: false })` accepted typo'd flags (e.g. `--titel`,
`--title`) as positional values.

```bash
# Typo → E_UNKNOWN_FLAG with suggestion
$ cleo docs add T123 file.md --titel "X"
{
  "success": false,
  "error": {
    "code": 6,
    "codeName": "E_UNKNOWN_FLAG",
    "message": "E_UNKNOWN_FLAG: unknown flag '--titel' for 'docs add'. Did you mean: --type, --slug?",
    "fix": "Try one of: --type, --slug. Run `cleo docs add --help` for the full flag list.",
    "alternatives": [{ "action": "--type", "command": "--type" }, { "action": "--slug", "command": "--slug" }],
    "details": { "flag": "--titel", "knownFlags": [...] }
  },
  "meta": { ... }
}
```

The accepted positional + named surface is enumerated in
`cleo docs add --help` — agents MUST consult `--help` rather than guessing
flag names. Use the `--flag=value` form (`--type=spec`) or
`--flag value` (`--type spec`) — both are recognised.

#### Slug allocation goes through ONE chokepoint (T10392 · Saga T10288)

Every code path that writes an attachment with a slug — `cleo docs add`,
`cleo changeset add`, and any future writer — MUST first call the central
allocator at `packages/core/src/docs/slug-allocator.ts:reserveSlug` BEFORE
invoking `attachmentStore.put({ slug })`. The allocator:

1. Normalises the slug to canonical kebab-case (lowercase, trim, single
   hyphens).
2. Acquires a per-slug in-process Mutex so concurrent reservations
   serialise.
3. Returns `{ ok: false, code: 'E_SLUG_RESERVED', suggestions }` when the
   slug is taken — uniform shape across both writers.

The `attachmentStore.put` chokepoint enforces this via a runtime assert
(`SlugNotReservedByAllocatorError`) when `CLEO_STRICT_SLUG_ALLOCATOR=1`
is set. Strict mode becomes default once `cleo changeset add` (T10388)
finishes wiring through the allocator. `cleo docs add` LIVE as of T10386:
the dispatch layer (`packages/cleo/src/dispatch/domains/docs.ts:add`)
calls `reserveSlug(type, slug)` BEFORE `attachmentStore.put`. Collisions
surface the uniform envelope:

```json
{
  "success": false,
  "error": {
    "code": "E_SLUG_RESERVED",
    "message": "slug 'foo' is already in use in this project",
    "details": {
      "suggestions": ["foo-2", "foo-3", "foo-4"],
      "aliases": ["E_SLUG_TAKEN"]
    }
  }
}
```

`details.aliases` retains the legacy `E_SLUG_TAKEN` code for ONE release of
back-compat — downstream consumers grepping for the old code can still match
via the alias array. Removed after T-E1.3 (T10388) lands `cleo changeset add`
on the same chokepoint.

Slugs share a GLOBAL namespace across all DocKinds — `reserveSlug('changeset',
'foo')` followed by `reserveSlug('research', 'foo')` collides (decision
T10390 / E1.5). Matches the `uniq_attachments_slug` partial UNIQUE INDEX in
migration `20260519000001`.

### Publish to a git-tracked path (when the doc must live on disk)

```bash
cleo docs publish --for T1234 --to docs/feature-x.md
```

Atomic tmp-then-rename. The published file ships in the next commit; the
SSoT blob remains canonical and continues to track future versions.

### Fetch the doc back by slug

```bash
cleo docs fetch feature-x-overview         # latest version
cleo docs versions --for T1234             # list every SHA version
```

Slug-based fetch is the contract used by reviewers, downstream skills, and
the docs graph — never grep the filesystem for the file you just wrote.

### List + sync

```bash
cleo docs list --type spec --project       # every spec in this project
cleo docs list --task T1234                # everything attached to a task
cleo docs sync --from docs/legacy.md --for T1234 --type note --slug legacy-doc
```

`cleo docs sync` back-fills an existing on-disk file into the SSoT.

---

## Deprecated: Direct filesystem

The legacy "write straight to `.cleo/adrs/`, `.cleo/research/`,
`.cleo/agent-outputs/`, or `docs/` and commit" pattern is deprecated.
The drift between the working file and the docs SSoT is real: published
files go stale, types are inferred ad-hoc from path, and slug-based
retrieval becomes impossible. Migrate every doc-type write to
`cleo docs add --type X --slug Y`.

---

## Core Principle: MAINTAIN, DON'T DUPLICATE

```
BEFORE creating ANY new file, you MUST:
1. Search for existing documentation on the topic
2. Identify the canonical location for this information
3. UPDATE the existing file instead of creating a new one
4. Only create new files when NO suitable location exists
```

---

## Workflow Phases

### Phase 1: Discovery (MANDATORY)

Before writing anything, discover what exists. Prefer the SSoT over `Glob`/`Grep`
when scanning canonical docs — `cleo docs list` returns slug + owner + type
without forcing a filesystem walk.

```bash
# SSoT-first discovery (preferred)
cleo docs list --project                       # all docs for this project
cleo docs list --type {TYPE} --project         # docs filtered by canonical type
cleo docs fetch {SUSPECTED_SLUG}               # check if a slug exists

# Filesystem fallback (only for un-migrated content)
Glob: pattern="docs/**/*.md"
Grep: pattern="{TOPIC_KEYWORDS}" path="docs/"
Grep: pattern="{RELATED_TERMS}" path="docs/" output_mode="files_with_matches"
```

**Invoke `/ct-docs-lookup`** for deeper documentation research.

### Phase 2: Assess

| Question | Action |
|----------|--------|
| Does a doc file for this topic exist? | UPDATE that file |
| Is the info scattered across files? | CONSOLIDATE into canonical location |
| Is there a related doc that should include this? | ADD section to that file |
| Is this truly new with no home? | CREATE minimal new file |

### Phase 3: Write/Update

**Invoke `/ct-docs-write`** for content creation.

**For EXISTING files:**
1. Read the current content
2. Identify the correct section for new info
3. Add/update content IN PLACE
4. Preserve existing structure
5. Update any version numbers or dates

**For CONSOLIDATION:**
1. Identify all files with related content
2. Choose the canonical location
3. Move content to canonical file
4. Add deprecation notices to old locations
5. Update cross-references

**For NEW files (last resort):**
1. Confirm no existing location is suitable
2. Follow project's doc structure conventions
3. Add to appropriate docs/ subdirectory
4. Update any index or TOC files
5. Keep minimal - single topic focus

### Phase 4: Review

**Invoke `/ct-docs-review`** for quality validation.

Checklist:
- [ ] No formal language ("utilize", "offerings", "cannot")
- [ ] "People/companies" not "users"
- [ ] No excessive exclamation points
- [ ] Important information leads, not buried
- [ ] No verbose text without value
- [ ] Headings state the point
- [ ] Descriptive link text (never "here")
- [ ] No "easy" or "simple"
- [ ] Code examples actually work

---

## Anti-Duplication Checklist

Before completing, verify:

- [ ] Searched for existing docs on this topic via `cleo docs list` first
- [ ] Did NOT create a file that duplicates existing content
- [ ] Updated existing file if one existed
- [ ] Added deprecation notice if consolidating
- [ ] Cross-references are updated
- [ ] No orphaned documentation created
- [ ] Every canonical-type write went through `cleo docs add --type X --slug Y`
- [ ] Slug retrieval verified via `cleo docs fetch <slug>` before declaring done

---

## Task System Integration

@skills/_shared/task-system-integration.md

### Task Workflow

```bash
# 1. Read task details
cleo show {TASK_ID}

# 2. Start task
cleo start {TASK_ID}

# 3. Execute documentation workflow (phases 1-4)

# 4. Complete task when done
cleo complete {TASK_ID}

# 5. Link research if applicable
cleo research link {TASK_ID} {RESEARCH_ID}
```

---

## Subagent Protocol

@skills/_shared/subagent-protocol-base.md

### Output Requirements

1. MUST write documentation output to: `{{OUTPUT_DIR}}/`
2. MUST append ONE line to: `{{MANIFEST_PATH}}`
3. MUST return ONLY: "Documentation complete. Manifest appended to pipeline_manifest."
4. MUST NOT return documentation content in response

### Output File Format

Write to `{{OUTPUT_DIR}}/`:

```markdown
# Documentation Update: {TITLE}

**Date**: {DATE} | **Agent**: ct-documentor | **Status**: complete

---

## Summary

{What was updated and why}

## Changes Made

### File: {path/to/file.md}
- {Change 1}
- {Change 2}

## Files NOT Created (Avoided Duplication)

- {Considered creating X but updated Y instead}
- {Found existing coverage in Z}

## Verification

- [ ] Changes don't duplicate existing content
- [ ] Cross-references updated
- [ ] Examples tested
- [ ] Style guide compliance verified via ct-docs-review
```

### Manifest Entry

Append ONE line to `{{MANIFEST_PATH}}`:

```json
{"id":"docs-{TOPIC}-{DATE}","file":"{DATE}_docs-{TOPIC}.md","title":"Documentation Update: {TITLE}","date":"{DATE}","status":"complete","agent_type":"documentation","topics":["documentation","{topic}"],"key_findings":["Updated {file} with {change}","Consolidated {topic} docs into {canonical-location}","Avoided duplication by updating existing {file}"],"actionable":false,"needs_followup":[],"linked_tasks":["{TASK_ID}"]}
```

---

## Completion Requirements

- [ ] Discovery phase completed (searched existing docs via `cleo docs list`)
- [ ] Core principle followed (maintain, don't duplicate)
- [ ] Coordinator pattern followed: every doc-type routed to its owning skill
- [ ] Every canonical-type write went through `cleo docs add --type X --slug Y`
- [ ] `/ct-docs-write` invoked for `note`/`llm-readme` content
- [ ] `/ct-spec-writer` invoked when writing specs (REQ-XXX requirements)
- [ ] `/ct-adr-recorder` invoked when promoting consensus → ADR
- [ ] `/ct-docs-review` invoked for quality validation
- [ ] Anti-duplication checklist verified
- [ ] Output file written with "Files NOT Created" section
- [ ] Manifest entry appended
- [ ] Task completed via `cleo complete`

---

## See references/

Progressive disclosure — load on demand only:

- `references/chain-orchestration.md` — when to invoke lookup/write/review, input shapes, review loop budget
- `references/doc-types-and-templates.md` — Diátaxis grid plus CLEO-native (ADR, agent-output, skill) templates
- `references/style-coordination.md` — tone pillars, forbidden phrases, link/code/table discipline
- `references/anti-patterns.md` — twelve documentation coordination failure modes

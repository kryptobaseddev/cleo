# CLEO Ecosystem Rules for Skill Compliance

This reference defines the rules a skill must meet to be valid within the CLEO ecosystem.
Used by the ecosystem-checker agent. Derived from CLEO-OPERATION-CONSTITUTION.md and CLEO-VISION.md.

---

## Rule 1: Domain Fit (REQUIRED)

The skill must serve or extend at least one of CLEO's **10 canonical domains**:

| Domain | Purpose |
|--------|---------|
| `tasks` | Task hierarchy, CRUD, dependencies, work tracking |
| `session` | Session lifecycle, decisions, assumptions, context |
| `memory` | Cognitive memory: observations, decisions, patterns, learnings (brain.db) |
| `check` | Schema validation, protocol compliance, test execution |
| `pipeline` | RCSD lifecycle stages, manifest ledger, release management |
| `orchestrate` | Multi-agent coordination, wave planning, parallel execution |
| `tools` | Skills, providers, issues, CAAMP catalog |
| `admin` | Configuration, backup, migration, diagnostics, ADRs |
| `nexus` | Cross-project coordination, registry, dependency graph |
| `sticky` | Ephemeral project-wide capture, quick notes |

**Fail condition**: Skill has no clear connection to any canonical domain.
**Warn condition**: Skill touches multiple domains without a clear primary domain.

---

## Rule 2: MCP Operation Syntax (REQUIRED if CLEO ops referenced)

Any CLEO MCP operations referenced in the skill body must use canonical format:

```
query { domain: "...", operation: "..." }
mutate { domain: "...", operation: "..." }
```

Or the abbreviated shorthand: `query tasks.show`, `mutate memory.observe`

**Invalid references**: Operations not listed in the CLEO-OPERATION-CONSTITUTION.md are errors.

**Common valid operations to recognize:**
- `query tasks.show`, `query tasks.find`, `query tasks.list`, `query tasks.next`
- `mutate tasks.add`, `mutate tasks.update`, `mutate tasks.complete`
- `query session.status`, `mutate session.start`, `mutate session.end`
- `query memory.find`, `query memory.timeline`, `query memory.fetch`, `mutate memory.observe`
- `query admin.dash`, `query admin.health`, `query admin.help`
- `query check.schema`, `mutate check.test.run`
- `query pipeline.stage.status`, `mutate pipeline.manifest.append`
- `query tools.skill.list`, `query tools.skill.show`
- `query orchestrate.status`, `mutate orchestrate.spawn`

**Fail condition**: Skill references a domain.operation that does not exist in the constitution.

---

## Rule 3: Canonical Verb Compliance (REQUIRED)

Skills must use canonical verbs when describing CLEO operations or commands:

**Approved verbs**: add, show, find, list, update, delete, archive, restore, complete,
start, stop, end, status, record, resume, suspend, reset, init, enable, disable, backup,
migrate, inject, run, link, observe, store, fetch, plan, sync, verify, validate, timeline,
convert, unlink

**Deprecated verbs** (must NOT appear when describing CLEO operations):
- `create` → use `add`
- `get` → use `show` or `fetch`
- `search` → use `find`
- `query` as a verb (e.g., "query the tasks") → use `find` or `list`

**Warn condition**: Skill uses deprecated verbs in its own instructions for CLEO operations.

---

## Rule 4: Non-Duplication (REQUIRED)

Skills must not re-implement functionality already provided by CLEO's MCP operations.

**Check**: If a skill's primary function is to do something CLEO can already do via a
single `query` or `mutate` call, that is duplication. Skills add value by composing
multiple operations, providing domain expertise, or automating multi-step workflows.

**Valid**: "Run 5 CLEO operations in sequence with business logic between them"
**Invalid**: "Calls `tasks.show` and returns the result" (already exists as `query tasks.show`)

**Fail condition**: Skill is a thin wrapper over a single existing CLEO operation with no added logic.

---

## Rule 5: Data Integrity (REQUIRED if touching .cleo/ data)

If the skill reads or writes `.cleo/` data stores:
- Reads must use `query` gateway
- Writes must use `mutate` gateway
- Direct file editing of `.cleo/*.json`, `tasks.db`, `brain.db` is NOT acceptable
- Skills must not bypass CLEO's atomic write requirements

**Fail condition**: Skill instructs direct editing of `.cleo/` data files.

---

## Rule 6: RCASD-IVTR+C Lifecycle Alignment (RECOMMENDED)

Skills that interact with project work should align with CLEO's lifecycle pipeline stages:

| Stage | Meaning |
|-------|---------|
| Research (R) | Gather information |
| Consensus (C) | Validate recommendations |
| Architecture Decision (A) | Document choices (ADRs) |
| Specification (S) | Formal requirements |
| Decomposition (D) | Break into tasks |
| Implementation (I) | Write code |
| Validation (V) | Verify implementation |
| Testing (T) | Test coverage |
| Release (R) | Ship with provenance |

**Warn condition**: Skill that touches pipeline/lifecycle operations doesn't reference the relevant stages.

---

## Rule 7: Purpose Clarity (REQUIRED)

The skill must have a **specific, bounded purpose** that is genuinely useful within CLEO workflows.

Questions to evaluate:
- What specific problem does this skill solve for a CLEO user?
- Is the scope clearly bounded or is it trying to do everything?
- Would a CLEO user know when to invoke this skill vs. using a different tool?
- Does the skill description (frontmatter) accurately convey its purpose and trigger conditions?

**Fail condition**: Skill purpose is vague, contradictory, or so broad it provides no focused value.
**Warn condition**: Skill scope is wider than needed for its stated purpose.

---

## Rule 8: Tools Alignment (RECOMMENDED)

The `allowed-tools` frontmatter should match the skill's actual needs:

| Skill type | Expected tools |
|-----------|----------------|
| Read-only CLEO data | `Bash` (for `cleo` CLI) or implicit MCP query |
| CLEO data modification | Includes write-capable tools |
| File system operations | `Read`, `Write`, `Edit`, `Glob`, `Grep` |
| Python scripts | `Bash(python *)` |
| Agent orchestration | No tools, or `Agent` |
| Validation/compliance | `Bash(python *)` for validators |

**Warn condition**: `allowed-tools` is overly broad (e.g., `Bash` with no restrictions for a read-only skill).

---

## Severity Levels

| Level | Meaning |
|-------|---------|
| `ERROR` | Hard failure — skill must be fixed before it is valid for CLEO ecosystem |
| `WARN` | Non-blocking issue — skill can still be used but should be addressed |
| `OK` | Passes this rule |
| `SKIP` | Rule not applicable to this skill type |

# Sticky Notes Architecture Specification

**Epic:** T5267  
**Status:** Design Complete  
**Date:** 2026-03-04  
**Domain:** sticky (10th canonical domain)

---

## 1. Concept

Sticky Notes are **project-wide, session-agnostic ephemeral captures** that fill the gap between:
- **Session Notes** (bound to specific sessions)
- **Tasks** (formal, structured work items)
- **BRAIN Observations** (distilled knowledge)

They map to CLEO's existing workshop vocabulary per [CLEO-SYSTEM-FLOW-ATLAS.md](../concepts/CLEO-SYSTEM-FLOW-ATLAS.md):

> **Sticky Notes** | sticky domain | Quick project-wide capture before formal classification

Sticky Notes are intentionally human-scale capture. They are not the live agent-to-agent relay path. Conduit owns live runtime delivery.

---

## 2. Domain Architecture

**STICKY IS THE 10TH DOMAIN** - Uses canonical domain slot:

```
10 Canonical Domains:
1. tasks
2. session
3. memory
4. check
5. pipeline
6. orchestrate
7. tools
8. admin
9. nexus (now includes sharing sub-operations)
10. sticky ← NEW
```

```
┌─────────────────────────────────────────────────────────────┐
│                    STICKY NOTES FLOW                         │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  sticky Domain                                              │
│  ├── sticky.add    → brain.db.brain_sticky_notes            │
│  ├── sticky.list   → query active notes                     │
│  ├── sticky.show   → get single note                        │
│  ├── sticky.convert → promote to task/memory                │
│  └── sticky.archive → soft delete                           │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 2.1 Naming and Canon

The naming for this domain is intentionally layered:

- **Protocol slug**: `sticky`
- **Artifact type**: Sticky Note
- **Circle of Ten house**: The Catchers
- **Human-facing surface label**: Capture Shelf or Sticky Notes

The stable contract is the slug `sticky`. The more formal surface language may evolve, but it MUST remain compatible with:

- `sticky.*` MCP operations
- `cleo sticky ...` CLI commands
- `brain_sticky_notes` storage naming

This means the canonical rule is:

- keep `sticky` as the protocol/domain slug
- keep Sticky Notes as the artifact type
- use The Catchers for the Circle of Ten house
- never confuse `sticky` with Conduit

If a future alias such as "capture" is introduced, it MUST be additive and MUST NOT break the `sticky` contract.

---

## 3. Database Schema

**Location:** `brain.db` (SQLite) - sticky domain owns `brain_sticky_notes` table

```sql
CREATE TABLE brain_sticky_notes (
  id TEXT PRIMARY KEY,           -- SN-001, SN-002...
  content TEXT NOT NULL,          -- Raw note text
  created_at TEXT NOT NULL,       -- ISO 8601 timestamp
  tags TEXT,                      -- JSON array ["bug", "idea"]
  status TEXT NOT NULL,           -- active | converted | archived
  converted_to TEXT,              -- JSON: {type: "task", id: "T123"}
  color TEXT,                     -- yellow | blue | green | red | purple
  priority TEXT,                  -- low | medium | high
  source_type TEXT                -- 'sticky-note' for BRAIN queries
);

-- Indexes for performance
CREATE INDEX idx_brain_sticky_status ON brain_sticky_notes(status);
CREATE INDEX idx_brain_sticky_created ON brain_sticky_notes(created_at);
CREATE INDEX idx_brain_sticky_tags ON brain_sticky_notes(tags);
```

---

## 4. Operations (sticky domain)

All operations use `sticky.*` namespace (canonical domain):

| Operation | Gateway | Tier | Description | CLI |
|-----------|---------|------|-------------|-----|
| `sticky.add` | mutate | 0 | Create sticky note | `cleo sticky add` |
| `sticky.list` | query | 0 | List active stickies | `cleo sticky list` |
| `sticky.show` | query | 0 | Get single sticky | `cleo sticky show` |
| `sticky.convert` | mutate | 1 | Promote to task/memory | `cleo sticky convert` |
| `sticky.archive` | mutate | 1 | Archive sticky | `cleo sticky archive` |

---

## 5. VERB-STANDARDS.md Updates

New section: **Sticky Note Operations** (Domain: sticky)

| Concept | Standard Verb | Usage | Example |
|---------|--------------|-------|---------|
| Create | `add` | Quick capture | `cleo sticky add "Refactor auth"` |
| List | `list` | Show all active | `cleo sticky list` |
| Read | `show` | Display single | `cleo sticky show SN-005` |
| Promote | `convert` | Transform to task/memory | `cleo sticky convert SN-005 --to-task` |
| Remove | `archive` | Soft delete | `cleo sticky archive SN-003` |

**CLI Examples:**
```bash
# Create
cleo sticky add "Check edge case in validation"
cleo sticky add "Bug: login fails" --tag bug --color red --priority high

# List
cleo sticky list
cleo sticky list --tag bug
cleo sticky list --color yellow

# Show
cleo sticky show SN-042

# Promote
cleo sticky convert SN-042 --to-task --title "Fix validation"
cleo sticky convert SN-042 --to-memory --type pattern

# Archive
cleo sticky archive SN-042
```

---

## 6. CLI Commands

**File:** `src/cli/commands/sticky.ts`

**Primary Commands:**
```bash
# Quick add (most common)
cleo sticky add "Check edge case in validation"
cleo sticky add "Bug in auth" --tag bug --color red --priority high

# List with filters
cleo sticky list
cleo sticky list --tag bug
cleo sticky list --color yellow
cleo sticky list --status active

# Show detail
cleo sticky show SN-042

# Promote to task
cleo sticky convert SN-042 --to-task --title "Fix edge case"

# Promote to memory
cleo sticky convert SN-042 --to-memory --type pattern

# Archive
cleo sticky archive SN-042
```

**NOTES:**
- NO 'cleo note' alias - use canonical 'cleo sticky'
- All commands route through sticky domain operations
- Supports --json and --human output flags

---

## 7. Skill: ct-stickynote

**Installation:**
```bash
cleo skill install library:ct-stickynote
```

**Skill Capabilities:**
- Quick-add with templates
- Visual board view (sorted by color/priority)
- Batch convert operations
- Auto-archive old stickies
- Weekly digest generation

**Uses sticky domain operations:**
- `sticky.add` for captures
- `sticky.list` for board view
- `sticky.convert` for promotions

---

## 8. Auto-Archive Behavior

- Stickies auto-archive after **30 days** if not converted
- Converted stickies marked `status='converted'`
- Archived stickies kept in brain.db for historical search
- Weekly notification: "You have 5 stickies older than 7 days"

---

## 9. Differences from Other Note Types

| Feature | Sticky Notes | Session Notes | Tasks | BRAIN Observations |
|---------|-------------|---------------|-------|-------------------|
| **Domain** | **sticky** | session | tasks | memory |
| **Scope** | Project-wide | Session-bound | Epic/task tree | Project-wide |
| **Lifetime** | 30 days → archive | Session lifetime | Until done | Permanent |
| **Structure** | Free text | Structured | Structured | Structured |
| **Searchable** | Yes | No | Yes | Yes (FTS5) |
| **Promotable** | → Task/Memory | No | N/A | N/A |
| **Binding** | None | Session ID | Epic/parent | Task links |
| **CLI** | `cleo sticky` | Session notes | `cleo add` | `cleo memory` |

---

## 10. Implementation Phases

| Phase | Task | Description | Status |
|-------|------|-------------|--------|
| 1 | T5268 | Database schema (brain.db brain_sticky_notes table) | Pending |
| 2 | T5269 | Core module (src/core/sticky/) | Pending |
| 3 | T5270 | Domain operations (sticky.* in registry) | Pending |
| 4 | T5271 | VERB-STANDARDS.md updates | Pending |
| 5 | T5272 | ct-stickynote skill | Pending |
| 6 | T5273 | CLI commands (cleo sticky) | Pending |
| 7 | T5274 | Test suite | Pending |
| 8 | T5275 | Documentation | Pending |

---

## 11. Files to Create/Modify

**New Files:**
- `src/store/brain-schema.ts` - Add brain_sticky_notes table
- `src/core/sticky/` - Core module (8 files)
  - types.ts, id.ts, create.ts, list.ts, show.ts, convert.ts, archive.ts, index.ts
- `src/dispatch/engines/sticky-engine.ts` - Engine layer
- `src/dispatch/domains/sticky.ts` - Domain handler
- `src/cli/commands/sticky.ts` - CLI implementation
- `packages/ct-skills/skills/ct-stickynote/` - Skill package
- `docs/features/STICKY-NOTES.md` - User guide
- `docs/specs/STICKY-NOTES-SPEC.md` - This spec

**Modified Files:**
- `src/dispatch/domains/index.ts` - Register sticky handler
- `src/dispatch/registry.ts` - Add 5 sticky operations
- `src/dispatch/types.ts` - 'sticky' in CANONICAL_DOMAINS
- `src/cli/index.ts` - Register sticky command
- `docs/specs/VERB-STANDARDS.md` - Add sticky verbs
- `docs/concepts/CLEO-SYSTEM-FLOW-ATLAS.md` - Update domain list

---

## 12. Canonical Compliance

✅ **10 domains maintained** - sticky replaces sharing slot  
✅ **Canonical domain** - sticky (not session.stickynote)  
✅ **Canonical CLI** - cleo sticky (not cleo note)  
✅ **Canonical verbs** - add, list, show, convert, archive  
✅ **Existing storage** - brain.db (sticky domain owns)  
✅ **CQRS pattern** - Query/mutate separation  
✅ **LAFS compliance** - Tiered progressive disclosure  
✅ **Atomic writes** - Temp → validate → backup → rename  
✅ **Anti-hallucination** - Unique SN-001 IDs, validation  

---

## 13. Key Decisions

1. **Domain: sticky** (not session.stickynote) - Clean domain ownership
2. **CLI: cleo sticky** (not cleo note) - Canonical naming
3. **10th domain slot** - Replaces sharing (merged into nexus)
4. **brain.db storage** - Sticky domain owns brain_sticky_notes table
5. **5 core operations** - add, list, show, convert, archive

---

**Next Steps:** Begin Phase 1 (T5268) - Database schema implementation.

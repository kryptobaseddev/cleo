# SG-CLEO-SKILLS Architecture v3 (canonical — supersedes v1 + v2)

**Saga:** T9560 — Skill System Maintenance + Optimization
**Updated:** 2026-05-18 — incorporates owner's path-namespace consolidation onto `~/.cleo/*`
**Supersedes:** `SG-CLEO-SKILLS-handoff-v2.md` (cleocode docs att_4b30bae5)

---

## 1. Canonical paths (LOCKED — do not re-litigate)

| Path | Role | Writer |
|------|------|--------|
| `packages/skills/skills/<name>/` | **Authoring SSoT** for Sphere A canonical skills (in cleocode git repo) | Cleocode contributors via PR |
| `~/.cleo/skills/<name>/` | **User-machine install root** for ALL skills (both spheres) | `cleo skills` CLI + sentient daemon (B only) |
| `~/.cleo/skills.db` | **Per-user registry** (Drizzle SQLite) — alongside `~/.cleo/tasks.db`, `~/.cleo/brain.db` | CLEO core |
| `~/.claude/skills/agents-shared/` | Claude Code discovery mount; symlinks INTO `~/.cleo/skills/<name>/` | `cleo skills doctor` |
| `~/.agents/skills` | **Single bridge symlink** → `~/.claude/skills/agents-shared` | `cleo skills doctor` |
| `<project>/.agents/skills/` | Project-local skills (per-project, in repo) | Project contributors |

**Discovery chain (Claude Code):** Claude resolves `~/.claude/skills/agents-shared/<name>` → symlink → `~/.cleo/skills/<name>/` (canonical) or to user-created `~/.cleo/skills/<name>/` (depending on `source_type` in db).

**Other harnesses** (Cursor, Aider, Codeium, etc.) resolve from `~/.agents/skills` (which is the bridge symlink). CLEO does NOT maintain per-harness symlinks.

**LEGACY paths** (must fall back gracefully during migration):
- `~/.local/share/agents/skills/` — old XDG canonical (handoff v2 model). Read-only fallback.
- `~/.agents/skills/` (as a real dir) — currently 88+ entries on owner machine. Must migrate + replace with bridge symlink.
- `~/.claude/skills/` direct entries (not under `agents-shared/`) — must be reconciled or removed.

`resolveSkillsRoot()` checks `~/.cleo/skills/` first, falls back to `~/.local/share/agents/skills/` with deprecation warning. `cleo skills doctor` performs one-shot migration with backup.

---

## 2. Two-sphere model (LOCKED)

### Sphere A — Canonical CLEO Skills (`ct-*` + bundled)

| Aspect | Value |
|--------|-------|
| **SSoT** | `packages/skills/skills/` (cleocode git repo) |
| **Install path** | `~/.cleo/skills/<name>/` |
| **`source_type` in db** | `canonical` |
| **Maintained by** | CLEO maintainers via PR ONLY |
| **User-machine state** | READ-ONLY; never auto-modified |
| **Improvement loop** | **OWNER-SIDE** GH Actions weekly council + grade → PR to cleocode |
| **Write-guard** | `is_canonical()` check refuses writes from sentient daemon |

### Sphere B — User-level skills (user-authored, community, agent-created)

| Aspect | Value |
|--------|-------|
| **SSoT** | User's `~/.cleo/skills/<name>/` (same dir as canonical, flagged by db) |
| **`source_type` in db** | `user` \| `community` \| `agent-created` |
| **Maintained by** | User + local sentient daemon (with provenance gating) |
| **Improvement loop** | **USER-SIDE** sentient daemon background review (Hermes-mirror) |
| **Telemetry** | Drizzle `~/.cleo/skills.db` (CLEO diverges from Hermes file sidecars) |
| **Lifecycle** | 30/90 day default (Hermes-standard) + per-project config override |

**Critical invariant:** local sentient daemon NEVER writes to canonical skills on user's machine. All canonical improvements flow via owner-CI PR to cleocode repo.

---

## 3. Saga structure (9 epics, 1 deleted, ship in 2 releases)

| # | Epic | Sphere | Wave | Release |
|---|------|--------|------|---------|
| T9571 | E-SKILLS-STORAGE-CLEANUP | A+B | W0 | v2026.5.82 |
| T9566 | E-SKILLS-IMMEDIATE | A | W0 | v2026.5.82 |
| T9567 | E-SKILLS-DEPTH-BACKFILL | A | W1 | v2026.5.82 |
| T9568 | E-SKILLS-LOOM-COVERAGE-AUDIT | A | W1 | v2026.5.82 |
| T9572 | E-SKILLS-OWNER-CI | A | W2 | v2026.5.82 |
| T9561 | E-SKILLS-TELEMETRY | B | W3 | v2026.5.83 |
| T9562 | E-SKILLS-CURATOR | B | W4 | v2026.5.83 |
| T9563 | E-SKILLS-AUTO-IMPROVE | B | W5 | v2026.5.83 |
| T9564 | E-SKILLS-FEDERATION-DISCOVERY | B | W5 | v2026.5.83 |
| ~T9565~ | ~E-SKILLS-DOGFOOD-LOOP~ | — | — | **archived** |

---

## 4. skills.db Drizzle schema (per-user at `~/.cleo/skills.db`)

```typescript
// packages/core/src/store/skills-schema.ts (NEW)

skills = sqliteTable("skills", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),            // e.g., "ct-orchestrator"
  version: text("version"),                          // semver from frontmatter
  sourceType: text("source_type", {
    enum: ["canonical", "user", "community", "agent-created"]
  }).notNull(),
  sourceUrl: text("source_url"),                     // github/marketplace; null for user
  installPath: text("install_path").notNull(),       // resolved path on disk
  canonicalPath: text("canonical_path"),             // XDG path (Sphere A) or null
  installedAt: text("installed_at").notNull(),
  lastUpdatedAt: text("last_updated_at"),
  lifecycleState: text("lifecycle_state", {
    enum: ["active", "stale", "archived"]
  }).default("active"),
  pinned: integer("pinned", { mode: "boolean" }).default(false),
  isAgentCreated: integer("is_agent_created", { mode: "boolean" }).default(false),
  archivedAt: text("archived_at"),
  archivedFromPath: text("archived_from_path"),
}, (t) => [
  index("idx_skills_state").on(t.lifecycleState),
  index("idx_skills_source").on(t.sourceType),
]);

skill_usage = sqliteTable("skill_usage", { /* per-event telemetry */ });
skill_reviews = sqliteTable("skill_reviews", { /* council + grade outcomes */ });
skill_patches = sqliteTable("skill_patches", { /* auto-improve diffs */ });
```

(Full schema in v2 handoff §4.)

---

## 5. Telemetry & opt-out (Sphere A → owner CI top-N council)

- **Anonymous telemetry** default-on in `cleo wizard` (T9572 acceptance criterion)
- **Single opt-out**: `cleo telemetry disable` (project-level + global)
- **Payload**: ONLY `{canonicalSkillName, loadCount, period}` — no user/session data
- **Sink**: phones home to owner-side ingestion endpoint OR scrubbed PR diff to cleocode repo (TBD in T9572)
- **Drives**: top-N selection for `skills-council.yml` weekly cron

---

## 6. is_canonical() resolution logic (LOCKED)

```typescript
function is_canonical(skillPath: string): boolean {
  const resolved = fs.realpathSync(skillPath);

  // 1. Check skills.db source_type === 'canonical'
  const dbRow = db.select().from(skills).where(eq(skills.installPath, resolved)).get();
  if (dbRow?.sourceType === "canonical") return true;

  // 2. Check manifest membership (packages/skills/manifest.json)
  const canonicalNames = readManifest().skills;
  if (canonicalNames.includes(path.basename(resolved))) return true;

  // 3. Fallback: path under legacy XDG canonical store
  if (resolved.startsWith(path.join(home, ".local/share/agents/skills/"))) return true;

  return false;
}
```

All Sphere B writes call `is_canonical(target)` first. If true → refuse with `E_CANONICAL_READ_ONLY`. The owner-CI workflow is the ONLY writer to canonical paths.

---

## 7. Anti-patterns (instant rejection)

- ❌ Auto-modifying canonical skills on user machine
- ❌ Same db row without `source_type` discriminator
- ❌ Shipping owner-CI workflows to users (live in cleocode repo only)
- ❌ File sidecars instead of `skills.db` (owner chose DB for queryability)
- ❌ Auto-archive without provenance check
- ❌ Squash-merge skill PRs (preserve task↔commit traceability per ADR-062)
- ❌ Writing canonical skills to `~/.cleo/skills/` directly on a non-owner-CI machine

---

## 8. Files to read first (for fresh sessions / agents)

1. **This file** (`.cleo/research/SG-CLEO-SKILLS-architecture-v3.md`)
2. `cleo saga members T9560`
3. `packages/core/src/sentient/daemon.ts` (existing CLEO daemon to extend, NOT replace)
4. `packages/caamp/src/commands/skills/install.ts` (CAAMP install flow)
5. `.github/workflows/freshness-sentinel.yml` (cron pattern to mirror for owner CI)
6. `/mnt/projects/hermes-agent/tools/skill_manager_tool.py` lines 730–790 (create flow + provenance gate)
7. `/mnt/projects/hermes-agent/tools/skill_usage.py` (full — `.usage.json` schema CLEO is converting to DB)
8. `/mnt/projects/hermes-agent/agent/curator.py` lines 256–296 (automatic transitions)
9. `/mnt/projects/hermes-agent/run_agent.py` lines 3981 (review prompt) + 4216 (spawn fork)

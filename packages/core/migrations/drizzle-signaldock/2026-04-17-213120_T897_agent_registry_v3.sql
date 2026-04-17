-- T889 / T897: agent_registry v3 — add tier, canSpawn, cantPath, checksum, orch fields.
--
-- Additive ALTER TABLE statements extending the pre-T310 agents/agent_skills
-- tables with the tier-aware resolution metadata required by the T889 spawn
-- pipeline. The embedded migration runner in packages/core/src/store/
-- signaldock-sqlite.ts owns idempotency (via _signaldock_migrations + a
-- PRAGMA table_info() pre-check helper) because SQLite does NOT support the
-- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` syntax.
--
-- All columns have safe NOT NULL defaults so the migration is additive for
-- existing rows. CHECK constraints enforce the taxonomies declared in
-- packages/contracts/src/agent-registry-v3.ts.
--
-- See: ADR-037 (signaldock/conduit split), ADR-044 (canon), T889 epic spec.

-- ---------------------------------------------------------------------------
-- agents: extended tier / spawn / cant provenance columns
-- ---------------------------------------------------------------------------

ALTER TABLE agents ADD COLUMN tier TEXT NOT NULL DEFAULT 'global'
    CHECK (tier IN ('project','global','packaged','fallback'));

ALTER TABLE agents ADD COLUMN can_spawn INTEGER NOT NULL DEFAULT 0
    CHECK (can_spawn IN (0,1));

ALTER TABLE agents ADD COLUMN orch_level INTEGER NOT NULL DEFAULT 2
    CHECK (orch_level BETWEEN 0 AND 2);

ALTER TABLE agents ADD COLUMN reports_to TEXT;

ALTER TABLE agents ADD COLUMN cant_path TEXT;

ALTER TABLE agents ADD COLUMN cant_sha256 TEXT;

ALTER TABLE agents ADD COLUMN installed_from TEXT
    CHECK (installed_from IN ('seed','user','manual') OR installed_from IS NULL);

ALTER TABLE agents ADD COLUMN installed_at TEXT;

-- ---------------------------------------------------------------------------
-- agent_skills: source + attachment timestamp
-- ---------------------------------------------------------------------------

ALTER TABLE agent_skills ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('cant','manual','computed'));

ALTER TABLE agent_skills ADD COLUMN attached_at TEXT NOT NULL
    DEFAULT (datetime('now'));

-- ---------------------------------------------------------------------------
-- Indexes (IF NOT EXISTS — safe under idempotent re-application)
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_agents_tier ON agents(tier);
CREATE INDEX IF NOT EXISTS idx_agents_cant_path ON agents(cant_path);
CREATE INDEX IF NOT EXISTS idx_agent_skills_source ON agent_skills(source);

-- T1826 Decision Storage Consolidation: Extend brain_decisions with ADR tracking + governance columns
--
-- Additive migration — no columns are dropped or renamed.  All new columns are
-- nullable or carry safe DEFAULT values so that SQLite's ALTER TABLE ADD COLUMN
-- can run without a full-table rewrite and without touching existing rows.
--
-- Backfill strategy:
--   After the schema changes are applied, existing rows are updated in-place:
--     - confirmationState = 'accepted'  (they were implicitly accepted)
--     - decidedBy         = 'agent'     (agent-inferred; safe default)
--   adrNumber, adrPath, supersedes, supersededBy, validatorRunAt remain NULL
--   for all pre-existing rows (no ADR tracking was in place).
--
-- DEPENDS ON: initial brain_decisions table (present since T521 baseline)
-- SAFE FOR:   SQLite 3.35+ (ALTER TABLE ADD COLUMN with DEFAULT is atomic)

-- 1. ADR sequence number (unique across all assigned decisions; app-level MAX+1 sequence)
ALTER TABLE brain_decisions ADD COLUMN adr_number INTEGER;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_brain_decisions_adr_number
  ON brain_decisions(adr_number)
  WHERE adr_number IS NOT NULL;
--> statement-breakpoint
-- 2. Path to the ADR document on disk (nullable)
ALTER TABLE brain_decisions ADD COLUMN adr_path TEXT;
--> statement-breakpoint
-- 3. Self-referential supersession pointers (nullable FK to brain_decisions.id)
ALTER TABLE brain_decisions ADD COLUMN supersedes TEXT REFERENCES brain_decisions(id);
--> statement-breakpoint
ALTER TABLE brain_decisions ADD COLUMN superseded_by TEXT REFERENCES brain_decisions(id);
--> statement-breakpoint
-- 4. Confirmation state enum with a safe default for new rows
--    Existing rows are backfilled to 'accepted' in the UPDATE below.
ALTER TABLE brain_decisions ADD COLUMN confirmation_state TEXT NOT NULL DEFAULT 'proposed';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_brain_decisions_confirmation_state
  ON brain_decisions(confirmation_state);
--> statement-breakpoint
-- 5. Who decided / approved (enum; defaults to 'agent')
ALTER TABLE brain_decisions ADD COLUMN decided_by TEXT NOT NULL DEFAULT 'agent';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_brain_decisions_decided_by
  ON brain_decisions(decided_by);
--> statement-breakpoint
-- 6. LLM validator timestamp (epoch ms; nullable)
ALTER TABLE brain_decisions ADD COLUMN validator_run_at INTEGER;
--> statement-breakpoint
-- Backfill existing rows: mark them as accepted agent-decisions
-- (they were already active before governance was introduced)
UPDATE brain_decisions
SET
  confirmation_state = 'accepted',
  decided_by         = 'agent'
WHERE confirmation_state = 'proposed';

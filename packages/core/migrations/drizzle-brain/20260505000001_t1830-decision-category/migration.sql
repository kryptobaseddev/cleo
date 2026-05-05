-- T1830 Separate AGT-* dispatch outcomes from architectural decisions in brain_decisions.
--
-- Adds decision_category TEXT column with a NOT NULL DEFAULT of 'architectural'.
-- Backfills existing AGT-* rows to 'agent_dispatch'.
--
-- Additive migration — no columns are dropped or renamed. All new columns carry
-- safe DEFAULT values so that SQLite's ALTER TABLE ADD COLUMN runs without a
-- full-table rewrite and without touching unrelated rows.
--
-- Valid values: 'architectural' | 'agent_dispatch' | 'other'
-- The CHECK constraint is enforced at the application layer (Drizzle enum column);
-- see brain_decisions.decisionCategory in memory-schema.ts.
--
-- DEPENDS ON: initial brain_decisions table (present since T521 baseline)
-- SAFE FOR:   SQLite 3.35+ (ALTER TABLE ADD COLUMN with DEFAULT is atomic)

ALTER TABLE brain_decisions ADD COLUMN decision_category TEXT NOT NULL DEFAULT 'architectural';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_brain_decisions_decision_category
  ON brain_decisions(decision_category);
--> statement-breakpoint
-- Backfill: AGT-prefixed rows are agent dispatch outcomes, not architectural decisions
UPDATE brain_decisions SET decision_category='agent_dispatch' WHERE id LIKE 'AGT-%';

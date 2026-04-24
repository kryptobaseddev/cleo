-- T1260 PSYCHE E3: Add provenance_class to all 4 brain memory tables
--
-- Context: M6 refusal gate from T-COUNCIL-RECONCILIATION-2026-04-24 Chairman verdict.
-- buildRetrievalBundle must emit provenanceClass on every returned entry AND refuse
-- entries with provenanceClass='unswept-pre-T1151' to prevent Sentient v1 reading
-- unswept legacy memory.
--
-- provenance_class  TEXT DEFAULT 'unswept-pre-T1151'
--   - 'unswept-pre-T1151' — default for all legacy rows; refused by buildRetrievalBundle
--     until the T1147 W7 sweep (.132) stamps entries as 'swept-clean'.
--   - 'swept-clean'       — row has passed the T1147 reconciler sweep.
--   - 'deriver-synthesized' — row was created by the T1145 deriver (W5).
--   - 'owner-verified'    — row was manually promoted via `cleo memory verify`.
--
-- NULL semantics: NULL is treated as 'unswept-pre-T1151' at query time in
-- buildRetrievalBundle (same convention as peer_id NULL → 'global').
--
-- NOTE (Risk 5): With default 'unswept-pre-T1151', M6 refusal will empty all warm/hot
-- bundles for existing BRAIN data until T1147 W7 (.132) runs the sweep. This is correct
-- per Council (prevents Sentient v1 reading unswept data). buildRetrievalBundle logs
-- refusedCount as a warning so callers can detect this state. Callers MUST NOT crash
-- on empty bundle.
--
-- Staged backfill: existing rows receive 'unswept-pre-T1151' via the DEFAULT
-- constraint — no explicit UPDATE required. The T1147 W7 sweep updates values.
--
-- Reversibility: additive nullable + DEFAULT columns. Droppable in SQLite 3.35+.

-- brain_decisions
ALTER TABLE brain_decisions ADD COLUMN provenance_class TEXT DEFAULT 'unswept-pre-T1151';

-- brain_patterns
ALTER TABLE brain_patterns ADD COLUMN provenance_class TEXT DEFAULT 'unswept-pre-T1151';

-- brain_learnings
ALTER TABLE brain_learnings ADD COLUMN provenance_class TEXT DEFAULT 'unswept-pre-T1151';

-- brain_observations
ALTER TABLE brain_observations ADD COLUMN provenance_class TEXT DEFAULT 'unswept-pre-T1151';

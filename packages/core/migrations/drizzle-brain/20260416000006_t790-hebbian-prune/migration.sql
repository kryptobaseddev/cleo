-- T790 BRAIN-01: Prune Hebbian co_retrieved noise edges
--
-- Context (T764 audit): 6,026 `co_retrieved` edges were emitted by the
-- Hebbian strengthener because it counted raw log row co-occurrences rather
-- than distinct query strings. With limit>=5 per query, N*(N-1)/2 pairs were
-- generated per retrieval call, and the count>=3 threshold was hit after just
-- 3 runs of any search that returned overlapping results.
--
-- Fix applied in brain-lifecycle.ts (T790): `strengthenCoRetrievedEdges` now
-- tracks distinct query strings per pair (Map<key, Set<query>>) and requires
-- >= 3 DIFFERENT query strings before emitting an edge. Repeated searches no
-- longer inflate the count.
--
-- This migration prunes the existing noise. The owner decision rule is:
--   - Preserve strong signals:  weight >= 0.3  (0.3 = original insert weight,
--                               meaning at least one real consolidation touch)
--   - Delete obvious noise:     weight < 0.3   (fractional leftovers, never
--                               received a full consolidation cycle)
--   - Delete all edges created before this fix date (2026-04-16) because none
--     of them passed the distinct-query gate — they were all created under the
--     broken raw-count path.
--
-- Reversibility: the DELETE only removes `co_retrieved` edges with
-- plasticity_class IN ('hebbian', 'static') and weight < 0.3. STDP-upgraded
-- edges (plasticity_class='stdp') are PRESERVED regardless of weight, as STDP
-- applies its own timing window and is considered higher-signal.
-- This migration is no-op-safe: if no matching rows exist, the DELETE is a
-- no-op with zero changes.

-- ============================================================
-- Step 1: Delete low-weight hebbian co_retrieved noise edges
-- ============================================================

DELETE FROM brain_page_edges
WHERE edge_type = 'co_retrieved'
  AND plasticity_class IN ('hebbian', 'static')
  AND weight < 0.3;
--> statement-breakpoint

-- ============================================================
-- Step 2: Delete all co_retrieved edges created before the
-- T790 fix date, EXCEPT those upgraded to 'stdp' class
-- (STDP-upgraded edges carried timing signal, keep them).
-- ============================================================

DELETE FROM brain_page_edges
WHERE edge_type = 'co_retrieved'
  AND plasticity_class IN ('hebbian', 'static')
  AND created_at < '2026-04-16 00:00:00';
--> statement-breakpoint

-- ============================================================
-- Step 3: Index guard — ensure edge lookup is efficient
-- (idempotent CREATE IF NOT EXISTS)
-- ============================================================

CREATE INDEX IF NOT EXISTS `idx_brain_page_edges_type_plasticity`
  ON `brain_page_edges` (`edge_type`, `plasticity_class`);

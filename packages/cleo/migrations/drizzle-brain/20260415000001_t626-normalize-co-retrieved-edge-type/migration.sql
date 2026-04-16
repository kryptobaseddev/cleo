-- T626-M1: Normalize co_retrieved edge type
--
-- The shipped Hebbian strengthener (brain-lifecycle.ts:strengthenCoRetrievedEdges)
-- was emitting edge_type = 'relates_to' instead of 'co_retrieved'. This migration
-- relabels all existing rows that were created by that code path.
--
-- Safety: the WHERE clause constrains to rows whose provenance starts with
-- 'consolidation:' so only Hebbian edges are touched; no semantic edges are
-- affected. co_retrieved is already in BRAIN_EDGE_TYPES so Drizzle accepts it.

UPDATE `brain_page_edges`
SET edge_type = 'co_retrieved'
WHERE edge_type = 'relates_to'
  AND provenance LIKE 'consolidation:%';

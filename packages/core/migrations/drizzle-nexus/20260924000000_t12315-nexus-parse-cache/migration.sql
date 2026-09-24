-- T12315: per-file extraction memo for exact incremental code-graph indexing.
--
-- Cross-file resolution needs every file's extraction (raw call sites, access
-- sites, re-export records, import bindings), most of which is never stored in
-- `nexus_nodes` / `nexus_relations`. Rather than approximate those facts from
-- published rows, the pipeline persists each file's extraction here, keyed by
-- path and valid only for the exact bytes (`content_hash`) and extractor build
-- (`fingerprint`) that produced it. `generation` names the publication
-- generation embedded in the payload's anonymous identities so reuse can
-- rebind it. Rows are replaced in the same transaction as the graph they
-- describe (`publishNexusGraph`), so the cache never outlives or precedes its
-- generation.
--
-- Underscore-prefixed like `_nexus_meta`: pipeline bookkeeping, not graph data.
CREATE TABLE IF NOT EXISTS _nexus_parse_cache (
	path TEXT PRIMARY KEY NOT NULL,
	content_hash TEXT NOT NULL,
	fingerprint TEXT NOT NULL,
	generation TEXT NOT NULL,
	payload BLOB NOT NULL
);

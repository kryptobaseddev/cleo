/**
 * anomaly-seed.mjs — Populates a DatabaseSync with deliberately anomalous
 * graph data for the sentient-anomaly-proof scenario.
 *
 * Anomalies injected:
 *   A. Orphaned callee  — "orphanedSink" has 6 callers but makes zero calls.
 *      Triggers Query A (base weight 0.3).
 *
 *   B. Over-coupled node — "megaHub" has 25 total edges (>20 threshold).
 *      Triggers Query B (base weight 0.3).
 *
 *   C. Community fragmentation — community "comm:alpha" had 10 symbols, now
 *      has 7 (30% drop > 20% threshold). Weight = 0.4.
 *
 *   D. Entry-point erosion — process "deadProcess" points to unexported
 *      function "hiddenEntry". Weight = 0.5.
 *
 *   E. Cross-community coupling spike — "bridgeNode" has degree > 30 and
 *      > 15 cross-community edges. Weight = 0.35.
 *
 * Unrelated symbols with no anomalies are also seeded to verify zero-false-
 * positive behavior: "cleanFunc" and "normalHub" (degree 5, not anomalous).
 *
 * @task T1112
 */

/**
 * Create minimal nexus tables in the provided DatabaseSync.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function createNexusTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nexus_nodes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      file_path TEXT NOT NULL DEFAULT 'src/unknown.ts',
      kind TEXT NOT NULL DEFAULT 'function',
      label TEXT NOT NULL DEFAULT 'unknown',
      is_exported INTEGER NOT NULL DEFAULT 0,
      community_id TEXT DEFAULT NULL
    );
    CREATE TABLE IF NOT EXISTS nexus_relations (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'calls',
      type TEXT NOT NULL DEFAULT 'calls'
    );
    CREATE TABLE IF NOT EXISTS nexus_schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS nexus_audit_log (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      action TEXT NOT NULL,
      details_json TEXT DEFAULT '{}'
    );
  `);
}

let _relCounter = 0;

/**
 * Insert a node into nexus_nodes.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} id
 * @param {string} name
 * @param {string} [kind]
 * @param {string|null} [communityId]
 * @param {boolean} [isExported]
 */
export function insertNode(db, id, name, kind = 'function', communityId = null, isExported = false) {
  db.prepare(
    `INSERT OR IGNORE INTO nexus_nodes (id, name, file_path, kind, label, community_id, is_exported)
     VALUES (:id, :name, :filePath, :kind, :label, :communityId, :isExported)`,
  ).run({
    id,
    name,
    filePath: `src/${name}.ts`,
    kind,
    label: name,
    communityId,
    isExported: isExported ? 1 : 0,
  });
}

/**
 * Insert a relation into nexus_relations.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sourceId
 * @param {string} targetId
 * @param {string} [type]
 */
export function insertRelation(db, sourceId, targetId, type = 'calls') {
  const id = `R${++_relCounter}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  db.prepare(
    `INSERT OR IGNORE INTO nexus_relations (id, source_id, target_id, kind, type)
     VALUES (:id, :sourceId, :targetId, :type, :type2)`,
  ).run({ id, sourceId, targetId, type, type2: type });
}

/**
 * Seed the database with all five anomaly types plus unrelated clean symbols.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function seedAnomalies(db) {
  // ---- Anomaly A: orphaned callee (id=ORPHAN_SINK) ----
  // Function "orphanedSink" is called by 6 callers but calls nothing.
  // Triggers Query A (caller_count > 5).
  insertNode(db, 'ORPHAN_SINK', 'orphanedSink', 'function', 'comm:beta', false);
  for (let i = 1; i <= 6; i++) {
    insertNode(db, `CALLER_A${i}`, `callerOfSink${i}`, 'function', 'comm:beta', false);
    insertRelation(db, `CALLER_A${i}`, 'ORPHAN_SINK', 'calls');
  }

  // ---- Anomaly B: over-coupled node (id=MEGA_HUB) ----
  // Function "megaHub" has 45 outbound relations (degree > 20).
  // Degree 45 ensures it ranks #1 in Query B (ORDER BY degree DESC LIMIT 5),
  // above the 4 decoy hubs (each degree 40) that are used to crowd out BRIDGE_NODE
  // from Query B's window. See Anomaly E comment below for full explanation.
  insertNode(db, 'MEGA_HUB', 'megaHub', 'function', 'comm:gamma', false);
  for (let i = 1; i <= 45; i++) {
    insertNode(db, `HUB_TARGET${i}`, `hubTarget${i}`, 'function', 'comm:gamma', false);
    insertRelation(db, 'MEGA_HUB', `HUB_TARGET${i}`, 'calls');
  }

  // ---- Anomaly C: community fragmentation (community: comm:alpha) ----
  // Old snapshot has 10 symbols; current state has 7 → 30% drop > 20%.
  // Triggers Query C with weight 0.4.
  db.prepare(
    `INSERT OR REPLACE INTO nexus_schema_meta (key, value)
     VALUES ('community_snapshot_json', :value)`,
  ).run({ value: JSON.stringify({ 'comm:alpha': 10 }) });
  for (let i = 1; i <= 7; i++) {
    insertNode(db, `FRAG_SYM${i}`, `fragSym${i}`, 'function', 'comm:alpha', false);
  }

  // ---- Anomaly D: entry-point erosion (process: DEAD_PROC) ----
  // Process "deadProcess" points to unexported function "hiddenEntry".
  // Triggers Query D with weight 0.5.
  insertNode(db, 'DEAD_PROC', 'deadProcess', 'process', null, false);
  insertNode(db, 'HIDDEN_ENTRY', 'hiddenEntry', 'function', null, false); // NOT exported
  insertRelation(db, 'HIDDEN_ENTRY', 'DEAD_PROC', 'entry_point_of');

  // ---- Anomaly E: cross-community coupling spike (id=BRIDGE_NODE) ----
  // "bridgeNode" has 32 total edges and >15 cross-community edges → Query E.
  //
  // IMPORTANT: Query B (over-coupling, degree > 20) fires BEFORE Query E in the
  // ingester, and candidates are deduplicated by node id. To ensure BRIDGE_NODE
  // is detected by Query E (weight 0.35) and NOT consumed by Query B (weight 0.3),
  // we seed 5 "decoy" super-hubs (each with 40 edges) to saturate Query B's
  // LIMIT=5 window. BRIDGE_NODE (degree 32) ranks below the decoys and is
  // skipped by Query B, then caught by Query E.
  //
  // Decoys are pure same-community, so they don't trigger Query E themselves.

  // 4 decoy super-hubs for Query B (degree 40 each).
  // These fill Query B's LIMIT=5 slots [2..5] after MEGA_HUB (degree 45) takes
  // slot [1]. BRIDGE_NODE (degree 32) thus ranks 6th or lower and is NOT
  // consumed by Query B's deduplication window — leaving it available for
  // Query E (cross-community coupling spike).
  for (let d = 1; d <= 4; d++) {
    insertNode(db, `DECOY_HUB${d}`, `decoyHub${d}`, 'function', 'comm:decoy', false);
    for (let t = 1; t <= 40; t++) {
      insertNode(db, `DEC_T${d}_${t}`, `decoyTarget${d}_${t}`, 'function', 'comm:decoy', false);
      insertRelation(db, `DECOY_HUB${d}`, `DEC_T${d}_${t}`, 'calls');
    }
  }

  // BRIDGE_NODE: 17 cross-community + 15 same-community = 32 total degree
  // Degree > 30 (NEXUS_MIN_CROSS_COUPLING_DEGREE) and > 15 cross edges
  insertNode(db, 'BRIDGE_NODE', 'bridgeNode', 'function', 'comm:delta', false);
  // 17 cross-community edges to comm:epsilon (> 15 threshold)
  for (let i = 1; i <= 17; i++) {
    insertNode(db, `CROSS_EP${i}`, `crossEpsilon${i}`, 'function', 'comm:epsilon', false);
    insertRelation(db, 'BRIDGE_NODE', `CROSS_EP${i}`, 'calls');
  }
  // 15 same-community edges to push total degree to 32 (> 30 threshold)
  for (let i = 1; i <= 15; i++) {
    insertNode(db, `SAME_DEL${i}`, `sameDelta${i}`, 'function', 'comm:delta', false);
    insertRelation(db, 'BRIDGE_NODE', `SAME_DEL${i}`, 'calls');
  }

  // ---- Clean (unrelated) symbols — zero-false-positive control ----
  // "cleanFunc" — only 1 caller, no anomalies
  insertNode(db, 'CLEAN_FUNC', 'cleanFunc', 'function', 'comm:clean', true);
  insertNode(db, 'CLEAN_CALLER', 'cleanCaller', 'function', 'comm:clean', true);
  insertRelation(db, 'CLEAN_CALLER', 'CLEAN_FUNC', 'calls');

  // "normalHub" — 5 edges total, well below over-coupling threshold
  insertNode(db, 'NORMAL_HUB', 'normalHub', 'function', 'comm:clean', true);
  for (let i = 1; i <= 5; i++) {
    insertNode(db, `NH_TARGET${i}`, `normalHubTarget${i}`, 'function', 'comm:clean', false);
    insertRelation(db, 'NORMAL_HUB', `NH_TARGET${i}`, 'calls');
  }
}

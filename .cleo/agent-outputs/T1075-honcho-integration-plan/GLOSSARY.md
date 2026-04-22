# Honcho↔CLEO Terminology Glossary

**Task**: T1211 | **Version**: 1.0 | **Status**: Wave 0.3 (Integration Prerequisites)

This glossary maps Honcho domain terminology to CLEO equivalents, providing a bridge for Wave 0 integration work. Each entry identifies the Honcho source location, CLEO target file, and explains the conceptual correspondence, differences, and migration path.

---

## Entries

### 1. workspace ≡ project

**Honcho Source**: `/mnt/projects/honcho/src/models.py` (lines 93–124, `Workspace` class)  
**CLEO Target**: `/mnt/projects/cleocode/packages/core/src/project/` (not yet extracted; stored in `config.json` and session scope)

**Mapping**:  
A Honcho `Workspace` is the top-level isolation boundary for agents, sessions, peers, documents, and collections. It maps to a CLEO **project** — the named scope returned by `cleo show --scope` and stored in `config.json:projectName`. In CLEO, project scope is enforced at session instantiation via `SessionScope.type = "global"` (project-wide) or narrowed to epic/task subtrees.

**Key Differences**:
- **Honcho**: Workspace is a first-class ORM model with a nanoid-keyed `id` field, unique `name`, creation timestamp, metadata blobs, and configuration JSONB. Workspaces are queryable and mutable via CRUD endpoints.
- **CLEO**: Project is a runtime concept tied to the current working directory and `.cleo/config.json`. There is no standalone project ORM table; project identity is derived from `config.projectName`, `config.projectId`, and `.cleo/tasks.db` schema version.
- **Wave 8+ Plan**: CLEO Wave 8 (`T1148`) will introduce a `projects` table in the global `signaldock.db`, mirroring Honcho's Workspace isolation model, enabling multi-project agent coordination.

---

### 2. peer ≡ CANT agent

**Honcho Source**: `/mnt/projects/honcho/src/models.py` (lines 126–161, `Peer` class) + `/mnt/projects/honcho/src/crud/peer.py`  
**CLEO Target**: `/mnt/projects/cleocode/packages/agents/` (seed-agents) + `/mnt/projects/cleocode/packages/contracts/src/agent-registry-v3.ts` (ResolvedAgent)

**Mapping**:  
A Honcho `Peer` is an agent participant — identified by `id` (nanoid), `name` (unique per workspace), and workspace membership. Peers hold metadata, configuration, and relationships to sessions. This directly corresponds to CLEO's **CANT agent** — a computational entity declared in `.cant` manifest files (e.g., `/mnt/projects/cleocode/packages/agents/cleo-subagent/cleo-subagent.cant`) and registered in the agent registry (`signaldock.db:agents` table, introduced in T889/T897).

**Key Differences**:
- **Honcho**: Peers are mutable ORM rows with per-workspace unique names, composition foreign keys, and a join table (`session_peers`) for many-to-many session membership with per-join `configuration` and `internal_metadata` blobs.
- **CLEO**: Agents are declared in `.cant` YAML, which is parsed into `AgentCredential` and `ResolvedAgent` records. Registration is deterministic from `.cant` source; the agent registry is a versioned denormalization of `.cant` files. Per-session agent state (spawn context, configuration overrides) is captured in `spawn_attempts` table, not in a join table.
- **Wave 0 + 1 Plan**: T1210 (agent registry fix) will consolidate seed-agent `.cant` declarations and expose `PeerIdentity` types in `packages/contracts/src/peer.ts`. Future Waves will add peer-card schema (T1148) to track agent capabilities and compatibility.

---

### 3. session ≡ session

**Honcho Source**: `/mnt/projects/honcho/src/models.py` (lines 163–200, `Session` class) + `/mnt/projects/honcho/src/crud/session.py`  
**CLEO Target**: `/mnt/projects/cleocode/packages/contracts/src/session.ts` (Session interface) + `/mnt/projects/cleocode/packages/core/src/sessions/`

**Mapping**:  
A Honcho `Session` is a named, timestamped interaction context within a workspace. It has an `id`, `name`, `is_active` flag, creation timestamp, relationships to peers (via `session_peers` join), and messages. CLEO's **session** is directly analogous — a timestamped work context identified by `id` (e.g., `ses_20260401...`), `name`, `status` (active/suspended/ended), and scope. Sessions own tasks, notes, and session statistics.

**Key Differences**:
- **Honcho**: Sessions are isolated to a workspace and store raw messages directly. The `session_peers` join table tracks which peers participated and when they joined/left. Sessions are primarily message containers with metadata and no explicit task concept.
- **CLEO**: Sessions are project-scoped and include task work state (`SessionTaskWork`), scope filtering (`SessionScope`), and statistics (`SessionStats`). CLEO sessions reference tasks, not arbitrary messages. Message equivalent is stored separately (new `session_messages` table — Wave 2, T1081+).
- **Storage Differences**: Honcho uses composite foreign keys (`(session_name, workspace_name)`); CLEO uses single primary keys + project-implicit scoping. Honcho stores raw message content in the same session; CLEO separates session metadata from session turns.
- **Wave 2 Plan**: T1081 will introduce the `session_messages` table to track turn-by-turn session state (analogous to Honcho's messages), with message sequencing (`seq_in_session`), peer attribution, and embedding sync state.

---

### 4. representation ≡ theory-of-mind (planned)

**Honcho Source**: `/mnt/projects/honcho/src/crud/representation.py` + `/mnt/projects/honcho/src/models.py` (Document class — documents ARE representations saved to disk)  
**CLEO Target**: `/mnt/projects/cleocode/packages/core/src/memory/` (future `brain_representations` table — not yet implemented)

**Mapping**:  
A Honcho `Representation` is an agent's inferred model of the state of another peer — observations that are "deduced" or "explicit" about what the observed agent believes, intends, or has learned. The `RepresentationManager` derives representations from messages, embeds them, and saves them as documents to a collection. This maps to CLEO's planned **theory-of-mind** — a record of what one agent believes about another agent's state, plans, or knowledge. In CLEO's architecture (T1148, Wave 8), this will be a new `brain_representations` table capturing peer-as-subject observations.

**Key Differences**:
- **Honcho**: Representations are transient objects created by the Deriver module (Python class `Representation` with `deductive` and `explicit` lists). They are materialized as `Document` rows in the database, linked to a `Collection` via `observer`↔`observed` pairs. Each representation becomes documents stored in the document store.
- **CLEO**: Representations will be first-class records in `brain_representations` (forward-reference to Wave 8, T1148). They will have an `id`, `observer_id` (CANT agent ID), `observed_id` (CANT agent ID), `content`, `confidence`, and creation timestamp. Unlike Honcho's embedding per document, CLEO will batch-embed representations separately as a post-insert step.
- **Migration Path**: Honcho's `documents` table (scoped by `observer` and `observed`) will map to CLEO's future `brain_representations`. The `Collection` concept (grouping documents by observer-observed pair) is implicit in CLEO's composite-key design.
- **Status**: Not yet implemented. See `.cleo/agent-outputs/T1075-honcho-integration-plan/PLAN.md` for Wave 8 details.

---

### 5. collection ≡ brain_observations grouping

**Honcho Source**: `/mnt/projects/honcho/src/models.py` (lines 332–373, `Collection` class) + `/mnt/projects/honcho/src/crud/collection.py`  
**CLEO Target**: `/mnt/projects/cleocode/packages/core/src/store/validation-schemas.ts` (brain_observations table) — implicit grouping by `(observer, observed, subject)`

**Mapping**:  
A Honcho `Collection` is a container for documents, uniquely scoped to an `observer` peer, an `observed` peer, and a workspace. Collections enforce the uniqueness constraint `(observer, observed, workspace_name)` to prevent duplicate peer-pair observations. This maps to CLEO's **brain_observations** table, which has observations that are logically grouped by the agent pair studying each other. In CLEO, collections are implicit — observations are queried and grouped by `observer`, `observed`, and optionally `subject` (the entity being observed).

**Key Differences**:
- **Honcho**: Collections are ORM entities with explicit `id`, `observer`, `observed`, creation timestamp, and metadata. Documents belong to a collection. Collections are queryable and can be listed, queried by observer-observed pair.
- **CLEO**: `brain_observations` rows do not have an explicit `collection` row. Instead, observations are queried and grouped dynamically. A "collection" is a logical view over rows where `(observer_id, observed_id, subject_type)` are constant. Grouping is implicit in query logic, not materialized as a table row.
- **Denormalization**: CLEO's approach avoids an extra lookup table and simplifies concurrent inserts. Honcho's explicit Collection rows allow metadata attachment per observer-observed pair.
- **Wave 1+ Plan**: Future schema enhancements (Wave 1, T1076) may add explicit `collections` metadata rows if per-pair configuration becomes necessary. For now, observations are "self-grouped" by query filters.

---

### 6. document ≡ brain_learnings

**Honcho Source**: `/mnt/projects/honcho/src/models.py` (lines 375–471, `Document` class) + `/mnt/projects/honcho/src/crud/document.py`  
**CLEO Target**: `/mnt/projects/cleocode/packages/core/src/store/validation-schemas.ts` (brain_learnings table) + `/mnt/projects/cleocode/packages/contracts/src/memory.ts` (BridgeLearning)

**Mapping**:  
A Honcho `Document` is a persistable observation — content that has been derived or explicitly collected, embedded into a vector, and optionally synced to an external vector store. Documents carry a `level` (explicit/implicit/derived), embedding state, source IDs for lineage, creation and sync timestamps. This maps to CLEO's **brain_learnings** — refined insights extracted from observations, stored with confidence scores and source attribution. Both are vectors for semantic search and represent reified knowledge artifacts.

**Key Differences**:
- **Honcho**: Documents are the primary persistence model. They have embedding vectors (pgvector), source ID lineage, times_derived counters, deleted_at soft-delete timestamps, and explicit sync_state tracking (pending/synced/failed) for vector store replication. Documents are linked to collections and sessions.
- **CLEO**: `brain_learnings` is one of several observation types in the BRAIN system. Learnings are derived insights with `id`, `text`, `source` (attribution), `confidence` [0..1], and metadata. Unlike Honcho's unified Document, CLEO has separate tables for observations (`brain_observations`), learnings (`brain_learnings`), decisions (`brain_decisions`), patterns (`brain_patterns`), and planned representations (`brain_representations` in Wave 8).
- **Embedding**: Both store embeddings; Honcho embeds documents, CLEO embeds observations and learnings separately. CLEO's embedding sync is managed per-table by the reconciler (T1083, Wave 3+).
- **Source Attribution**: Honcho uses `source_ids` JSONB array; CLEO uses `source` string (e.g., "T123:session:obs-abc") and `source_kind` enum (commit, file, task, session, etc.).

---

### 7. message ≡ session turn (new in Wave 2)

**Honcho Source**: `/mnt/projects/honcho/src/models.py` (lines 202–271, `Message` class) + `/mnt/projects/honcho/src/crud/message.py`  
**CLEO Target**: `/mnt/projects/cleocode/packages/core/src/store/validation-schemas.ts` (future `session_messages` table — Wave 2, T1081) — forward-reference

**Mapping**:  
A Honcho `Message` is a timestamped turn in a session — content from a peer, token-counted, with metadata and embedding state. Messages are indexed by session, peer, and sequence number (`seq_in_session`). This maps to CLEO's planned **session turn** — a single exchange in a session between agent and user, capturing role, content, token count, and embedding state. Session turns are the atomic unit of session state progression.

**Key Differences**:
- **Honcho**: Messages are first-class — one of the core tables with embedding, full-text search indexes, and embedding sync state. Messages can exist orphaned (Honcho v2.0 migration note, line 213). Sessions are message containers. MessageEmbedding is a separate table for vector storage and sync tracking.
- **CLEO**: Session turns do not yet have a dedicated table (Wave 2 incoming, T1081). Currently, session state is captured in `SessionTaskWork` and `sessions.notes[]` (appended strings). The new `session_messages` table will formalize turns with columns: `id` (nanoid), `session_id`, `peer_id`, `content`, `role` (user/agent), `seq_in_session` (BigInt), `token_count`, `created_at`, `embedding` (vector), `sync_state`, and metadata JSONB.
- **Null Workspace Handling**: Honcho's `session_peers_table` includes workspace context for all foreign keys; CLEO's sessions are project-scoped, so workspace is implicit (not materialized).
- **Wave 2 Schedule**: T1081 will introduce the `session_messages` schema. T1082+ will add turn-level embedding, sync state, and dialectic (message threading).

---

## Cross-References

This glossary complements the **Honcho Source Audit** (`HONCHO-SOURCE-NOTES.md`, Lead C / T1209), which provides per-file code summaries and implementation details. Refer to HONCHO-SOURCE-NOTES.md for:
- Detailed function signatures in `crud/peers.py`, `crud/sessions.py`, `crud/documents.py`
- Deriver, Dreamer, Reconciler system architecture
- Queue and embedding sync state machines
- LLM integration patterns

---

## Schema Alignment Summary

| Honcho | CLEO (v2026.4.110) | CLEO (Wave 1+) | Wave | Status |
|--------|-------------------|----------------|------|--------|
| Workspace | config.projectName | signaldock.db:projects (T1148) | 8 | In planning |
| Peer | AgentCredential + ResolvedAgent | agent_registry (v3) | 0 | ✅ Shipping v.110 (T1210) |
| Session | Session contract + sessions table | session_messages (T1081) | 2 | ✅ Exists (add turns) |
| Representation | (none) | brain_representations (T1148) | 8 | 🚧 Not implemented |
| Collection | (implicit grouping) | brain_observations (implicit) | 0 | ✅ Exists |
| Document | brain_learnings | brain_learnings (typed table) | 0+ | ✅ Exists |
| Message | (no equivalent) | session_messages (T1081) | 2 | 🚧 Incoming |

---

## Integration Roadmap Notes

- **Wave 0** (v2026.4.110): Agent registry cleanup (T1210), this glossary (T1211), worktree defaults (T1140). No schema changes; prep only.
- **Wave 1** (v2026.4.111): `user_profile` table (T1076), project isolation schema (T1081 sketch). Honcho peer attributes → CLEO peer_profile columns.
- **Wave 2** (v2026.4.112): `session_messages` table (T1081), turn sequencing, message embedding sync. Direct mapping of Honcho Message → session_messages row.
- **Wave 3+** (v2026.4.113+): Dialectic, multi-pass deriver, reconciler queue, dreamer, and representations (T1083, T1145, T1146, T1147, T1148). Full Honcho subsystem equivalents materialized.

---

## Document Stats

- **Word Count**: ~900 words
- **Entries**: 7 core terminology mappings
- **Forward-References**: 5 (Wave 1–8 planned features)
- **Honcho Source Files Referenced**: 5 (`models.py`, `crud/peer.py`, `crud/session.py`, `crud/representation.py`, `crud/document.py`, `crud/message.py`)
- **CLEO Target Files Referenced**: 7 (contracts, core packages, schema files)

---

**Glossary Version**: 1.0  
**Last Updated**: 2026-04-22  
**Related Tasks**: T1209 (Honcho audit), T1210 (Agent registry), T1140 (Worktree defaults), T1075 (Honcho integration epic)

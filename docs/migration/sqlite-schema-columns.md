### Scope: `brain` (target DB: `.cleo/brain.db`)

#### `packages/core/src/store/memory-schema.ts`

##### `brain_decisions` → `brain_decisions`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `type` | TEXT | enum |  |  |  |  |  | `BRAIN_DECISION_TYPES` |
| `decision` | TEXT | text |  |  |  |  |  |  |
| `rationale` | TEXT | text |  |  |  |  |  |  |
| `confidence` | TEXT | enum |  |  |  |  |  | `BRAIN_CONFIDENCE_LEVELS` |
| `outcome` | TEXT | enum | ✓ |  |  |  |  | `BRAIN_OUTCOME_TYPES` |
| `alternatives_json` | TEXT | json | ✓ |  |  |  |  | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `context_epic_id` | TEXT | id | ✓ |  |  |  |  |  |
| `context_task_id` | TEXT | id | ✓ |  |  |  |  |  |
| `context_phase` | TEXT | text | ✓ |  |  |  |  |  |
| `quality_score` | REAL | real | ✓ |  |  |  |  |  |
| `created_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `updated_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `memory_tier` | TEXT | enum | ✓ |  |  |  | `'medium'` | `BRAIN_MEMORY_TIERS` |
| `memory_type` | TEXT | enum | ✓ |  |  |  | `'semantic'` | `BRAIN_COGNITIVE_TYPES` |
| `verified` | INTEGER | boolean |  |  |  |  | `false` |  |
| `valid_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `invalid_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `source_confidence` | TEXT | enum | ✓ |  |  |  | `'agent'` | `BRAIN_SOURCE_CONFIDENCE` |
| `citation_count` | INTEGER | numeric |  |  |  |  | `0` |  |
| `tier_promoted_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `tier_promotion_reason` | TEXT | text | ✓ |  |  |  |  |  |
| `content_hash` | TEXT | text | ✓ |  |  |  |  |  |
| `provenance_class` | TEXT | text | ✓ |  |  |  | `'swept-clean'` |  |
| `peer_id` | TEXT | id |  |  |  |  | `'global'` |  |
| `peer_scope` | TEXT | text |  |  |  |  | `'project'` |  |
| `adr_number` | INTEGER | numeric | ✓ |  |  |  |  |  |
| `adr_path` | TEXT | text | ✓ |  |  |  |  |  |
| `supersedes` | TEXT | fk | ✓ |  |  |  |  |  |
| `superseded_by` | TEXT | fk | ✓ |  |  |  |  |  |
| `confirmation_state` | TEXT | enum |  |  |  |  | `'proposed'` | `['proposed', 'accepted', 'superseded']` |
| `decided_by` | TEXT | enum |  |  |  |  | `'agent'` | `['owner', 'council', 'agent']` |
| `validator_run_at` | INTEGER | timestamp-epoch | ✓ |  |  |  |  | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |
| `decision_category` | TEXT | enum |  |  |  |  | `'architectural'` | `BRAIN_DECISION_CATEGORIES` |

##### `brain_patterns` → `brain_patterns`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `type` | TEXT | enum |  |  |  |  |  | `BRAIN_PATTERN_TYPES` |
| `pattern` | TEXT | text |  |  |  |  |  |  |
| `context` | TEXT | text |  |  |  |  |  |  |
| `frequency` | INTEGER | numeric |  |  |  |  | `1` |  |
| `success_rate` | REAL | real | ✓ |  |  |  |  |  |
| `impact` | TEXT | enum | ✓ |  |  |  |  | `BRAIN_IMPACT_LEVELS` |
| `anti_pattern` | TEXT | text | ✓ |  |  |  |  |  |
| `mitigation` | TEXT | text | ✓ |  |  |  |  |  |
| `examples_json` | TEXT | json | ✓ |  |  |  | `'[]'` | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `extracted_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `updated_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `quality_score` | REAL | real | ✓ |  |  |  |  |  |
| `memory_tier` | TEXT | enum | ✓ |  |  |  | `'medium'` | `BRAIN_MEMORY_TIERS` |
| `memory_type` | TEXT | enum | ✓ |  |  |  | `'procedural'` | `BRAIN_COGNITIVE_TYPES` |
| `verified` | INTEGER | boolean |  |  |  |  | `false` |  |
| `valid_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `invalid_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `source_confidence` | TEXT | enum | ✓ |  |  |  | `'agent'` | `BRAIN_SOURCE_CONFIDENCE` |
| `citation_count` | INTEGER | numeric |  |  |  |  | `0` |  |
| `tier_promoted_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `tier_promotion_reason` | TEXT | text | ✓ |  |  |  |  |  |
| `content_hash` | TEXT | text | ✓ |  |  |  |  |  |
| `provenance_class` | TEXT | text | ✓ |  |  |  | `'swept-clean'` |  |
| `peer_id` | TEXT | id |  |  |  |  | `'global'` |  |
| `peer_scope` | TEXT | text |  |  |  |  | `'project'` |  |
| `occurrence_count` | INTEGER | numeric |  |  |  |  | `1` |  |
| `last_seen_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |

##### `brain_learnings` → `brain_learnings`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `insight` | TEXT | text |  |  |  |  |  |  |
| `source` | TEXT | text |  |  |  |  |  |  |
| `confidence` | REAL | real |  |  |  |  |  |  |
| `actionable` | INTEGER | boolean |  |  |  |  | `false` |  |
| `application` | TEXT | text | ✓ |  |  |  |  |  |
| `applicable_types_json` | TEXT | json | ✓ |  |  |  |  | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `created_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `updated_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `quality_score` | REAL | real | ✓ |  |  |  |  |  |
| `memory_tier` | TEXT | enum | ✓ |  |  |  | `'short'` | `BRAIN_MEMORY_TIERS` |
| `memory_type` | TEXT | enum | ✓ |  |  |  | `'semantic'` | `BRAIN_COGNITIVE_TYPES` |
| `verified` | INTEGER | boolean |  |  |  |  | `false` |  |
| `valid_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `invalid_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `source_confidence` | TEXT | enum | ✓ |  |  |  | `'agent'` | `BRAIN_SOURCE_CONFIDENCE` |
| `citation_count` | INTEGER | numeric |  |  |  |  | `0` |  |
| `tier_promoted_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `tier_promotion_reason` | TEXT | text | ✓ |  |  |  |  |  |
| `content_hash` | TEXT | text | ✓ |  |  |  |  |  |
| `provenance_class` | TEXT | text | ✓ |  |  |  | `'swept-clean'` |  |
| `peer_id` | TEXT | id |  |  |  |  | `'global'` |  |
| `peer_scope` | TEXT | text |  |  |  |  | `'project'` |  |

##### `brain_observations` → `brain_observations`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `type` | TEXT | enum |  |  |  |  |  | `BRAIN_OBSERVATION_TYPES` |
| `title` | TEXT | text |  |  |  |  |  |  |
| `subtitle` | TEXT | text | ✓ |  |  |  |  |  |
| `narrative` | TEXT | text | ✓ |  |  |  |  |  |
| `facts_json` | TEXT | json | ✓ |  |  |  |  | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `concepts_json` | TEXT | json | ✓ |  |  |  |  | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `project` | TEXT | text | ✓ |  |  |  |  |  |
| `files_read_json` | TEXT | json | ✓ |  |  |  |  | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `files_modified_json` | TEXT | json | ✓ |  |  |  |  | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `source_session_id` | TEXT | id | ✓ |  |  |  |  |  |
| `source_type` | TEXT | enum |  |  |  |  | `'agent'` | `BRAIN_OBSERVATION_SOURCE_TYPES` |
| `agent` | TEXT | text | ✓ |  |  |  |  |  |
| `content_hash` | TEXT | text | ✓ |  |  |  |  |  |
| `discovery_tokens` | INTEGER | numeric | ✓ |  |  |  |  |  |
| `quality_score` | REAL | real | ✓ |  |  |  |  |  |
| `created_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `updated_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `memory_tier` | TEXT | enum | ✓ |  |  |  | `'short'` | `BRAIN_MEMORY_TIERS` |
| `memory_type` | TEXT | enum | ✓ |  |  |  | `'episodic'` | `BRAIN_COGNITIVE_TYPES` |
| `verified` | INTEGER | boolean |  |  |  |  | `false` |  |
| `valid_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `invalid_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `source_confidence` | TEXT | enum | ✓ |  |  |  | `'agent'` | `BRAIN_SOURCE_CONFIDENCE` |
| `citation_count` | INTEGER | numeric |  |  |  |  | `0` |  |
| `tier_promoted_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `tier_promotion_reason` | TEXT | text | ✓ |  |  |  |  |  |
| `attachments_json` | TEXT | json | ✓ |  |  |  |  | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `stability_score` | REAL | real | ✓ |  |  |  | `0.5` |  |
| `provenance_class` | TEXT | text | ✓ |  |  |  | `'swept-clean'` |  |
| `peer_id` | TEXT | id |  |  |  |  | `'global'` |  |
| `peer_scope` | TEXT | text |  |  |  |  | `'project'` |  |
| `source_ids` | TEXT | text | ✓ |  |  |  |  |  |
| `times_derived` | INTEGER | numeric | ✓ |  |  |  | `1` |  |
| `level` | TEXT | text | ✓ |  |  |  | `'explicit'` |  |
| `tree_id` | INTEGER | numeric | ✓ |  |  |  |  |  |
| `origin` | TEXT | text | ✓ |  |  |  |  |  |
| `validated_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `provenance_chain` | TEXT | text | ✓ |  |  |  |  |  |

##### `brain_sticky_notes` → `brain_sticky_notes`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `content` | TEXT | text |  |  |  |  |  |  |
| `created_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `updated_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `tags_json` | TEXT | json | ✓ |  |  |  |  | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `status` | TEXT | enum |  |  |  |  | `'active'` | `BRAIN_STICKY_STATUSES` |
| `converted_to_json` | TEXT | json | ✓ |  |  |  |  | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `color` | TEXT | enum | ✓ |  |  |  |  | `BRAIN_STICKY_COLORS` |
| `priority` | TEXT | enum | ✓ |  |  |  |  | `BRAIN_STICKY_PRIORITIES` |
| `source_type` | TEXT | text | ✓ |  |  |  | `'sticky-note'` |  |

##### `brain_memory_links` → `brain_memory_links`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `memory_type` | TEXT | enum |  |  |  |  |  | `BRAIN_MEMORY_TYPES` |
| `memory_id` | TEXT | id |  |  |  |  |  |  |
| `task_id` | TEXT | id |  |  |  |  |  |  |
| `link_type` | TEXT | enum |  |  |  |  |  | `BRAIN_LINK_TYPES` |
| `created_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |

##### `brain_schema_meta` → `brain_schema_meta`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `key` | TEXT | text |  |  |  |  |  |  |
| `value` | TEXT | text |  |  |  |  |  |  |

##### `brain_page_nodes` → `brain_page_nodes`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `node_type` | TEXT | enum |  |  |  |  |  | `BRAIN_NODE_TYPES` |
| `label` | TEXT | text |  |  |  |  |  |  |
| `quality_score` | REAL | real |  |  |  |  | `0.5` |  |
| `content_hash` | TEXT | text | ✓ |  |  |  |  |  |
| `last_activity_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `metadata_json` | TEXT | json | ✓ |  |  |  |  | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `created_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `updated_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |

##### `brain_page_edges` → `brain_page_edges`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `from_id` | TEXT | id |  |  |  |  |  |  |
| `to_id` | TEXT | id |  |  |  |  |  |  |
| `edge_type` | TEXT | enum |  |  |  |  |  | `BRAIN_EDGE_TYPES` |
| `weight` | REAL | real |  |  |  |  | `1.0` |  |
| `provenance` | TEXT | text | ✓ |  |  |  |  |  |
| `created_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `last_reinforced_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `reinforcement_count` | INTEGER | numeric |  |  |  |  | `0` |  |
| `plasticity_class` | TEXT | enum |  |  |  |  | `'static'` | `['static', 'hebbian', 'stdp'] as const` |
| `last_depressed_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `depression_count` | INTEGER | numeric |  |  |  |  | `0` |  |
| `stability_score` | REAL | real | ✓ |  |  |  |  |  |

##### `brain_retrieval_log` → `brain_retrieval_log`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | INTEGER | numeric |  |  |  |  |  |  |
| `query` | TEXT | text |  |  |  |  |  |  |
| `entry_ids` | TEXT | text |  |  |  |  |  |  |
| `entry_count` | INTEGER | numeric |  |  |  |  |  |  |
| `source` | TEXT | text |  |  |  |  |  |  |
| `tokens_used` | INTEGER | numeric | ✓ |  |  |  |  |  |
| `session_id` | TEXT | id | ✓ |  |  |  |  |  |
| `created_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `retrieval_order` | INTEGER | numeric | ✓ |  |  |  |  |  |
| `delta_ms` | INTEGER | numeric | ✓ |  |  |  |  |  |
| `reward_signal` | REAL | real | ✓ |  |  |  |  |  |

##### `brain_plasticity_events` → `brain_plasticity_events`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | INTEGER | numeric |  |  |  |  |  |  |
| `source_node` | TEXT | text |  |  |  |  |  |  |
| `target_node` | TEXT | text |  |  |  |  |  |  |
| `delta_w` | REAL | real |  |  |  |  |  |  |
| `kind` | TEXT | enum |  |  |  |  |  | `['ltp', 'ltd']` |
| `timestamp` | TEXT | text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `session_id` | TEXT | id | ✓ |  |  |  |  |  |
| `weight_before` | REAL | real | ✓ |  |  |  |  |  |
| `weight_after` | REAL | real | ✓ |  |  |  |  |  |
| `retrieval_log_id` | INTEGER | numeric | ✓ |  |  |  |  |  |
| `reward_signal` | REAL | real | ✓ |  |  |  |  |  |
| `delta_t_ms` | INTEGER | numeric | ✓ |  |  |  |  |  |

##### `brain_weight_history` → `brain_weight_history`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | INTEGER | numeric |  |  |  |  |  |  |
| `edge_from_id` | TEXT | id |  |  |  |  |  |  |
| `edge_to_id` | TEXT | id |  |  |  |  |  |  |
| `edge_type` | TEXT | text |  |  |  |  |  |  |
| `weight_before` | REAL | real | ✓ |  |  |  |  |  |
| `weight_after` | REAL | real |  |  |  |  |  |  |
| `delta_weight` | REAL | real |  |  |  |  |  |  |
| `event_kind` | TEXT | text |  |  |  |  |  |  |
| `source_plasticity_event_id` | INTEGER | numeric | ✓ |  |  |  |  |  |
| `retrieval_log_id` | INTEGER | numeric | ✓ |  |  |  |  |  |
| `reward_signal` | REAL | real | ✓ |  |  |  |  |  |
| `changed_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |

##### `brain_modulators` → `brain_modulators`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | INTEGER | numeric |  |  |  |  |  |  |
| `modulator_type` | TEXT | text |  |  |  |  |  |  |
| `valence` | REAL | real |  |  |  |  |  |  |
| `magnitude` | REAL | real |  |  |  |  | `1.0` |  |
| `source_event_id` | TEXT | id | ✓ |  |  |  |  |  |
| `session_id` | TEXT | id | ✓ |  |  |  |  |  |
| `description` | TEXT | text | ✓ |  |  |  |  |  |
| `created_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |

##### `brain_consolidation_events` → `brain_consolidation_events`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | INTEGER | numeric |  |  |  |  |  |  |
| `trigger` | TEXT | text |  |  |  |  |  |  |
| `session_id` | TEXT | id | ✓ |  |  |  |  |  |
| `step_results_json` | TEXT | json |  |  |  |  |  | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `duration_ms` | INTEGER | numeric | ✓ |  |  |  |  |  |
| `succeeded` | INTEGER | boolean |  |  |  |  | `true` |  |
| `started_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |

##### `brain_transcript_events` → `brain_transcript_events`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `session_id` | TEXT | id |  |  |  |  |  |  |
| `seq` | INTEGER | numeric |  |  |  |  |  |  |
| `role` | TEXT | text |  |  |  |  |  | ⚠ enum-like TEXT 'role' lacks { enum } / CHECK (col IN (...)) |
| `block_type` | TEXT | text |  |  |  |  |  |  |
| `content` | TEXT | text |  |  |  |  |  |  |
| `tokens` | INTEGER | numeric | ✓ |  |  |  |  |  |
| `redacted_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `created_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |

##### `brain_promotion_log` → `brain_promotion_log`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `observation_id` | TEXT | id |  |  |  |  |  |  |
| `from_tier` | TEXT | text |  |  |  |  |  |  |
| `to_tier` | TEXT | text |  |  |  |  |  |  |
| `score` | REAL | real |  |  |  |  |  |  |
| `decided_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `decided_by` | TEXT | text |  |  |  |  | `'composite-scorer'` |  |
| `rationale_json` | TEXT | json | ✓ |  |  |  |  | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |

##### `brain_backfill_runs` → `brain_backfill_runs`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `kind` | TEXT | text |  |  |  |  |  | ⚠ enum-like TEXT 'kind' lacks { enum } / CHECK (col IN (...)) |
| `status` | TEXT | text |  |  |  |  | `'staged'` | ⚠ enum-like TEXT 'status' lacks { enum } / CHECK (col IN (...)) |
| `created_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `approved_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `rows_affected` | INTEGER | numeric |  |  |  |  | `0` |  |
| `rollback_snapshot_json` | TEXT | json | ✓ |  |  |  |  | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `source` | TEXT | text |  |  |  |  | `'unknown'` |  |
| `target_table` | TEXT | text |  |  |  |  | `'brain_observations'` |  |
| `approved_by` | TEXT | text | ✓ |  |  |  |  |  |

##### `session_narrative` → `brain_session_narrative`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `session_id` | TEXT | id |  |  |  |  |  |  |
| `narrative` | TEXT | text |  |  |  |  | `''` |  |
| `turn_count` | INTEGER | numeric |  |  |  |  | `0` |  |
| `last_updated_at` | INTEGER | timestamp-epoch |  |  |  |  | `0` | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |
| `pivot_count` | INTEGER | numeric |  |  |  |  | `0` |  |

##### `deriver_queue` → `brain_deriver_queue`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `item_type` | TEXT | enum |  |  |  |  |  | `DERIVER_QUEUE_ITEM_TYPES` |
| `item_id` | TEXT | id |  |  |  |  |  |  |
| `priority` | INTEGER | numeric |  |  |  |  | `0` |  |
| `status` | TEXT | enum |  |  |  |  | `'pending'` | `DERIVER_QUEUE_STATUSES` |
| `claimed_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `claimed_by` | TEXT | text | ✓ |  |  |  |  |  |
| `error_msg` | TEXT | text | ✓ |  |  |  |  |  |
| `retry_count` | INTEGER | numeric |  |  |  |  | `0` |  |
| `created_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `completed_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |

##### `brain_memory_trees` → `brain_memory_trees`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | INTEGER | numeric |  |  |  |  |  |  |
| `depth` | INTEGER | numeric |  |  |  |  | `0` |  |
| `leaf_ids` | TEXT | json |  |  |  |  | `'[]'` | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `centroid` | TEXT | text | ✓ |  |  |  |  |  |
| `parent_id` | INTEGER | numeric | ✓ |  |  |  |  |  |
| `created_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `updated_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |

##### `brain_observations_staging` → `brain_observations_staging`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `source_table` | TEXT | text |  |  |  |  |  |  |
| `source_id` | TEXT | id |  |  |  |  |  |  |
| `sweep_run_id` | TEXT | id |  |  |  |  |  |  |
| `action` | TEXT | text |  |  |  |  |  |  |
| `new_quality_score` | REAL | real | ✓ |  |  |  |  |  |
| `new_invalid_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `new_provenance_class` | TEXT | text | ✓ |  |  |  |  |  |
| `validation_status` | TEXT | text |  |  |  |  | `'pending'` |  |
| `created_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |

#### `packages/core/src/store/nexus-schema.ts`

##### `project_registry` → `nexus_project_registry`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `project_id` | TEXT | id |  |  |  |  |  |  |
| `project_hash` | TEXT | text |  |  |  |  |  |  |
| `project_path` | TEXT | text |  |  |  |  |  |  |
| `name` | TEXT | text |  |  |  |  |  |  |
| `registered_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `last_seen` | TEXT | text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `health_status` | TEXT | text |  |  |  |  | `'unknown'` |  |
| `health_last_check` | TEXT | text | ✓ |  |  |  |  |  |
| `permissions` | TEXT | text |  |  |  |  | `'read'` |  |
| `last_sync` | TEXT | text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `task_count` | INTEGER | numeric |  |  |  |  | `0` |  |
| `labels_json` | TEXT | json |  |  |  |  | `'[]'` | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `brain_db_path` | TEXT | text | ✓ |  |  |  |  |  |
| `tasks_db_path` | TEXT | text | ✓ |  |  |  |  |  |
| `last_indexed` | TEXT | text | ✓ |  |  |  |  |  |
| `stats_json` | TEXT | json |  |  |  |  | `'{}'` | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |

##### `project_id_aliases` → `nexus_project_id_aliases`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `legacy_id` | TEXT | id |  |  |  |  |  |  |
| `canonical_id` | TEXT | id |  |  |  |  |  |  |
| `created_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |

##### `nexus_audit_log` → `nexus_audit_log`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `timestamp` | TEXT | text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `action` | TEXT | text |  |  |  |  |  |  |
| `project_hash` | TEXT | text | ✓ |  |  |  |  |  |
| `project_id` | TEXT | id | ✓ |  |  |  |  |  |
| `domain` | TEXT | text | ✓ |  |  |  |  |  |
| `operation` | TEXT | text | ✓ |  |  |  |  |  |
| `session_id` | TEXT | id | ✓ |  |  |  |  |  |
| `request_id` | TEXT | id | ✓ |  |  |  |  |  |
| `source` | TEXT | text | ✓ |  |  |  |  |  |
| `gateway` | TEXT | text | ✓ |  |  |  |  |  |
| `success` | INTEGER | numeric | ✓ |  |  |  |  |  |
| `duration_ms` | INTEGER | numeric | ✓ |  |  |  |  |  |
| `details_json` | TEXT | json | ✓ |  |  |  | `'{}'` | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `error_message` | TEXT | text | ✓ |  |  |  |  |  |

##### `nexus_schema_meta` → `nexus_schema_meta`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `key` | TEXT | text |  |  |  |  |  |  |
| `value` | TEXT | text |  |  |  |  |  |  |

##### `nexus_nodes` → `nexus_nodes`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `project_id` | TEXT | id |  |  |  |  |  |  |
| `kind` | TEXT | enum |  |  |  |  |  | `NEXUS_NODE_KINDS` |
| `label` | TEXT | text |  |  |  |  |  |  |
| `name` | TEXT | text | ✓ |  |  |  |  |  |
| `file_path` | TEXT | text | ✓ |  |  |  |  |  |
| `start_line` | INTEGER | numeric | ✓ |  |  |  |  |  |
| `end_line` | INTEGER | numeric | ✓ |  |  |  |  |  |
| `language` | TEXT | text | ✓ |  |  |  |  |  |
| `is_exported` | INTEGER | boolean |  |  |  |  | `false` |  |
| `parent_id` | TEXT | id | ✓ |  |  |  |  |  |
| `parameters_json` | TEXT | json | ✓ |  |  |  |  | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `return_type` | TEXT | text | ✓ |  |  |  |  |  |
| `doc_summary` | TEXT | text | ✓ |  |  |  |  |  |
| `community_id` | TEXT | id | ✓ |  |  |  |  |  |
| `meta_json` | TEXT | json | ✓ |  |  |  |  | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `is_external` | INTEGER | boolean |  |  |  |  | `false` |  |
| `indexed_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |

##### `nexus_relations` → `nexus_relations`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `project_id` | TEXT | id |  |  |  |  |  |  |
| `source_id` | TEXT | id |  |  |  |  |  |  |
| `target_id` | TEXT | id |  |  |  |  |  |  |
| `type` | TEXT | enum |  |  |  |  |  | `NEXUS_RELATION_TYPES` |
| `confidence` | REAL | real |  |  |  |  |  |  |
| `reason` | TEXT | text | ✓ |  |  |  |  |  |
| `step` | INTEGER | numeric | ✓ |  |  |  |  |  |
| `indexed_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `weight` | REAL | real | ✓ |  |  |  | `0.0` |  |
| `last_accessed_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `co_accessed_count` | INTEGER | numeric | ✓ |  |  |  | `0` |  |

##### `nexus_contracts` → `nexus_contracts`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `contract_id` | TEXT | id |  |  |  |  |  |  |
| `project_id` | TEXT | id |  |  |  |  |  |  |
| `type` | TEXT | enum |  |  |  |  |  | `NEXUS_CONTRACT_TYPES` |
| `path` | TEXT | text |  |  |  |  |  |  |
| `method` | TEXT | text | ✓ |  |  |  |  |  |
| `request_schema_json` | TEXT | json |  |  |  |  | `'{}'` | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `response_schema_json` | TEXT | json |  |  |  |  | `'{}'` | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `source_symbol_id` | TEXT | id | ✓ |  |  |  |  |  |
| `route_node_id` | TEXT | id | ✓ |  |  |  |  |  |
| `confidence` | REAL | real |  |  |  |  | `1.0` |  |
| `description` | TEXT | text | ✓ |  |  |  |  |  |
| `created_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `updated_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |

##### `user_profile` → `nexus_user_profile`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `trait_key` | TEXT | text |  |  |  |  |  |  |
| `trait_value` | TEXT | text |  |  |  |  |  |  |
| `confidence` | REAL | real |  |  |  |  |  |  |
| `source` | TEXT | text |  |  |  |  |  |  |
| `derived_from_message_id` | TEXT | id | ✓ |  |  |  |  |  |
| `first_observed_at` | INTEGER | timestamp-date |  |  |  |  |  | ⚠ Drizzle { mode: "timestamp" } Date mapping — target canonical form is TEXT ISO8601 + CHECK |
| `last_reinforced_at` | INTEGER | timestamp-date |  |  |  |  |  | ⚠ Drizzle { mode: "timestamp" } Date mapping — target canonical form is TEXT ISO8601 + CHECK |
| `reinforcement_count` | INTEGER | numeric |  |  |  |  | `1` |  |
| `superseded_by` | TEXT | text | ✓ |  |  |  |  |  |

##### `sigils` → `nexus_sigils`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `peer_id` | TEXT | id |  |  |  |  |  |  |
| `cant_file` | TEXT | text | ✓ |  |  |  |  |  |
| `display_name` | TEXT | text |  |  |  |  | `''` |  |
| `role` | TEXT | text |  |  |  |  | `''` | ⚠ enum-like TEXT 'role' lacks { enum } / CHECK (col IN (...)) |
| `system_prompt_fragment` | TEXT | text | ✓ |  |  |  |  |  |
| `capability_flags` | TEXT | text | ✓ |  |  |  |  |  |
| `created_at` | INTEGER | timestamp-date |  |  |  |  |  | ⚠ Drizzle { mode: "timestamp" } Date mapping — target canonical form is TEXT ISO8601 + CHECK |
| `updated_at` | INTEGER | timestamp-date |  |  |  |  |  | ⚠ Drizzle { mode: "timestamp" } Date mapping — target canonical form is TEXT ISO8601 + CHECK |

#### `packages/core/src/store/signaldock-schema.ts`

##### `users` → `signaldock_users`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `email` | TEXT | text |  |  |  |  |  |  |
| `password_hash` | TEXT | text |  |  |  |  |  |  |
| `name` | TEXT | text | ✓ |  |  |  |  |  |
| `slug` | TEXT | text | ✓ |  |  |  |  |  |
| `default_agent_id` | TEXT | id | ✓ |  |  |  |  |  |
| `username` | TEXT | text | ✓ |  |  |  |  |  |
| `display_username` | TEXT | text | ✓ |  |  |  |  |  |
| `email_verified` | INTEGER | numeric |  |  |  |  | `0` |  |
| `image` | TEXT | text | ✓ |  |  |  |  |  |
| `role` | TEXT | text |  |  |  |  | `'user'` | ⚠ enum-like TEXT 'role' lacks { enum } / CHECK (col IN (...)) |
| `banned` | INTEGER | numeric |  |  |  |  | `0` |  |
| `ban_reason` | TEXT | text | ✓ |  |  |  |  |  |
| `ban_expires` | TEXT | text | ✓ |  |  |  |  |  |
| `two_factor_enabled` | INTEGER | numeric |  |  |  |  | `0` |  |
| `metadata` | TEXT | text | ✓ |  |  |  |  |  |
| `created_at` | INTEGER | timestamp-epoch |  |  |  |  |  | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |
| `updated_at` | INTEGER | timestamp-epoch |  |  |  |  |  | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |

##### `organization` → `signaldock_organization`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `name` | TEXT | text |  |  |  |  |  |  |
| `slug` | TEXT | text | ✓ |  |  |  |  |  |
| `logo` | TEXT | text | ✓ |  |  |  |  |  |
| `metadata` | TEXT | text | ✓ |  |  |  |  |  |
| `owner_id` | TEXT | id | ✓ |  |  |  |  |  |
| `created_at` | INTEGER | timestamp-epoch |  |  |  |  | `sql`(strftime('%s','now'))`` | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |
| `updated_at` | INTEGER | timestamp-epoch |  |  |  |  | `sql`(strftime('%s','now'))`` | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |

##### `agents` → `signaldock_agents`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `agent_id` | TEXT | id |  |  |  |  |  |  |
| `name` | TEXT | text |  |  |  |  |  |  |
| `description` | TEXT | text | ✓ |  |  |  |  |  |
| `class` | TEXT | text |  |  |  |  | `'custom'` |  |
| `privacy_tier` | TEXT | text |  |  |  |  | `'public'` |  |
| `owner_id` | TEXT | fk | ✓ |  |  |  |  |  |
| `endpoint` | TEXT | text | ✓ |  |  |  |  |  |
| `webhook_secret` | TEXT | text | ✓ |  |  |  |  |  |
| `capabilities` | TEXT | json |  |  |  |  | `'[]'` | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `skills` | TEXT | json |  |  |  |  | `'[]'` | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `avatar` | TEXT | text | ✓ |  |  |  |  |  |
| `messages_sent` | INTEGER | numeric |  |  |  |  | `0` |  |
| `messages_received` | INTEGER | numeric |  |  |  |  | `0` |  |
| `conversation_count` | INTEGER | numeric |  |  |  |  | `0` |  |
| `friend_count` | INTEGER | numeric |  |  |  |  | `0` |  |
| `status` | TEXT | text |  |  |  |  | `'online'` | ⚠ enum-like TEXT 'status' lacks { enum } / CHECK (col IN (...)) |
| `last_seen` | INTEGER | numeric | ✓ |  |  |  |  |  |
| `payment_config` | TEXT | text | ✓ |  |  |  |  |  |
| `api_key_hash` | TEXT | text | ✓ |  |  |  |  |  |
| `organization_id` | TEXT | fk | ✓ |  |  |  |  |  |
| `created_at` | INTEGER | timestamp-epoch |  |  |  |  |  | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |
| `updated_at` | INTEGER | timestamp-epoch |  |  |  |  |  | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |
| `transport_type` | TEXT | text |  |  |  |  | `'http'` |  |
| `api_key_encrypted` | TEXT | text | ✓ |  |  |  |  |  |
| `api_base_url` | TEXT | text |  |  |  |  | `'https://api.signaldock.io'` |  |
| `classification` | TEXT | text | ✓ |  |  |  |  |  |
| `transport_config` | TEXT | json |  |  |  |  | `'{}'` | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `is_active` | INTEGER | boolean-untyped |  |  |  |  | `1` | ⚠ INTEGER boolean flag lacks { mode: "boolean" } + CHECK (col IN (0,1)) |
| `last_used_at` | INTEGER | timestamp-epoch | ✓ |  |  |  |  | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |
| `requires_reauth` | INTEGER | numeric |  |  |  |  | `0` |  |
| `tier` | TEXT | text |  |  |  |  | `'global'` |  |
| `can_spawn` | INTEGER | numeric |  |  |  |  | `0` |  |
| `orch_level` | INTEGER | numeric |  |  |  |  | `2` |  |
| `reports_to` | TEXT | text | ✓ |  |  |  |  |  |
| `cant_path` | TEXT | text | ✓ |  |  |  |  |  |
| `cant_sha256` | TEXT | text | ✓ |  |  |  |  |  |
| `installed_from` | TEXT | text | ✓ |  |  |  |  |  |
| `installed_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |

##### `claim_codes` → `signaldock_claim_codes`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `agent_id` | TEXT | fk |  |  |  |  |  |  |
| `code` | TEXT | text |  |  |  |  |  |  |
| `expires_at` | INTEGER | timestamp-epoch |  |  |  |  |  | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |
| `used_at` | INTEGER | timestamp-epoch | ✓ |  |  |  |  | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |
| `used_by` | TEXT | fk | ✓ |  |  |  |  |  |
| `created_at` | INTEGER | timestamp-epoch |  |  |  |  |  | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |

##### `capabilities` → `signaldock_capabilities`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `slug` | TEXT | text |  |  |  |  |  |  |
| `name` | TEXT | text |  |  |  |  |  |  |
| `description` | TEXT | text |  |  |  |  |  |  |
| `category` | TEXT | text |  |  |  |  |  |  |
| `created_at` | INTEGER | timestamp-epoch |  |  |  |  |  | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |

##### `skills` → `signaldock_skills`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `slug` | TEXT | text |  |  |  |  |  |  |
| `name` | TEXT | text |  |  |  |  |  |  |
| `description` | TEXT | text |  |  |  |  |  |  |
| `category` | TEXT | text |  |  |  |  |  |  |
| `created_at` | INTEGER | timestamp-epoch |  |  |  |  |  | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |

##### `agent_capabilities` → `signaldock_agent_capabilities`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `agent_id` | TEXT | fk |  |  |  |  |  |  |
| `capability_id` | TEXT | fk |  |  |  |  |  |  |

##### `agent_skills` → `signaldock_agent_skills`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `agent_id` | TEXT | fk |  |  |  |  |  |  |
| `skill_id` | TEXT | fk |  |  |  |  |  |  |
| `source` | TEXT | text |  |  |  |  | `'manual'` |  |
| `attached_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |

##### `agent_connections` → `signaldock_agent_connections`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `agent_id` | TEXT | id |  |  |  |  |  |  |
| `transport_type` | TEXT | text |  |  |  |  | `'http'` |  |
| `connection_id` | TEXT | id | ✓ |  |  |  |  |  |
| `connected_at` | INTEGER | timestamp-epoch |  |  |  |  |  | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |
| `last_heartbeat` | INTEGER | numeric |  |  |  |  |  |  |
| `connection_metadata` | TEXT | text | ✓ |  |  |  |  |  |
| `created_at` | INTEGER | timestamp-epoch |  |  |  |  |  | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |

##### `accounts` → `signaldock_accounts`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `user_id` | TEXT | fk |  |  |  |  |  |  |
| `account_id` | TEXT | id |  |  |  |  |  |  |
| `provider_id` | TEXT | id |  |  |  |  |  |  |
| `access_token` | TEXT | text | ✓ |  |  |  |  |  |
| `refresh_token` | TEXT | text | ✓ |  |  |  |  |  |
| `id_token` | TEXT | text | ✓ |  |  |  |  |  |
| `access_token_expires_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `refresh_token_expires_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `scope` | TEXT | text | ✓ |  |  |  |  |  |
| `password` | TEXT | text | ✓ |  |  |  |  |  |
| `created_at` | TEXT | timestamp-text |  |  |  |  |  |  |
| `updated_at` | TEXT | timestamp-text |  |  |  |  |  |  |

##### `sessions` → `signaldock_sessions`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `user_id` | TEXT | fk |  |  |  |  |  |  |
| `token` | TEXT | text |  |  |  |  |  |  |
| `ip_address` | TEXT | text | ✓ |  |  |  |  |  |
| `user_agent` | TEXT | text | ✓ |  |  |  |  |  |
| `expires_at` | TEXT | timestamp-text |  |  |  |  |  |  |
| `active_organization_id` | TEXT | id | ✓ |  |  |  |  |  |
| `impersonated_by` | TEXT | text | ✓ |  |  |  |  |  |
| `active` | INTEGER | numeric |  |  |  |  | `1` |  |
| `created_at` | TEXT | timestamp-text |  |  |  |  |  |  |
| `updated_at` | TEXT | timestamp-text |  |  |  |  |  |  |

##### `verifications` → `signaldock_verifications`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `identifier` | TEXT | text |  |  |  |  |  |  |
| `value` | TEXT | text |  |  |  |  |  |  |
| `expires_at` | TEXT | timestamp-text |  |  |  |  |  |  |
| `created_at` | TEXT | timestamp-text |  |  |  |  |  |  |
| `updated_at` | TEXT | timestamp-text |  |  |  |  |  |  |

##### `org_agent_keys` → `signaldock_org_agent_keys`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `organization_id` | TEXT | fk |  |  |  |  |  |  |
| `agent_id` | TEXT | fk |  |  |  |  |  |  |
| `created_by` | TEXT | text |  |  |  |  |  |  |
| `created_at` | INTEGER | timestamp-epoch |  |  |  |  |  | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |

#### `packages/core/src/store/skills-schema.ts`

##### `skills` → `skills_skills`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | INTEGER | numeric |  |  |  |  |  |  |
| `name` | TEXT | text |  |  |  |  |  |  |
| `version` | TEXT | text | ✓ |  |  |  |  |  |
| `source_type` | TEXT | enum |  |  |  |  |  | `['canonical', 'user', 'community', 'agent-created']` |
| `source_url` | TEXT | text | ✓ |  |  |  |  |  |
| `install_path` | TEXT | text |  |  |  |  |  |  |
| `canonical_path` | TEXT | text | ✓ |  |  |  |  |  |
| `installed_at` | TEXT | timestamp-text |  |  |  |  |  |  |
| `last_updated_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `lifecycle_state` | TEXT | enum |  |  |  |  | `'active'` | `['active', 'stale', 'archived']` |
| `pinned` | INTEGER | boolean |  |  |  |  | `false` |  |
| `is_agent_created` | INTEGER | boolean |  |  |  |  | `false` |  |
| `archived_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `archived_from_path` | TEXT | text | ✓ |  |  |  |  |  |

##### `skill_usage` → `skills_skill_usage`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | INTEGER | numeric |  |  |  |  |  |  |
| `skill_name` | TEXT | text |  |  |  |  |  |  |
| `observed_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `event_kind` | TEXT | text |  |  |  |  |  |  |
| `task_id` | TEXT | id | ✓ |  |  |  |  |  |
| `model_id` | TEXT | id | ✓ |  |  |  |  |  |
| `metadata` | TEXT | json |  |  |  |  | `'{}'` | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |

##### `skill_reviews` → `skills_skill_reviews`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | INTEGER | numeric |  |  |  |  |  |  |
| `skill_name` | TEXT | text |  |  |  |  |  |  |
| `reviewed_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `outcome` | TEXT | enum |  |  |  |  |  | `['approved', 'rejected', 'needs-changes']` |
| `score` | INTEGER | numeric | ✓ |  |  |  |  |  |
| `review_run_id` | TEXT | id | ✓ |  |  |  |  |  |
| `summary` | TEXT | text | ✓ |  |  |  |  |  |

##### `skill_patches` → `skills_skill_patches`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | INTEGER | numeric |  |  |  |  |  |  |
| `skill_name` | TEXT | text |  |  |  |  |  |  |
| `proposed_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `applied_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `review_id` | INTEGER | numeric | ✓ |  |  |  |  |  |
| `diff` | TEXT | text |  |  |  |  |  |  |
| `status` | TEXT | enum |  |  |  |  | `'proposed'` | `['proposed', 'applied', 'reverted', 'rejected']` |
| `reverted_by_patch_id` | INTEGER | numeric | ✓ |  |  |  |  |  |

#### `packages/nexus/src/schema/code-index.ts`

##### `code_index` → `nexus_code_index`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `project_id` | TEXT | id |  |  |  |  |  |  |
| `file_path` | TEXT | text |  |  |  |  |  |  |
| `symbol_name` | TEXT | text |  |  |  |  |  |  |
| `kind` | TEXT | text |  |  |  |  |  | ⚠ enum-like TEXT 'kind' lacks { enum } / CHECK (col IN (...)) |
| `start_line` | INTEGER | numeric |  |  |  |  |  |  |
| `end_line` | INTEGER | numeric |  |  |  |  |  |  |
| `language` | TEXT | text |  |  |  |  |  |  |
| `exported` | INTEGER | boolean | ✓ |  |  |  | `false` |  |
| `parent` | TEXT | text | ✓ |  |  |  |  |  |
| `return_type` | TEXT | text | ✓ |  |  |  |  |  |
| `doc_summary` | TEXT | text | ✓ |  |  |  |  |  |
| `indexed_at` | TEXT | timestamp-text |  |  |  |  |  |  |

### Scope: `tasks` (target DB: `.cleo/tasks.db`)

#### `packages/core/src/agents/agent-schema.ts`

##### `agent_instances` → `tasks_agent_instances`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `agent_type` | TEXT | enum |  |  |  |  |  | `AGENT_TYPES` |
| `status` | TEXT | enum |  |  |  |  | `'starting'` | `AGENT_INSTANCE_STATUSES` |
| `session_id` | TEXT | id | ✓ |  |  |  |  |  |
| `task_id` | TEXT | id | ✓ |  |  |  |  |  |
| `started_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `last_heartbeat` | TEXT | text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `stopped_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `error_count` | INTEGER | numeric |  |  |  |  | `0` |  |
| `total_tasks_completed` | INTEGER | numeric |  |  |  |  | `0` |  |
| `capacity` | TEXT | text |  |  |  |  | `'1.0'` |  |
| `metadata_json` | TEXT | json | ✓ |  |  |  | `'{}'` | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `parent_agent_id` | TEXT | id | ✓ |  |  |  |  |  |

##### `agent_error_log` → `tasks_agent_error_log`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | INTEGER | numeric |  |  |  |  |  |  |
| `agent_id` | TEXT | id |  |  |  |  |  |  |
| `error_type` | TEXT | enum |  |  |  |  |  | `['retriable', 'permanent', 'unknown']` |
| `message` | TEXT | text |  |  |  |  |  |  |
| `stack` | TEXT | text | ✓ |  |  |  |  |  |
| `occurred_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `resolved` | INTEGER | boolean |  |  |  |  | `false` |  |

#### `packages/core/src/store/chain-schema.ts`

##### `warp_chains` → `tasks_warp_chains`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `name` | TEXT | text |  |  |  |  |  |  |
| `version` | TEXT | text |  |  |  |  |  |  |
| `description` | TEXT | text | ✓ |  |  |  |  |  |
| `definition` | TEXT | text |  |  |  |  |  |  |
| `validated` | INTEGER | boolean | ✓ |  |  |  | `false` |  |
| `created_at` | TEXT | timestamp-text | ✓ |  |  |  | `sql`(datetime('now'))`` |  |
| `updated_at` | TEXT | timestamp-text | ✓ |  |  |  | `sql`(datetime('now'))`` |  |

##### `warp_chain_instances` → `tasks_warp_chain_instances`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `chain_id` | TEXT | fk |  |  |  |  |  |  |
| `epic_id` | TEXT | id |  |  |  |  |  |  |
| `variables` | TEXT | text | ✓ |  |  |  |  |  |
| `stage_to_task` | TEXT | text | ✓ |  |  |  |  |  |
| `status` | TEXT | text |  |  |  |  | `'pending'` | ⚠ enum-like TEXT 'status' lacks { enum } / CHECK (col IN (...)) |
| `current_stage` | TEXT | text | ✓ |  |  |  |  |  |
| `gate_results` | TEXT | text | ✓ |  |  |  |  |  |
| `created_at` | TEXT | timestamp-text | ✓ |  |  |  | `sql`(datetime('now'))`` |  |
| `updated_at` | TEXT | timestamp-text | ✓ |  |  |  | `sql`(datetime('now'))`` |  |

#### `packages/core/src/store/conduit-schema.ts`

##### `conversations` → `conduit_conversations`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `participants` | TEXT | text |  |  |  |  |  |  |
| `visibility` | TEXT | text |  |  |  |  | `'private'` | ⚠ enum-like TEXT 'visibility' lacks { enum } / CHECK (col IN (...)) |
| `message_count` | INTEGER | numeric |  |  |  |  | `0` |  |
| `last_message_at` | INTEGER | timestamp-epoch | ✓ |  |  |  |  | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |
| `created_at` | INTEGER | timestamp-epoch |  |  |  |  |  | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |
| `updated_at` | INTEGER | timestamp-epoch |  |  |  |  |  | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |

##### `messages` → `conduit_messages`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `conversation_id` | TEXT | fk |  |  |  |  |  |  |
| `from_agent_id` | TEXT | id |  |  |  |  |  |  |
| `to_agent_id` | TEXT | id |  |  |  |  |  |  |
| `content` | TEXT | text |  |  |  |  |  |  |
| `content_type` | TEXT | text |  |  |  |  | `'text'` | ⚠ enum-like TEXT 'content_type' lacks { enum } / CHECK (col IN (...)) |
| `status` | TEXT | text |  |  |  |  | `'pending'` | ⚠ enum-like TEXT 'status' lacks { enum } / CHECK (col IN (...)) |
| `attachments` | TEXT | json |  |  |  |  | `'[]'` | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `group_id` | TEXT | id | ✓ |  |  |  |  |  |
| `metadata` | TEXT | json | ✓ |  |  |  | `'{}'` | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `reply_to` | TEXT | text | ✓ |  |  |  |  |  |
| `created_at` | INTEGER | timestamp-epoch |  |  |  |  |  | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |
| `delivered_at` | INTEGER | timestamp-epoch | ✓ |  |  |  |  | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |
| `read_at` | INTEGER | timestamp-epoch | ✓ |  |  |  |  | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |

##### `delivery_jobs` → `conduit_delivery_jobs`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `message_id` | TEXT | id |  |  |  |  |  |  |
| `payload` | TEXT | text |  |  |  |  |  |  |
| `status` | TEXT | text |  |  |  |  | `'pending'` | ⚠ enum-like TEXT 'status' lacks { enum } / CHECK (col IN (...)) |
| `attempts` | INTEGER | numeric |  |  |  |  | `0` |  |
| `max_attempts` | INTEGER | numeric |  |  |  |  | `6` |  |
| `next_attempt_at` | INTEGER | timestamp-epoch |  |  |  |  |  | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |
| `last_error` | TEXT | text | ✓ |  |  |  |  |  |
| `created_at` | INTEGER | timestamp-epoch |  |  |  |  |  | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |
| `updated_at` | INTEGER | timestamp-epoch |  |  |  |  |  | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |

##### `dead_letters` → `conduit_dead_letters`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `message_id` | TEXT | id |  |  |  |  |  |  |
| `job_id` | TEXT | id |  |  |  |  |  |  |
| `reason` | TEXT | text |  |  |  |  |  |  |
| `attempts` | INTEGER | numeric |  |  |  |  |  |  |
| `created_at` | INTEGER | timestamp-epoch |  |  |  |  |  | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |

##### `message_pins` → `conduit_message_pins`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `message_id` | TEXT | id |  |  |  |  |  |  |
| `conversation_id` | TEXT | id |  |  |  |  |  |  |
| `pinned_by` | TEXT | text |  |  |  |  |  |  |
| `note` | TEXT | text | ✓ |  |  |  |  |  |
| `created_at` | INTEGER | timestamp-epoch |  |  |  |  |  | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |

##### `attachments` → `conduit_attachments`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `slug` | TEXT | text |  |  |  |  |  |  |
| `conversation_id` | TEXT | id |  |  |  |  |  |  |
| `from_agent_id` | TEXT | id |  |  |  |  |  |  |
| `content` | BLOB | blob |  |  |  |  |  |  |
| `original_size` | INTEGER | numeric |  |  |  |  |  |  |
| `compressed_size` | INTEGER | numeric |  |  |  |  |  |  |
| `content_hash` | TEXT | text |  |  |  |  |  |  |
| `format` | TEXT | text |  |  |  |  | `'text'` |  |
| `title` | TEXT | text | ✓ |  |  |  |  |  |
| `tokens` | INTEGER | numeric |  |  |  |  | `0` |  |
| `expires_at` | INTEGER | timestamp-epoch |  |  |  |  | `0` | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |
| `storage_key` | TEXT | text | ✓ |  |  |  |  |  |
| `mode` | TEXT | text |  |  |  |  | `'draft'` | ⚠ enum-like TEXT 'mode' lacks { enum } / CHECK (col IN (...)) |
| `version_count` | INTEGER | numeric |  |  |  |  | `1` |  |
| `current_version` | INTEGER | numeric |  |  |  |  | `1` |  |
| `created_at` | INTEGER | timestamp-epoch |  |  |  |  |  | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |

##### `attachment_versions` → `conduit_attachment_versions`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `slug` | TEXT | fk |  |  |  |  |  |  |
| `version_number` | INTEGER | numeric |  |  |  |  |  |  |
| `author_agent_id` | TEXT | id |  |  |  |  |  |  |
| `change_type` | TEXT | text |  |  |  |  | `'patch'` | ⚠ enum-like TEXT 'change_type' lacks { enum } / CHECK (col IN (...)) |
| `patch_text` | TEXT | text | ✓ |  |  |  |  |  |
| `storage_key` | TEXT | text |  |  |  |  |  |  |
| `content_hash` | TEXT | text |  |  |  |  |  |  |
| `original_size` | INTEGER | numeric |  |  |  |  |  |  |
| `compressed_size` | INTEGER | numeric |  |  |  |  |  |  |
| `tokens` | INTEGER | numeric |  |  |  |  |  |  |
| `change_summary` | TEXT | text | ✓ |  |  |  |  |  |
| `sections_modified` | TEXT | json |  |  |  |  | `'[]'` | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `tokens_added` | INTEGER | numeric |  |  |  |  | `0` |  |
| `tokens_removed` | INTEGER | numeric |  |  |  |  | `0` |  |
| `created_at` | INTEGER | timestamp-epoch |  |  |  |  |  | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |

##### `attachment_approvals` → `conduit_attachment_approvals`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `slug` | TEXT | fk |  |  |  |  |  |  |
| `reviewer_agent_id` | TEXT | id |  |  |  |  |  |  |
| `status` | TEXT | text |  |  |  |  | `'pending'` | ⚠ enum-like TEXT 'status' lacks { enum } / CHECK (col IN (...)) |
| `comment` | TEXT | text | ✓ |  |  |  |  |  |
| `version_reviewed` | INTEGER | numeric |  |  |  |  |  |  |
| `created_at` | INTEGER | timestamp-epoch |  |  |  |  |  | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |
| `updated_at` | INTEGER | timestamp-epoch |  |  |  |  |  | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |

##### `attachment_contributors` → `conduit_attachment_contributors`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `slug` | TEXT | fk |  |  |  |  |  |  |
| `agent_id` | TEXT | id |  |  |  |  |  |  |
| `version_count` | INTEGER | numeric |  |  |  |  | `0` |  |
| `total_tokens_added` | INTEGER | numeric |  |  |  |  | `0` |  |
| `total_tokens_removed` | INTEGER | numeric |  |  |  |  | `0` |  |
| `first_contribution_at` | INTEGER | timestamp-epoch |  |  |  |  |  | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |
| `last_contribution_at` | INTEGER | timestamp-epoch |  |  |  |  |  | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |

##### `project_agent_refs` → `conduit_project_agent_refs`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `agent_id` | TEXT | id |  |  |  |  |  |  |
| `attached_at` | TEXT | timestamp-text |  |  |  |  |  |  |
| `role` | TEXT | text | ✓ |  |  |  |  | ⚠ enum-like TEXT 'role' lacks { enum } / CHECK (col IN (...)) |
| `capabilities_override` | TEXT | text | ✓ |  |  |  |  |  |
| `last_used_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `enabled` | INTEGER | boolean-untyped |  |  |  |  | `1` | ⚠ INTEGER boolean flag lacks { mode: "boolean" } + CHECK (col IN (0,1)) |

##### `topics` → `conduit_topics`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `name` | TEXT | text |  |  |  |  |  |  |
| `epic_id` | TEXT | id |  |  |  |  |  |  |
| `wave_id` | INTEGER | numeric | ✓ |  |  |  |  |  |
| `created_by` | TEXT | text |  |  |  |  |  |  |
| `created_at` | INTEGER | timestamp-epoch |  |  |  |  |  | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |

##### `topic_subscriptions` → `conduit_topic_subscriptions`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `topic_id` | TEXT | fk |  |  |  |  |  |  |
| `agent_id` | TEXT | id |  |  |  |  |  |  |
| `subscribed_at` | INTEGER | timestamp-epoch |  |  |  |  |  | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |

##### `topic_messages` → `conduit_topic_messages`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `topic_id` | TEXT | fk |  |  |  |  |  |  |
| `from_agent_id` | TEXT | id |  |  |  |  |  |  |
| `kind` | TEXT | text |  |  |  |  | `'message'` | ⚠ enum-like TEXT 'kind' lacks { enum } / CHECK (col IN (...)) |
| `content` | TEXT | text |  |  |  |  |  |  |
| `payload` | TEXT | text | ✓ |  |  |  |  |  |
| `created_at` | INTEGER | timestamp-epoch |  |  |  |  |  | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |

##### `topic_message_acks` → `conduit_topic_message_acks`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `message_id` | TEXT | fk |  |  |  |  |  |  |
| `subscriber_agent_id` | TEXT | id |  |  |  |  |  |  |
| `delivered_at` | INTEGER | timestamp-epoch | ✓ |  |  |  |  | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |
| `read_at` | INTEGER | timestamp-epoch | ✓ |  |  |  |  | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |

##### `_conduit_meta` → `_conduit_meta`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `key` | TEXT | text |  |  |  |  |  |  |
| `value` | TEXT | text |  |  |  |  |  |  |
| `updated_at` | INTEGER | timestamp-epoch |  |  |  |  | `sql`(strftime('%s', 'now'))`` | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |

##### `_conduit_migrations` → `_conduit_migrations`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `name` | TEXT | text |  |  |  |  |  |  |
| `applied_at` | INTEGER | timestamp-epoch |  |  |  |  | `sql`(strftime('%s', 'now'))`` | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |

#### `packages/core/src/store/schema/attachments.ts`

##### `attachments` → `docs_attachments`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `sha256` | TEXT | text |  |  |  |  |  |  |
| `attachment_json` | TEXT | json |  |  |  |  |  | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `created_at` | TEXT | timestamp-text |  |  |  |  |  |  |
| `ref_count` | INTEGER | numeric |  |  |  |  | `0` |  |
| `slug` | TEXT | text | ✓ |  |  |  |  |  |
| `type` | TEXT | text | ✓ |  |  |  |  | ⚠ enum-like TEXT 'type' lacks { enum } / CHECK (col IN (...)) |
| `lifecycle_status` | TEXT | enum |  |  |  |  | `'draft'` | `ATTACHMENT_LIFECYCLE_STATUSES` |
| `supersedes` | TEXT | fk | ✓ |  |  |  |  |  |
| `superseded_by` | TEXT | fk | ✓ |  |  |  |  |  |
| `summary` | TEXT | text | ✓ |  |  |  |  |  |
| `keywords` | TEXT | text | ✓ |  |  |  |  |  |
| `topics` | TEXT | text | ✓ |  |  |  |  |  |
| `related_tasks` | TEXT | text | ✓ |  |  |  |  |  |
| `owner_version` | TEXT | text | ✓ |  |  |  |  |  |
| `doc_version` | INTEGER | numeric |  |  |  |  | `1` |  |

##### `attachment_refs` → `docs_attachment_refs`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `attachment_id` | TEXT | id |  |  |  |  |  |  |
| `owner_type` | TEXT | enum |  |  |  |  |  | `ATTACHMENT_OWNER_TYPES` |
| `owner_id` | TEXT | id |  |  |  |  |  |  |
| `attached_at` | TEXT | timestamp-text |  |  |  |  |  |  |
| `attached_by` | TEXT | text | ✓ |  |  |  |  |  |

#### `packages/core/src/store/schema/audit.ts`

##### `schema_meta` → `tasks_schema_meta`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `key` | TEXT | text |  |  |  |  |  |  |
| `value` | TEXT | text |  |  |  |  |  |  |

##### `audit_log` → `tasks_audit_log`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `timestamp` | TEXT | text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `action` | TEXT | text |  |  |  |  |  |  |
| `task_id` | TEXT | id |  |  |  |  |  |  |
| `actor` | TEXT | text |  |  |  |  | `'system'` |  |
| `details_json` | TEXT | json | ✓ |  |  |  | `'{}'` | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `before_json` | TEXT | json | ✓ |  |  |  |  | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `after_json` | TEXT | json | ✓ |  |  |  |  | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `domain` | TEXT | text | ✓ |  |  |  |  |  |
| `operation` | TEXT | text | ✓ |  |  |  |  |  |
| `session_id` | TEXT | id | ✓ |  |  |  |  |  |
| `request_id` | TEXT | id | ✓ |  |  |  |  |  |
| `idempotency_key` | TEXT | text | ✓ |  |  |  |  |  |
| `duration_ms` | INTEGER | numeric | ✓ |  |  |  |  |  |
| `success` | INTEGER | numeric | ✓ |  |  |  |  |  |
| `source` | TEXT | text | ✓ |  |  |  |  |  |
| `gateway` | TEXT | text | ✓ |  |  |  |  |  |
| `error_message` | TEXT | text | ✓ |  |  |  |  |  |
| `project_hash` | TEXT | text | ✓ |  |  |  |  |  |

##### `token_usage` → `tasks_token_usage`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `created_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `provider` | TEXT | text |  |  |  |  | `'unknown'` |  |
| `model` | TEXT | text | ✓ |  |  |  |  |  |
| `transport` | TEXT | enum |  |  |  |  | `'unknown'` | `TOKEN_USAGE_TRANSPORTS` |
| `gateway` | TEXT | text | ✓ |  |  |  |  |  |
| `domain` | TEXT | text | ✓ |  |  |  |  |  |
| `operation` | TEXT | text | ✓ |  |  |  |  |  |
| `session_id` | TEXT | fk | ✓ |  |  |  |  |  |
| `task_id` | TEXT | fk | ✓ |  |  |  |  |  |
| `request_id` | TEXT | id | ✓ |  |  |  |  |  |
| `input_chars` | INTEGER | numeric |  |  |  |  | `0` |  |
| `output_chars` | INTEGER | numeric |  |  |  |  | `0` |  |
| `input_tokens` | INTEGER | numeric |  |  |  |  | `0` |  |
| `output_tokens` | INTEGER | numeric |  |  |  |  | `0` |  |
| `total_tokens` | INTEGER | numeric |  |  |  |  | `0` |  |
| `method` | TEXT | enum |  |  |  |  | `'heuristic'` | `TOKEN_USAGE_METHODS` |
| `confidence` | TEXT | enum |  |  |  |  | `'coarse'` | `TOKEN_USAGE_CONFIDENCE` |
| `request_hash` | TEXT | text | ✓ |  |  |  |  |  |
| `response_hash` | TEXT | text | ✓ |  |  |  |  |  |
| `metadata_json` | TEXT | json |  |  |  |  | `'{}'` | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |

##### `architecture_decisions` → `tasks_architecture_decisions`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `title` | TEXT | text |  |  |  |  |  |  |
| `status` | TEXT | enum |  |  |  |  | `'proposed'` | `ADR_STATUSES` |
| `supersedes_id` | TEXT | fk | ✓ |  |  |  |  |  |
| `superseded_by_id` | TEXT | fk | ✓ |  |  |  |  |  |
| `consensus_manifest_id` | TEXT | fk | ✓ |  |  |  |  |  |
| `content` | TEXT | text |  |  |  |  |  |  |
| `created_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `updated_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `date` | TEXT | text |  |  |  |  | `''` |  |
| `accepted_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `gate` | TEXT | enum | ✓ |  |  |  |  | `['HITL', 'automated']` |
| `gate_status` | TEXT | enum | ✓ |  |  |  |  | `GATE_STATUSES` |
| `amends_id` | TEXT | fk | ✓ |  |  |  |  |  |
| `file_path` | TEXT | text |  |  |  |  | `''` |  |
| `summary` | TEXT | text | ✓ |  |  |  |  |  |
| `keywords` | TEXT | text | ✓ |  |  |  |  |  |
| `topics` | TEXT | text | ✓ |  |  |  |  |  |

##### `adr_task_links` → `tasks_adr_task_links`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `adr_id` | TEXT | fk |  |  |  |  |  |  |
| `task_id` | TEXT | fk |  |  |  |  |  |  |
| `link_type` | TEXT | enum |  |  |  |  | `'related'` | `['related', 'governed_by', 'implements']` |

##### `adr_relations` → `tasks_adr_relations`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `from_adr_id` | TEXT | fk |  |  |  |  |  |  |
| `to_adr_id` | TEXT | fk |  |  |  |  |  |  |
| `relation_type` | TEXT | enum |  |  |  |  |  | `['supersedes', 'amends', 'related']` |

##### `status_registry` → `tasks_status_registry`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `name` | TEXT | text |  |  |  |  |  |  |
| `entity_type` | TEXT | enum |  |  |  |  |  | `['task', 'session', 'lifecycle_pipeline', 'lifecycle_stage', 'adr', 'gate', 'manifest']` |
| `namespace` | TEXT | enum |  |  |  |  |  | `['workflow', 'governance', 'manifest']` |
| `description` | TEXT | text |  |  |  |  |  |  |
| `is_terminal` | INTEGER | boolean |  |  |  |  | `false` |  |

#### `packages/core/src/store/schema/background-jobs.ts`

##### `background_jobs` → `tasks_background_jobs`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `operation` | TEXT | text |  |  |  |  |  |  |
| `status` | TEXT | enum |  |  |  |  | `'pending'` | `BACKGROUND_JOB_STATUSES` |
| `started_at` | INTEGER | timestamp-epoch |  |  |  |  |  | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |
| `completed_at` | INTEGER | timestamp-epoch | ✓ |  |  |  |  | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |
| `result` | TEXT | text | ✓ |  |  |  |  |  |
| `error` | TEXT | text | ✓ |  |  |  |  |  |
| `progress` | INTEGER | numeric | ✓ |  |  |  |  |  |
| `heartbeat_at` | INTEGER | timestamp-epoch |  |  |  |  |  | ⚠ INTEGER epoch timestamp — target canonical form is TEXT ISO8601 + CHECK |
| `claimed_by` | TEXT | text | ✓ |  |  |  |  |  |

#### `packages/core/src/store/schema/evidence-bindings.ts`

##### `evidence_ac_bindings` → `tasks_evidence_ac_bindings`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `evidence_atom_id` | TEXT | id |  |  |  |  |  |  |
| `ac_id` | TEXT | id |  |  |  |  |  |  |
| `binding_type` | TEXT | enum |  |  |  |  |  | `EVIDENCE_BINDING_TYPES` |
| `created_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |

#### `packages/core/src/store/schema/experiments.ts`

##### `experiments` → `tasks_experiments`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `task_id` | TEXT | id |  |  |  |  |  |  |
| `sandbox_branch` | TEXT | text | ✓ |  |  |  |  |  |
| `baseline_commit` | TEXT | text | ✓ |  |  |  |  |  |
| `merged_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `receipt_id` | TEXT | id | ✓ |  |  |  |  |  |
| `metrics_delta_json` | TEXT | json | ✓ |  |  |  |  | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `created_at` | TEXT | timestamp-text |  |  |  |  |  |  |
| `updated_at` | TEXT | timestamp-text |  |  |  |  |  |  |

#### `packages/core/src/store/schema/lifecycle.ts`

##### `lifecycle_pipelines` → `tasks_lifecycle_pipelines`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `task_id` | TEXT | fk |  |  |  |  |  |  |
| `status` | TEXT | enum |  |  |  |  | `'active'` | `LIFECYCLE_PIPELINE_STATUSES` |
| `current_stage_id` | TEXT | id | ✓ |  |  |  |  |  |
| `started_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `completed_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `updated_at` | TEXT | timestamp-text | ✓ |  |  |  | `sql`(datetime('now'))`` |  |
| `version` | INTEGER | numeric |  |  |  |  | `1` |  |

##### `lifecycle_stages` → `tasks_lifecycle_stages`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `pipeline_id` | TEXT | fk |  |  |  |  |  |  |
| `stage_name` | TEXT | enum |  |  |  |  |  | `LIFECYCLE_STAGE_NAMES` |
| `status` | TEXT | enum |  |  |  |  | `'not_started'` | `LIFECYCLE_STAGE_STATUSES` |
| `sequence` | INTEGER | numeric |  |  |  |  |  |  |
| `started_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `completed_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `blocked_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `block_reason` | TEXT | text | ✓ |  |  |  |  |  |
| `skipped_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `skip_reason` | TEXT | text | ✓ |  |  |  |  |  |
| `notes_json` | TEXT | json | ✓ |  |  |  | `'[]'` | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `metadata_json` | TEXT | json | ✓ |  |  |  | `'{}'` | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `output_file` | TEXT | text | ✓ |  |  |  |  |  |
| `created_by` | TEXT | text | ✓ |  |  |  |  |  |
| `validated_by` | TEXT | text | ✓ |  |  |  |  |  |
| `validated_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `validation_status` | TEXT | enum | ✓ |  |  |  |  | `['pending', 'in_review', 'approved', 'rejected', 'needs_revision']` |
| `provenance_chain_json` | TEXT | json | ✓ |  |  |  |  | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |

##### `lifecycle_gate_results` → `tasks_lifecycle_gate_results`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `stage_id` | TEXT | fk |  |  |  |  |  |  |
| `gate_name` | TEXT | text |  |  |  |  |  |  |
| `result` | TEXT | enum |  |  |  |  |  | `LIFECYCLE_GATE_RESULTS` |
| `checked_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `checked_by` | TEXT | text |  |  |  |  |  |  |
| `details` | TEXT | text | ✓ |  |  |  |  |  |
| `reason` | TEXT | text | ✓ |  |  |  |  |  |

##### `lifecycle_evidence` → `tasks_lifecycle_evidence`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `stage_id` | TEXT | fk |  |  |  |  |  |  |
| `uri` | TEXT | text |  |  |  |  |  |  |
| `type` | TEXT | enum |  |  |  |  |  | `LIFECYCLE_EVIDENCE_TYPES` |
| `recorded_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `recorded_by` | TEXT | text | ✓ |  |  |  |  |  |
| `description` | TEXT | text | ✓ |  |  |  |  |  |

##### `lifecycle_transitions` → `tasks_lifecycle_transitions`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `pipeline_id` | TEXT | fk |  |  |  |  |  |  |
| `from_stage_id` | TEXT | fk |  |  |  |  |  |  |
| `to_stage_id` | TEXT | fk |  |  |  |  |  |  |
| `transition_type` | TEXT | enum |  |  |  |  | `'automatic'` | `LIFECYCLE_TRANSITION_TYPES` |
| `transitioned_by` | TEXT | text | ✓ |  |  |  |  |  |
| `created_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |

#### `packages/core/src/store/schema/manifest.ts`

##### `manifest_entries` → `docs_manifest_entries`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `pipeline_id` | TEXT | fk | ✓ |  |  |  |  |  |
| `stage_id` | TEXT | fk | ✓ |  |  |  |  |  |
| `title` | TEXT | text |  |  |  |  |  |  |
| `date` | TEXT | text |  |  |  |  |  |  |
| `status` | TEXT | enum |  |  |  |  |  | `MANIFEST_STATUSES` |
| `agent_type` | TEXT | text | ✓ |  |  |  |  |  |
| `output_file` | TEXT | text | ✓ |  |  |  |  |  |
| `topics_json` | TEXT | json | ✓ |  |  |  | `'[]'` | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `findings_json` | TEXT | json | ✓ |  |  |  | `'[]'` | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `linked_tasks_json` | TEXT | json | ✓ |  |  |  | `'[]'` | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `created_by` | TEXT | text | ✓ |  |  |  |  |  |
| `created_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |

##### `pipeline_manifest` → `docs_pipeline_manifest`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `session_id` | TEXT | fk | ✓ |  |  |  |  |  |
| `task_id` | TEXT | fk | ✓ |  |  |  |  |  |
| `epic_id` | TEXT | fk | ✓ |  |  |  |  |  |
| `type` | TEXT | text |  |  |  |  |  | ⚠ enum-like TEXT 'type' lacks { enum } / CHECK (col IN (...)) |
| `content` | TEXT | text |  |  |  |  |  |  |
| `content_hash` | TEXT | text | ✓ |  |  |  |  |  |
| `status` | TEXT | text |  |  |  |  | `'active'` | ⚠ enum-like TEXT 'status' lacks { enum } / CHECK (col IN (...)) |
| `distilled` | INTEGER | boolean |  |  |  |  | `false` |  |
| `brain_obs_id` | TEXT | id | ✓ |  |  |  |  |  |
| `source_file` | TEXT | text | ✓ |  |  |  |  |  |
| `metadata_json` | TEXT | json | ✓ |  |  |  |  | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `created_at` | TEXT | timestamp-text |  |  |  |  |  |  |
| `archived_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |

#### `packages/core/src/store/schema/provenance/commits.ts`

##### `commits` → `tasks_commits`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `sha` | TEXT | text |  |  |  |  |  |  |
| `short_sha` | TEXT | text |  |  |  |  |  |  |
| `author_name` | TEXT | text | ✓ |  |  |  |  |  |
| `author_email` | TEXT | text | ✓ |  |  |  |  |  |
| `authored_at` | TEXT | timestamp-text |  |  |  |  |  |  |
| `committer_name` | TEXT | text | ✓ |  |  |  |  |  |
| `committer_email` | TEXT | text | ✓ |  |  |  |  |  |
| `committed_at` | TEXT | timestamp-text |  |  |  |  |  |  |
| `message` | TEXT | text |  |  |  |  |  |  |
| `subject` | TEXT | text |  |  |  |  |  |  |
| `conventional_type` | TEXT | text | ✓ |  |  |  |  |  |
| `is_release_commit` | INTEGER | boolean-untyped |  |  |  |  | `0` | ⚠ INTEGER boolean flag lacks { mode: "boolean" } + CHECK (col IN (0,1)) |
| `is_merge_commit` | INTEGER | boolean-untyped |  |  |  |  | `0` | ⚠ INTEGER boolean flag lacks { mode: "boolean" } + CHECK (col IN (0,1)) |
| `parent_shas` | TEXT | json |  |  |  |  | `'[]'` | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `signature_verified` | INTEGER | numeric | ✓ |  |  |  |  |  |
| `branch_at_commit` | TEXT | text | ✓ |  |  |  |  |  |
| `project_hash` | TEXT | text | ✓ |  |  |  |  |  |
| `created_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |

##### `task_commits` → `tasks_task_commits`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `task_id` | TEXT | fk | ✓ |  |  |  |  |  |
| `commit_sha` | TEXT | fk |  |  |  |  |  |  |
| `link_kind` | TEXT | text |  |  |  |  |  |  |
| `link_source` | TEXT | text |  |  |  |  |  |  |
| `created_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |

##### `commit_files` → `tasks_commit_files`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `commit_sha` | TEXT | fk |  |  |  |  |  |  |
| `path` | TEXT | text |  |  |  |  |  |  |
| `old_path` | TEXT | text | ✓ |  |  |  |  |  |
| `change_type` | TEXT | text |  |  |  |  |  | ⚠ enum-like TEXT 'change_type' lacks { enum } / CHECK (col IN (...)) |
| `lines_added` | INTEGER | numeric |  |  |  |  | `0` |  |
| `lines_deleted` | INTEGER | numeric |  |  |  |  | `0` |  |
| `is_binary` | INTEGER | boolean-untyped |  |  |  |  | `0` | ⚠ INTEGER boolean flag lacks { mode: "boolean" } + CHECK (col IN (0,1)) |

#### `packages/core/src/store/schema/provenance/pull-requests.ts`

##### `pull_requests` → `tasks_pull_requests`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `pr_number` | INTEGER | numeric |  |  |  |  |  |  |
| `repo_url` | TEXT | text |  |  |  |  |  |  |
| `title` | TEXT | text |  |  |  |  |  |  |
| `body` | TEXT | text | ✓ |  |  |  |  |  |
| `state` | TEXT | text |  |  |  |  |  | ⚠ enum-like TEXT 'state' lacks { enum } / CHECK (col IN (...)) |
| `base_ref` | TEXT | text |  |  |  |  |  |  |
| `head_ref` | TEXT | text |  |  |  |  |  |  |
| `head_sha` | TEXT | fk | ✓ |  |  |  |  |  |
| `merge_commit_sha` | TEXT | fk | ✓ |  |  |  |  |  |
| `author_login` | TEXT | text | ✓ |  |  |  |  |  |
| `opened_at` | TEXT | timestamp-text |  |  |  |  |  |  |
| `merged_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `closed_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `is_release_pr` | INTEGER | boolean-untyped |  |  |  |  | `0` | ⚠ INTEGER boolean flag lacks { mode: "boolean" } + CHECK (col IN (0,1)) |
| `release_version` | TEXT | text | ✓ |  |  |  |  |  |
| `is_bump_only` | INTEGER | boolean-untyped |  |  |  |  | `0` | ⚠ INTEGER boolean flag lacks { mode: "boolean" } + CHECK (col IN (0,1)) |
| `project_hash` | TEXT | text | ✓ |  |  |  |  |  |
| `created_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `updated_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |

##### `pr_commits` → `tasks_pr_commits`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `pr_id` | TEXT | fk |  |  |  |  |  |  |
| `commit_sha` | TEXT | fk |  |  |  |  |  |  |
| `position` | INTEGER | numeric |  |  |  |  |  |  |

##### `pr_tasks` → `tasks_pr_tasks`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `pr_id` | TEXT | fk |  |  |  |  |  |  |
| `task_id` | TEXT | fk | ✓ |  |  |  |  |  |
| `link_source` | TEXT | text |  |  |  |  |  |  |
| `link_kind` | TEXT | text |  |  |  |  |  |  |
| `created_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |

#### `packages/core/src/store/schema/provenance/releases.ts`

##### `releases` → `tasks_releases`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `version` | TEXT | text |  |  |  |  |  |  |
| `scheme` | TEXT | enum |  |  |  |  | `'calver'` | `RELEASE_SCHEMES` |
| `channel` | TEXT | enum |  |  |  |  | `'latest'` | `RELEASE_CHANNELS` |
| `epic_id` | TEXT | fk | ✓ |  |  |  |  |  |
| `release_kind` | TEXT | enum |  |  |  |  | `'regular'` | `RELEASE_KINDS` |
| `status` | TEXT | enum |  |  |  |  | `'planned'` | `RELEASE_STATUSES` |
| `previous_version` | TEXT | text | ✓ |  |  |  |  |  |
| `merge_commit_sha` | TEXT | fk | ✓ |  |  |  |  |  |
| `pr_id` | TEXT | id | ✓ |  |  |  |  |  |
| `workflow_run_url` | TEXT | text | ✓ |  |  |  |  |  |
| `created_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `planned_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `pr_opened_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `pr_merged_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `published_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `reconciled_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `rolled_back_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `failed_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `cancelled_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `failure_reason` | TEXT | text | ✓ |  |  |  |  |  |
| `rolled_back_by` | TEXT | text | ✓ |  |  |  |  |  |
| `project_hash` | TEXT | text | ✓ |  |  |  |  |  |
| `tasks_json` | TEXT | json | ✓ |  |  |  |  | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `changelog` | TEXT | text | ✓ |  |  |  |  |  |
| `notes` | TEXT | text | ✓ |  |  |  |  |  |
| `git_tag` | TEXT | text | ✓ |  |  |  |  |  |
| `prepared_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `committed_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `tagged_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `pushed_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |

##### `release_commits` → `tasks_release_commits`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `release_id` | TEXT | fk |  |  |  |  |  |  |
| `commit_sha` | TEXT | fk |  |  |  |  |  |  |
| `position` | INTEGER | numeric |  |  |  |  |  |  |
| `is_first` | INTEGER | boolean-untyped |  |  |  |  | `0` | ⚠ INTEGER boolean flag lacks { mode: "boolean" } + CHECK (col IN (0,1)) |
| `is_last` | INTEGER | boolean-untyped |  |  |  |  | `0` | ⚠ INTEGER boolean flag lacks { mode: "boolean" } + CHECK (col IN (0,1)) |
| `is_release_chore` | INTEGER | boolean-untyped |  |  |  |  | `0` | ⚠ INTEGER boolean flag lacks { mode: "boolean" } + CHECK (col IN (0,1)) |

##### `release_changes` → `tasks_release_changes`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `release_id` | TEXT | fk |  |  |  |  |  |  |
| `task_id` | TEXT | fk | ✓ |  |  |  |  |  |
| `change_type` | TEXT | enum |  |  |  |  |  | `RELEASE_CHANGE_TYPES` |
| `summary` | TEXT | text |  |  |  |  |  |  |
| `description` | TEXT | text | ✓ |  |  |  |  |  |
| `impact` | TEXT | enum |  |  |  |  | `'patch'` | `RELEASE_IMPACTS` |
| `classified_by` | TEXT | enum |  |  |  |  | `'auto'` | `RELEASE_CLASSIFIED_BY` |
| `classified_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |

##### `release_changesets` → `tasks_release_changesets`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `release_id` | TEXT | fk |  |  |  |  |  |  |
| `changeset_id` | TEXT | id |  |  |  |  |  |  |
| `task_ids` | TEXT | text |  |  |  |  |  |  |
| `kind` | TEXT | text |  |  |  |  |  | ⚠ enum-like TEXT 'kind' lacks { enum } / CHECK (col IN (...)) |
| `summary` | TEXT | text |  |  |  |  |  |  |
| `prs` | TEXT | text | ✓ |  |  |  |  |  |
| `notes` | TEXT | text | ✓ |  |  |  |  |  |
| `breaking` | TEXT | text | ✓ |  |  |  |  |  |
| `created_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |

##### `release_artifacts` → `tasks_release_artifacts`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `release_id` | TEXT | fk |  |  |  |  |  |  |
| `artifact_type` | TEXT | text |  |  |  |  |  |  |
| `identifier` | TEXT | text |  |  |  |  |  |  |
| `version` | TEXT | text |  |  |  |  |  |  |
| `url` | TEXT | text | ✓ |  |  |  |  |  |
| `published_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `metadata` | TEXT | json |  |  |  |  | `'{}'` | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |

##### `brain_release_links` → `brain_release_links`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `brain_entry_id` | TEXT | id | ✓ |  |  |  |  |  |
| `release_id` | TEXT | fk |  |  |  |  |  |  |
| `link_type` | TEXT | enum |  |  |  |  |  | `BRAIN_RELEASE_LINK_TYPES` |
| `created_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `created_by` | TEXT | text | ✓ |  |  |  |  |  |

#### `packages/core/src/store/schema/tasks.ts`

##### `tasks` → `tasks_tasks`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `title` | TEXT | text |  |  |  |  |  |  |
| `description` | TEXT | text | ✓ |  |  |  |  |  |
| `status` | TEXT | enum |  |  |  |  | `'pending'` | `TASK_STATUSES` |
| `priority` | TEXT | enum |  |  |  |  | `'medium'` | `TASK_PRIORITIES` |
| `type` | TEXT | enum | ✓ |  |  |  |  | `TASK_TYPES` |
| `role` | TEXT | enum |  |  |  |  | `'work'` | `TASK_KINDS` |
| `scope` | TEXT | enum |  |  |  |  | `'feature'` | `TASK_SCOPES` |
| `severity` | TEXT | enum | ✓ |  |  |  |  | `TASK_SEVERITIES` |
| `parent_id` | TEXT | fk | ✓ |  |  |  |  |  |
| `phase` | TEXT | text | ✓ |  |  |  |  |  |
| `size` | TEXT | enum | ✓ |  |  |  |  | `TASK_SIZES` |
| `position` | INTEGER | numeric | ✓ |  |  |  |  |  |
| `position_version` | INTEGER | numeric | ✓ |  |  |  | `0` |  |
| `labels_json` | TEXT | json | ✓ |  |  |  | `'[]'` | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `notes_json` | TEXT | json | ✓ |  |  |  | `'[]'` | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `acceptance_json` | TEXT | json | ✓ |  |  |  | `'[]'` | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `files_json` | TEXT | json | ✓ |  |  |  | `'[]'` | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `origin` | TEXT | text | ✓ |  |  |  |  |  |
| `blocked_by` | TEXT | text | ✓ |  |  |  |  |  |
| `epic_lifecycle` | TEXT | text | ✓ |  |  |  |  |  |
| `no_auto_complete` | INTEGER | boolean | ✓ |  |  |  |  |  |
| `created_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `updated_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `completed_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `cancelled_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `cancellation_reason` | TEXT | text | ✓ |  |  |  |  |  |
| `archived_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `archive_reason` | TEXT | text | ✓ |  |  |  |  |  |
| `cycle_time_days` | INTEGER | numeric | ✓ |  |  |  |  |  |
| `verification_json` | TEXT | json | ✓ |  |  |  |  | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `created_by` | TEXT | text | ✓ |  |  |  |  |  |
| `modified_by` | TEXT | text | ✓ |  |  |  |  |  |
| `session_id` | TEXT | fk | ✓ |  |  |  |  |  |
| `pipeline_stage` | TEXT | text | ✓ |  |  |  |  |  |
| `assignee` | TEXT | text | ✓ |  |  |  |  |  |
| `ivtr_state` | TEXT | text | ✓ |  |  |  |  |  |

##### `task_acceptance_criteria` → `tasks_task_acceptance_criteria`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `task_id` | TEXT | fk |  |  |  |  |  |  |
| `ordinal` | INTEGER | numeric |  |  |  |  |  |  |
| `kind` | TEXT | enum |  |  |  |  | `'text'` | `['text', 'child_task', 'evidence_bound']` |
| `source_key` | TEXT | text | ✓ |  |  |  |  |  |
| `target_task_id` | TEXT | fk | ✓ |  |  |  |  |  |
| `projection` | TEXT | text |  |  |  |  | `'legacy'` |  |
| `text` | TEXT | text |  |  |  |  |  |  |
| `created_at` | TEXT | timestamp-text |  |  |  |  | `sql`(CURRENT_TIMESTAMP)`` |  |
| `updated_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `content_hash` | TEXT | text | ✓ |  |  |  |  |  |

##### `acceptance_projection_state` → `tasks_acceptance_projection_state`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `projection_key` | TEXT | text |  |  |  |  |  |  |
| `schema_version` | INTEGER | numeric |  |  |  |  | `1` |  |
| `status` | TEXT | enum |  |  |  |  | `'fresh'` | `ACCEPTANCE_PROJECTION_STATUSES` |
| `last_projected_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `last_source_updated_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `source_fingerprint` | TEXT | text | ✓ |  |  |  |  |  |
| `created_at` | TEXT | timestamp-text |  |  |  |  | `sql`(CURRENT_TIMESTAMP)`` |  |
| `updated_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |

##### `acceptance_projection_dirty` → `tasks_acceptance_projection_dirty`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `projection_key` | TEXT | fk |  |  |  |  |  |  |
| `task_id` | TEXT | fk |  |  |  |  |  |  |
| `reason` | TEXT | enum |  |  |  |  | `'manual_rebuild'` | `ACCEPTANCE_PROJECTION_DIRTY_REASONS` |
| `source_updated_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `queued_at` | TEXT | timestamp-text |  |  |  |  | `sql`(CURRENT_TIMESTAMP)`` |  |
| `payload_json` | TEXT | json | ✓ |  |  |  |  | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |

##### `task_dependencies` → `tasks_task_dependencies`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `task_id` | TEXT | fk |  |  |  |  |  |  |
| `depends_on` | TEXT | fk |  |  |  |  |  |  |

##### `task_relations` → `tasks_task_relations`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `task_id` | TEXT | fk |  |  |  |  |  |  |
| `related_to` | TEXT | fk |  |  |  |  |  |  |
| `relation_type` | TEXT | enum |  |  |  |  | `'related'` | `TASK_RELATION_TYPES` |
| `reason` | TEXT | text | ✓ |  |  |  |  |  |

##### `sessions` → `tasks_sessions`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `name` | TEXT | text |  |  |  |  |  |  |
| `status` | TEXT | enum |  |  |  |  | `'active'` | `SESSION_STATUSES` |
| `scope_json` | TEXT | json |  |  |  |  | `'{}'` | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `current_task` | TEXT | fk | ✓ |  |  |  |  |  |
| `task_started_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `agent` | TEXT | text | ✓ |  |  |  |  |  |
| `notes_json` | TEXT | json | ✓ |  |  |  | `'[]'` | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `tasks_completed_json` | TEXT | json | ✓ |  |  |  | `'[]'` | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `tasks_created_json` | TEXT | json | ✓ |  |  |  | `'[]'` | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `handoff_json` | TEXT | json | ✓ |  |  |  |  | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `started_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `ended_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `previous_session_id` | TEXT | fk | ✓ |  |  |  |  |  |
| `next_session_id` | TEXT | fk | ✓ |  |  |  |  |  |
| `agent_identifier` | TEXT | text | ✓ |  |  |  |  |  |
| `handoff_consumed_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `handoff_consumed_by` | TEXT | text | ✓ |  |  |  |  |  |
| `debrief_json` | TEXT | json | ✓ |  |  |  |  | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `provider_id` | TEXT | id | ✓ |  |  |  |  |  |
| `stats_json` | TEXT | json | ✓ |  |  |  |  | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `resume_count` | INTEGER | numeric | ✓ |  |  |  |  |  |
| `grade_mode` | INTEGER | boolean-untyped | ✓ |  |  |  |  | ⚠ INTEGER boolean flag lacks { mode: "boolean" } + CHECK (col IN (0,1)) |
| `owner_auth_token` | TEXT | text | ✓ |  |  |  |  |  |
| `agent_handle` | TEXT | text | ✓ |  |  |  |  |  |
| `scope_kind` | TEXT | text | ✓ |  |  |  |  |  |
| `scope_id` | TEXT | id | ✓ |  |  |  |  |  |
| `last_activity` | TEXT | text | ✓ |  |  |  |  |  |

##### `session_handoff_entries` → `tasks_session_handoff_entries`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | INTEGER | numeric |  |  |  |  |  |  |
| `session_id` | TEXT | fk |  |  |  |  |  |  |
| `handoff_json` | TEXT | json |  |  |  |  |  | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `created_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |

##### `task_work_history` → `tasks_task_work_history`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | INTEGER | numeric |  |  |  |  |  |  |
| `session_id` | TEXT | fk |  |  |  |  |  |  |
| `task_id` | TEXT | fk |  |  |  |  |  |  |
| `set_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `cleared_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |

##### `task_acceptance_criteria_history` → `tasks_task_acceptance_criteria_history`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | INTEGER | numeric |  |  |  |  |  |  |
| `ac_id` | TEXT | id |  |  |  |  |  |  |
| `recorded_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `previous_text` | TEXT | text |  |  |  |  |  |  |
| `reason` | TEXT | text |  |  |  |  |  |  |

##### `external_task_links` → `tasks_external_task_links`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `task_id` | TEXT | fk |  |  |  |  |  |  |
| `provider_id` | TEXT | id |  |  |  |  |  |  |
| `external_id` | TEXT | id |  |  |  |  |  |  |
| `external_url` | TEXT | text | ✓ |  |  |  |  |  |
| `external_title` | TEXT | text | ✓ |  |  |  |  |  |
| `link_type` | TEXT | enum |  |  |  |  |  | `EXTERNAL_LINK_TYPES` |
| `sync_direction` | TEXT | enum |  |  |  |  | `'inbound'` | `SYNC_DIRECTIONS` |
| `metadata_json` | TEXT | json | ✓ |  |  |  | `'{}'` | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `linked_at` | TEXT | timestamp-text |  |  |  |  | `sql`(datetime('now'))`` |  |
| `last_sync_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |

#### `packages/core/src/telemetry/schema.ts`

##### `telemetry_events` → `telemetry_events`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `id` | TEXT | id |  |  |  |  |  |  |
| `anonymous_id` | TEXT | id |  |  |  |  |  |  |
| `domain` | TEXT | text |  |  |  |  |  |  |
| `gateway` | TEXT | text |  |  |  |  |  |  |
| `operation` | TEXT | text |  |  |  |  |  |  |
| `command` | TEXT | text |  |  |  |  |  |  |
| `exit_code` | INTEGER | numeric |  |  |  |  | `0` |  |
| `duration_ms` | INTEGER | numeric |  |  |  |  |  |  |
| `error_code` | TEXT | text | ✓ |  |  |  |  |  |
| `timestamp` | TEXT | text |  |  |  |  | `sql`(datetime('now'))`` |  |

##### `telemetry_schema_meta` → `telemetry_schema_meta`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `key` | TEXT | text |  |  |  |  |  |  |
| `value` | TEXT | text |  |  |  |  |  |  |

#### `packages/playbooks/src/schema.ts`

##### `playbook_runs` → `tasks_playbook_runs`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `run_id` | TEXT | id |  |  |  |  |  |  |
| `playbook_name` | TEXT | text |  |  |  |  |  |  |
| `playbook_hash` | TEXT | text |  |  |  |  |  |  |
| `current_node` | TEXT | text | ✓ |  |  |  |  |  |
| `bindings` | TEXT | json |  |  |  |  | `'{}'` | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `error_context` | TEXT | text | ✓ |  |  |  |  |  |
| `status` | TEXT | text |  |  |  |  | `'running'` | ⚠ enum-like TEXT 'status' lacks { enum } / CHECK (col IN (...)) |
| `iteration_counts` | TEXT | json |  |  |  |  | `'{}'` | ⚠ JSON-in-TEXT — needs write-time validator or json1 read assertion (T11330) |
| `epic_id` | TEXT | id | ✓ |  |  |  |  |  |
| `session_id` | TEXT | id | ✓ |  |  |  |  |  |
| `started_at` | TEXT | timestamp-text |  |  |  |  | `"(datetime('now'))"` |  |
| `completed_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |

##### `playbook_approvals` → `tasks_playbook_approvals`

| column | affinity | semantic type | null | PK | UQ | FK | default | enum / non-conformer |
|---|---|---|:--:|:--:|:--:|:--:|---|---|
| `approval_id` | TEXT | id |  |  |  |  |  |  |
| `run_id` | TEXT | id |  |  |  |  |  |  |
| `node_id` | TEXT | id |  |  |  |  |  |  |
| `token` | TEXT | text |  |  |  |  |  |  |
| `requested_at` | TEXT | timestamp-text |  |  |  |  | `"(datetime('now'))"` |  |
| `approved_at` | TEXT | timestamp-text | ✓ |  |  |  |  |  |
| `approver` | TEXT | text | ✓ |  |  |  |  |  |
| `reason` | TEXT | text | ✓ |  |  |  |  |  |
| `status` | TEXT | text |  |  |  |  | `'pending'` | ⚠ enum-like TEXT 'status' lacks { enum } / CHECK (col IN (...)) |
| `auto_passed` | INTEGER | boolean-untyped |  |  |  |  | `0` | ⚠ INTEGER boolean flag lacks { mode: "boolean" } + CHECK (col IN (0,1)) |


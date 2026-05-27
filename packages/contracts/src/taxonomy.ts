/**
 * Canonical Taxonomy Registry (T11186).
 *
 * Single source of truth for classification tags across decisions,
 * documents, tasks, and routing surfaces. Unifies the previously
 * fragmented vocabularies:
 *
 * - `BRAIN_DECISION_TYPES`   (memory-schema.ts) — 5 values
 * - `BRAIN_DECISION_CATEGORIES` (memory-schema.ts) — 3 values
 * - `BrainCognitiveType`      (brain.ts) — 3 values
 * - `BUILTIN_DOC_KINDS`       (docs-taxonomy.ts) — 10 values
 * - `labels_json`             (tasks schema) — free-form, 30+ ad-hoc labels
 * - `BrainEdgeKind`           (operations/brain.ts) — open-ended
 * - `BRAIN_PATTERN_TYPES`     (memory-schema.ts) — 5 values
 * - `BRAIN_OBSERVATION_TYPES` (memory-schema.ts) — 8 values
 *
 * The taxonomy is organized into **axes** — each tag is classified
 * by what dimension of classification it represents. A single tag
 * may belong to multiple axes (e.g., `adr` is both a doc_kind and
 * a decision type).
 *
 * ## Axes
 *
 * | Axis        | Purpose                                      |
 * |-------------|----------------------------------------------|
 * | `domain`    | Architectural subsystem or component area     |
 * | `type`      | Kind of artifact, decision, or entry          |
 * | `lifecycle` | Phase in the RCASD→IVTR pipeline              |
 * | `priority`  | Severity, urgency, or importance              |
 * | `doc_kind`  | Document classification (absorbs docs-taxonomy)|
 *
 * @task    T11186
 * @epic    T10520
 * @saga    T10516
 * @see     ADR-073 §1 — Task Hierarchy Charter
 * @see     packages/contracts/src/docs-taxonomy.ts — absorbed doc-kind subset
 */

// ---------------------------------------------------------------------------
// Tag metadata interface
// ---------------------------------------------------------------------------

/** Allowed tag axis values. */
export type TaxonomyAxis =
  | 'domain'
  | 'type'
  | 'lifecycle'
  | 'priority'
  | 'doc_kind';

/**
 * Metadata for a single canonical tag in the unified taxonomy.
 */
export interface CanonicalTagMetadata {
  /** Canonical tag id, lowercase kebab-case. */
  readonly tag: string;
  /** Human label for display in CLI output and UIs. */
  readonly label: string;
  /** One-line description. */
  readonly description: string;
  /** Which classification axes this tag belongs to. */
  readonly axes: ReadonlyArray<TaxonomyAxis>;
  /**
   * Ad-hoc labels from tasks.labels_json that normalize to this tag.
   * Used by the backfill script.
   */
  readonly adhocAliases: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Built-in canonical tags
// ---------------------------------------------------------------------------

/**
 * Every canonical tag known to the system.
 *
 * Adding a tag here automatically makes it available for decisions,
 * task labels, doc classification, and routing surfaces. No other
 * file needs to be updated.
 */
export const BUILTIN_TAXONOMY_TAGS: ReadonlyArray<CanonicalTagMetadata> = [
  // ─── Domain tags ───────────────────────────────────────────────
  {
    tag: 'architecture',
    label: 'Architecture',
    description: 'Cross-cutting architectural decisions, patterns, and subsystem-level concerns',
    axes: ['domain', 'type'],
    adhocAliases: ['architecture'],
  },
  {
    tag: 'cli',
    label: 'CLI',
    description: 'Command-line interface, dispatch, and command infrastructure',
    axes: ['domain'],
    adhocAliases: ['cli'],
  },
  {
    tag: 'core',
    label: 'Core',
    description: 'Core engine, shared utilities, and foundational modules',
    axes: ['domain'],
    adhocAliases: ['core', 'pm-core-v2', 'foundation'],
  },
  {
    tag: 'contracts',
    label: 'Contracts',
    description: 'Type contracts, schemas, and public API surface definitions',
    axes: ['domain'],
    adhocAliases: ['contracts', 'schema'],
  },
  {
    tag: 'caamp',
    label: 'CAAMP',
    description: 'Cross-Agent Adaptive Messaging Protocol — hooks, adapters, providers',
    axes: ['domain'],
    adhocAliases: ['caamp', 'cant', 'pi', 'cant-dsl'],
  },
  {
    tag: 'skills',
    label: 'Skills',
    description: 'Agent skill definitions, injection, dispatch, and guard patterns',
    axes: ['domain'],
    adhocAliases: ['skills'],
  },
  {
    tag: 'brain',
    label: 'BRAIN',
    description: 'Cognitive memory system — decisions, patterns, observations, learnings',
    axes: ['domain'],
    adhocAliases: ['brain'],
  },
  {
    tag: 'nexus',
    label: 'Nexus',
    description: 'Code intelligence surface — project indexing, impact analysis, cross-repo',
    axes: ['domain'],
    adhocAliases: ['nexus'],
  },
  {
    tag: 'orchestration',
    label: 'Orchestration',
    description: 'Multi-agent orchestration, playbooks, LOOM lifecycle, spawn dispatch',
    axes: ['domain'],
    adhocAliases: ['orchestration', 'orchestrate'],
  },
  {
    tag: 'sessions',
    label: 'Sessions',
    description: 'Session lifecycle — handoff, debrief, briefing, snapshot, state',
    axes: ['domain'],
    adhocAliases: ['sessions'],
  },
  {
    tag: 'tasks',
    label: 'Tasks',
    description: 'Task management — CRUD, gates, evidence, acceptance criteria, lifecycle',
    axes: ['domain'],
    adhocAliases: ['tasks'],
  },
  {
    tag: 'docs',
    label: 'Documents',
    description: 'Document storage, retrieval, taxonomy, publish, and provenance',
    axes: ['domain'],
    adhocAliases: ['docs', 'documentation'],
  },
  {
    tag: 'cleoos',
    label: 'CleoOS',
    description: 'CleoOS runtime — gateway, daemon, injection facade, agents',
    axes: ['domain'],
    adhocAliases: ['cleoos', 'facade', 'sentient'],
  },
  {
    tag: 'worktrunk',
    label: 'Worktrunk',
    description: 'Git worktree management — spawn, adopt, prune, lifecycle',
    axes: ['domain'],
    adhocAliases: ['worktrunk', 'worktrunk-ssot'],
  },
  {
    tag: 'agents',
    label: 'Agents',
    description: 'Agent profiles, execution learning, registry, dispatch',
    axes: ['domain'],
    adhocAliases: ['agents'],
  },
  {
    tag: 'routing',
    label: 'Routing',
    description: 'Operation routing, capability matrix, dispatch path resolution',
    axes: ['domain'],
    adhocAliases: ['routing'],
  },
  {
    tag: 'studio',
    label: 'Studio',
    description: 'Web UI, dashboard, and visual interfaces',
    axes: ['domain'],
    adhocAliases: ['studio'],
  },

  // ─── Type tags ─────────────────────────────────────────────────
  {
    tag: 'architectural',
    label: 'Architectural Decision',
    description: 'Cross-cutting architectural decision with durable rationale',
    axes: ['type'],
    adhocAliases: ['architectural'],
  },
  {
    tag: 'technical',
    label: 'Technical Decision',
    description: 'Implementation-scoped technical decision (library, pattern, algorithm)',
    axes: ['type'],
    adhocAliases: ['technical'],
  },
  {
    tag: 'process',
    label: 'Process Decision',
    description: 'Workflow, methodology, or operational process decision',
    axes: ['type'],
    adhocAliases: ['process'],
  },
  {
    tag: 'strategic',
    label: 'Strategic Decision',
    description: 'Long-horizon direction-setting decision spanning multiple epics',
    axes: ['type'],
    adhocAliases: ['strategic'],
  },
  {
    tag: 'tactical',
    label: 'Tactical Decision',
    description: 'Short-horizon execution-level decision (AGT-* dispatch, within-sprint)',
    axes: ['type'],
    adhocAliases: ['tactical'],
  },
  {
    tag: 'operational',
    label: 'Operational Decision',
    description: 'Infrastructure, deployment, or runtime configuration decision',
    axes: ['type'],
    adhocAliases: ['operational'],
  },
  {
    tag: 'bugfix',
    label: 'Bug Fix',
    description: 'Defect correction or regression fix',
    axes: ['type'],
    adhocAliases: ['bugfix', 'bug-fix', 'hygiene'],
  },
  {
    tag: 'refactor',
    label: 'Refactor',
    description: 'Internal restructuring without functional change',
    axes: ['type'],
    adhocAliases: ['refactor'],
  },
  {
    tag: 'feature',
    label: 'Feature',
    description: 'New capability or user-facing enhancement',
    axes: ['type'],
    adhocAliases: ['feature'],
  },
  {
    tag: 'discovery',
    label: 'Discovery',
    description: 'Exploratory research, investigation, or spike outcome',
    axes: ['type'],
    adhocAliases: ['discovery', 'exploration', 'research-type'],
  },
  {
    tag: 'migration',
    label: 'Migration',
    description: 'Data or schema migration, backfill, or upgrade path',
    axes: ['type'],
    adhocAliases: ['migration', 'migrations'],
  },
  {
    tag: 'unification',
    label: 'Unification',
    description: 'Consolidation of fragmented systems into a single SSoT',
    axes: ['type'],
    adhocAliases: ['unification'],
  },
  {
    tag: 'bootstrap',
    label: 'Bootstrap',
    description: 'Initial setup, scaffolding, or seed infrastructure',
    axes: ['type'],
    adhocAliases: ['bootstrap'],
  },

  // ─── Lifecycle tags ────────────────────────────────────────────
  {
    tag: 'research',
    label: 'Research',
    description: 'LOOM stage 1: information gathering and domain understanding',
    axes: ['lifecycle'],
    adhocAliases: ['research', 'wave-0'],
  },
  {
    tag: 'consensus',
    label: 'Consensus',
    description: 'LOOM stage 2: multi-agent consensus and validation of findings',
    axes: ['lifecycle'],
    adhocAliases: ['consensus'],
  },
  {
    tag: 'design',
    label: 'Architecture Decision',
    description: 'LOOM stage 3: architecture decision recording and validation',
    axes: ['lifecycle'],
    adhocAliases: ['design', 'architecture_decision'],
  },
  {
    tag: 'specification',
    label: 'Specification',
    description: 'LOOM stage 4: technical specification authoring',
    axes: ['lifecycle'],
    adhocAliases: ['specification', 'spec', 'rfc'],
  },
  {
    tag: 'decomposition',
    label: 'Decomposition',
    description: 'LOOM stage 5: task decomposition and dependency modeling',
    axes: ['lifecycle'],
    adhocAliases: ['decomposition'],
  },
  {
    tag: 'implementation',
    label: 'Implementation',
    description: 'LOOM stage 6: code authoring and unit-level verification',
    axes: ['lifecycle'],
    adhocAliases: ['implementation', 'wave-1', 'wave-2', 'wave-3', 'wave-4', 'wave-5', 'wave.1', 'wave.2', 'wave.3'],
  },
  {
    tag: 'validation',
    label: 'Validation',
    description: 'LOOM stage 7: integration testing and gate verification',
    axes: ['lifecycle'],
    adhocAliases: ['validation', 'testing'],
  },
  {
    tag: 'release',
    label: 'Release',
    description: 'LOOM stage 9: versioning, changelog, npm publish, tag push',
    axes: ['lifecycle', 'type'],
    adhocAliases: ['release'],
  },

  // ─── Priority tags ─────────────────────────────────────────────
  {
    tag: 'p0',
    label: 'P0 — Critical',
    description: 'Drop-everything critical: blocks release, data loss, security incident',
    axes: ['priority'],
    adhocAliases: ['p0', 'critical', 'prime-tier1'],
  },
  {
    tag: 'p1',
    label: 'P1 — High',
    description: 'High priority: blocks dependent work, user-visible degradation',
    axes: ['priority'],
    adhocAliases: ['p1'],
  },
  {
    tag: 'p2',
    label: 'P2 — Medium',
    description: 'Medium priority: should fix, not blocking current wave',
    axes: ['priority'],
    adhocAliases: ['p2'],
  },
  {
    tag: 'p3',
    label: 'P3 — Low',
    description: 'Low priority: nice-to-have, cleanup, future consideration',
    axes: ['priority'],
    adhocAliases: ['p3'],
  },

  // ─── Doc-kind tags (absorb docs-taxonomy) ──────────────────────
  {
    tag: 'adr',
    label: 'Architecture Decision Record',
    description: 'Formal architecture decision record with rationale and alternatives',
    axes: ['doc_kind'],
    adhocAliases: ['adr'],
  },
  {
    tag: 'spec',
    label: 'Specification',
    description: 'Technical specification for a feature, protocol, or subsystem',
    axes: ['doc_kind'],
    adhocAliases: ['spec'],
  },
  {
    tag: 'research',
    label: 'Research Note',
    description: 'Investigation findings, surveys, and domain analysis',
    axes: ['doc_kind'],
    adhocAliases: ['research'],
  },
  {
    tag: 'handoff',
    label: 'Handoff Note',
    description: 'Cross-session handoff with state, blockers, and next actions',
    axes: ['doc_kind'],
    adhocAliases: ['handoff'],
  },
  {
    tag: 'note',
    label: 'Note',
    description: 'General-purpose note, observation, or free-form documentation',
    axes: ['doc_kind'],
    adhocAliases: ['note'],
  },
  {
    tag: 'llmreadme',
    label: 'LLM README',
    description: 'Agent-consumable project overview, conventions, and context',
    axes: ['doc_kind'],
    adhocAliases: ['llmreadme', 'llm-readme'],
  },
  {
    tag: 'designmd',
    label: 'Design Doc',
    description: 'Google DESIGN.md token spec for agent interface contracts',
    axes: ['doc_kind'],
    adhocAliases: ['designmd', 'design-md'],
  },
  {
    tag: 'changeset',
    label: 'Changeset',
    description: 'User-facing changelog entry for a single change',
    axes: ['doc_kind'],
    adhocAliases: ['changeset'],
  },
  {
    tag: 'changelog',
    label: 'Changelog',
    description: 'Aggregated release changelog for a version',
    axes: ['doc_kind'],
    adhocAliases: ['changelog'],
  },
];

// ---------------------------------------------------------------------------
// Derived constants
// ---------------------------------------------------------------------------

/** All canonical tag string values. */
export const CANONICAL_TAG_VALUES = BUILTIN_TAXONOMY_TAGS.map((t) => t.tag);

/** Every tag indexed by its canonical id. */
const TAG_BY_ID = new Map<string, CanonicalTagMetadata>(
  BUILTIN_TAXONOMY_TAGS.map((t) => [t.tag, t]),
);

/** Ad-hoc label → canonical tag lookup. */
const ADHOC_TO_CANONICAL = new Map<string, string>();
for (const tag of BUILTIN_TAXONOMY_TAGS) {
  for (const alias of tag.adhocAliases) {
    ADHOC_TO_CANONICAL.set(alias, tag.tag);
  }
}

/** Tags grouped by axis. */
const TAGS_BY_AXIS = new Map<TaxonomyAxis, CanonicalTagMetadata[]>();
for (const axis of ['domain', 'type', 'lifecycle', 'priority', 'doc_kind'] as TaxonomyAxis[]) {
  TAGS_BY_AXIS.set(
    axis,
    BUILTIN_TAXONOMY_TAGS.filter((t) => t.axes.includes(axis)),
  );
}

/** All canonical tag type values (subset of ALL_TAGS with axis='type'). */
export const CANONICAL_TYPE_TAGS: ReadonlyArray<string> =
  TAGS_BY_AXIS.get('type')!.map((t) => t.tag);

/** All canonical domain tag values. */
export const CANONICAL_DOMAIN_TAGS: ReadonlyArray<string> =
  TAGS_BY_AXIS.get('domain')!.map((t) => t.tag);

/** Canonical priority tag values in order. */
export const CANONICAL_PRIORITY_TAGS = ['p0', 'p1', 'p2', 'p3'] as const;

/** Canonical lifecycle tag values in LOOM order. */
export const CANONICAL_LIFECYCLE_TAGS = [
  'research',
  'consensus',
  'design',
  'specification',
  'decomposition',
  'implementation',
  'validation',
  'release',
] as const;

/** Doc-kind tags (absorbed from docs-taxonomy). */
export const CANONICAL_DOC_KIND_TAGS: ReadonlyArray<string> =
  TAGS_BY_AXIS.get('doc_kind')!.map((t) => t.tag);

// ---------------------------------------------------------------------------
// Taxonomy Registry
// ---------------------------------------------------------------------------

/** Error thrown for taxonomy validation failures. */
export class TaxonomyError extends Error {
  constructor(
    message: string,
    public readonly invalidTags: string[],
  ) {
    super(message);
    this.name = 'TaxonomyError';
  }
}

/**
 * Canonical Taxonomy Registry — runtime accessor and validator.
 *
 * Use {@link TaxonomyRegistry.default} for the built-in singleton,
 * or construct with a custom tag list for testing.
 */
export class TaxonomyRegistry {
  private readonly byId: Map<string, CanonicalTagMetadata>;
  private readonly adhocMap: Map<string, string>;

  constructor(tags: ReadonlyArray<CanonicalTagMetadata>) {
    this.byId = new Map(tags.map((t) => [t.tag, t]));
    this.adhocMap = new Map<string, string>();
    for (const tag of tags) {
      for (const alias of tag.adhocAliases) {
        if (this.adhocMap.has(alias)) {
          const existing = this.adhocMap.get(alias)!;
          throw new TaxonomyError(
            `Ad-hoc alias '${alias}' maps to both '${existing}' and '${tag.tag}' — aliases must be unique`,
            [alias],
          );
        }
        this.adhocMap.set(alias, tag.tag);
      }
    }
  }

  /** Default built-in registry singleton. */
  static readonly default = new TaxonomyRegistry(BUILTIN_TAXONOMY_TAGS);

  /** True when `tag` is a canonical tag. */
  isCanonical(tag: string): boolean {
    return this.byId.has(tag);
  }

  /** Look up metadata for a canonical tag. */
  get(tag: string): CanonicalTagMetadata | undefined {
    return this.byId.get(tag);
  }

  /** List all canonical tags. */
  list(): ReadonlyArray<CanonicalTagMetadata> {
    return [...this.byId.values()];
  }

  /** List tags for a specific axis. */
  listByAxis(axis: TaxonomyAxis): ReadonlyArray<CanonicalTagMetadata> {
    return this.list().filter((t) => t.axes.includes(axis));
  }

  /**
   * Normalize an ad-hoc label to its canonical form.
   *
   * Returns the canonical tag id, or `undefined` if the label has no
   * known canonical mapping.
   */
  normalize(adhoc: string): string | undefined {
    return this.adhocMap.get(adhoc);
  }

  /**
   * Validate that every tag in `tags` is canonical.
   *
   * @param tags - Tags to validate.
   * @returns An array of invalid tags. Empty array = all valid.
   */
  validate(tags: ReadonlyArray<string>): string[] {
    return tags.filter((t) => !this.byId.has(t));
  }

  /**
   * Validate tags and throw on failure.
   *
   * @param tags - Tags to validate.
   * @param context - Human-readable context for the error message.
   * @throws TaxonomyError when any tag is not canonical.
   */
  validateOrThrow(tags: ReadonlyArray<string>, context: string): void {
    const invalid = this.validate(tags);
    if (invalid.length > 0) {
      throw new TaxonomyError(
        `${context}: unknown tags [${invalid.join(', ')}]. ` +
          `Use canonical tags. Run 'cleo taxonomy list' to see all valid tags.`,
        invalid,
      );
    }
  }

  /**
   * Normalize a set of ad-hoc labels to canonical form.
   *
   * Unknown labels are passed through unchanged (they may be
   * project-specific extensions or task-id references).
   *
   * @param labels - Ad-hoc labels to normalize.
   * @returns Normalized label set (deduplicated).
   */
  normalizeSet(labels: ReadonlyArray<string>): string[] {
    const result = new Set<string>();
    for (const label of labels) {
      const canonical = this.normalize(label);
      result.add(canonical ?? label);
    }
    return [...result];
  }
}

/**
 * Agent Registry v3 — Extended registry fields for tier-aware resolution.
 *
 * Introduced by T889 / T897 (agent_registry v3 migration). These types layer
 * on top of the existing `AgentCredential` contract (see `./agent-registry.js`)
 * to carry tier, spawn capability, orchestration level, and on-disk `.cant`
 * provenance metadata.
 *
 * @see packages/core/migrations/drizzle-signaldock/*_T897_agent_registry_v3.sql
 * @module agent-registry-v3
 * @task T897
 * @epic T889
 */

// ============================================================================
// Tier / capability taxonomies
// ============================================================================

/**
 * Tier where an agent is installed or resolved from.
 *
 * - `project`  — installed in the current project (`.cleo/agents/`)
 * - `global`   — installed at the user/global scope (`$XDG_DATA_HOME/cleo/agents/`)
 * - `packaged` — bundled with the CLEO distribution
 * - `fallback` — synthesized at resolve-time when no concrete `.cant` exists
 *
 * @task T897
 * @epic T889
 */
export type AgentTier = 'project' | 'global' | 'packaged' | 'fallback';

/**
 * Whether an agent is permitted to spawn other agents and its role in the
 * orchestration hierarchy.
 *
 * - `orchestrator` — top-level coordinator, may spawn leads and workers
 * - `lead`         — may spawn workers only
 * - `worker`       — terminal; may not spawn
 *
 * @task T897
 * @epic T889
 */
export type AgentSpawnCapability = 'orchestrator' | 'lead' | 'worker';

/**
 * Taxonomy for the `agent_skills.source` column, identifying how a skill
 * binding was derived.
 *
 * - `cant`     — parsed from the agent's `.cant` manifest
 * - `manual`   — attached explicitly by a CLI call
 * - `computed` — derived by a background indexer (e.g. doctor / index)
 *
 * @task T897
 * @epic T889
 */
export type AgentSkillSource = 'cant' | 'manual' | 'computed';

// ============================================================================
// Extended row / resolved envelopes
// ============================================================================

/**
 * Extended agent registry row fields added in the T889 / T897 v3 migration.
 *
 * These fields live directly on the global `signaldock.db:agents` table and
 * supplement the pre-existing `AgentCredential` shape with tier-aware
 * resolution metadata.
 *
 * @task T897
 * @epic T889
 */
export interface AgentRegistryExtendedFields {
  /** Tier where the row was installed / resolved from. */
  tier: AgentTier;
  /** `true` when the agent is permitted to spawn subagents. */
  canSpawn: boolean;
  /**
   * Orchestration level (0 = orchestrator, 1 = lead, 2 = worker). Constrained
   * to the closed interval [0, 2] by the v3 CHECK constraint.
   */
  orchLevel: number;
  /** `agent_id` of the supervising agent, or `null` for top-level agents. */
  reportsTo: string | null;
  /** Absolute path to the `.cant` manifest that provisioned this row. */
  cantPath: string | null;
  /** SHA-256 checksum of the `.cant` manifest at install time (hex-encoded). */
  cantSha256: string | null;
  /** Source of the install record (`seed` = bundled, `user` = CLI attach, `manual` = hand-edited). */
  installedFrom: 'seed' | 'user' | 'manual' | null;
  /** ISO 8601 timestamp when the row was installed. */
  installedAt: string | null;
}

/**
 * Resolved agent record returned from the future `resolveAgent()` lookup.
 *
 * Aggregates tier-ranked registry state with the merged skill list and an
 * optional alias record. Returned as an LAFS-compatible envelope so callers
 * can inline the record in `data` without further shaping.
 *
 * @task T897
 * @epic T889
 */
export interface ResolvedAgent {
  /** Agent business identifier (matches `agents.agent_id`). */
  agentId: string;
  /** Tier the resolved row was sourced from. */
  tier: AgentTier;
  /** Absolute path to the resolved `.cant` manifest. */
  cantPath: string;
  /** SHA-256 checksum of the resolved `.cant` manifest (hex-encoded). */
  cantSha256: string;
  /** `true` when the agent may spawn subagents. */
  canSpawn: boolean;
  /** Orchestration level (0..2). */
  orchLevel: number;
  /** `agent_id` of the supervising agent, or `null`. */
  reportsTo: string | null;
  /** Merged skill slugs (union of catalog bindings and `.cant`-declared skills). */
  skills: string[];
  /** Concrete source tier of the chosen row (mirrors `tier`). */
  source: 'project' | 'global' | 'packaged' | 'fallback';
  /** `true` when an alias redirected the lookup to another agentId. */
  aliasApplied: boolean;
  /** When `aliasApplied` is true, the terminal canonical agentId the alias pointed at. */
  aliasTarget?: string;
}

// ============================================================================
// Doctor diagnostic contracts
// ============================================================================

/**
 * Stable diagnostic codes emitted by the `cleo agent doctor` walk. Codes are
 * frozen for the lifetime of the v3 schema; new checks MUST claim a fresh
 * code rather than reusing a retired one.
 *
 * @task T897
 * @epic T889
 */
export type AgentDoctorCode =
  | 'D-001'
  | 'D-002'
  | 'D-003'
  | 'D-004'
  | 'D-005'
  | 'D-006'
  | 'D-007'
  | 'D-008'
  | 'D-009'
  | 'D-010';

/**
 * Single finding produced by the agent doctor. A `fixCommand` is populated
 * when the diagnostic is auto-remediable.
 *
 * @task T897
 * @epic T889
 */
export interface AgentDoctorFinding {
  /** Stable diagnostic code (see `AgentDoctorCode`). */
  code: AgentDoctorCode;
  /** Severity classification. */
  severity: 'error' | 'warn' | 'info';
  /** Entity under inspection (usually an `agent_id` or `.cant` path). */
  subject: string;
  /** Human-readable description of the finding. */
  message: string;
  /** Optional `cleo` command that will repair the finding when applied. */
  fixCommand?: string;
}

/**
 * Aggregate doctor report envelope. `summary` tallies findings by severity
 * for quick triage.
 *
 * @task T897
 * @epic T889
 */
export interface DoctorReport {
  /** Ordered findings, first-detected-first. */
  findings: AgentDoctorFinding[];
  /** Severity histogram. */
  summary: { error: number; warn: number; info: number };
  /** ISO 8601 timestamp when the report was generated. */
  generatedAt: string;
}

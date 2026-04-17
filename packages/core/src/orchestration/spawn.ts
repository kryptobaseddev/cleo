/**
 * Canonical spawn payload composer — the single public API for subagent
 * payload construction.
 *
 * Wraps the T882 {@link buildSpawnPrompt} engine with the coherence
 * invariants required by the T889 epic:
 *
 *  - {@link resolveAgent} registry lookup (W2-4) → populates the tier-ranked
 *    `ResolvedAgent` envelope on every payload.
 *  - {@link resolveHarnessHint} dedup decision (W3-2) → skips the ~9KB
 *    tier-1 CLEO-INJECTION embed when the harness already loads it.
 *  - Auto-tier selection by role (T892 — simple mapping here; richer
 *    role/size/type heuristics land in W3-x).
 *  - {@link checkAtomicity} worker file-scope gate (W3-3) → detects
 *    worker spawns that lack explicit AC.files.
 *
 * Callers of the legacy {@link buildSpawnPrompt} continue to work unchanged.
 * New call sites should reach for {@link composeSpawnPayload} instead: it is
 * the only public entry point that emits the full `SpawnPayload` envelope
 * with traceability metadata, atomicity verdict, and dedup accounting.
 *
 * @module orchestration/spawn
 * @task T889 Orchestration Coherence v3
 * @task T890 Tier auto-select (placeholder here, full impl in W3-x)
 * @task T891 Canonical composer (W3-1)
 * @task T893 Harness-aware dedup (W3-2)
 */

import type { DatabaseSync } from 'node:sqlite';
import type { AgentSpawnCapability, AgentTier, ResolvedAgent, Task } from '@cleocode/contracts';
import { resolveAgent } from '../store/agent-resolver.js';
import { type AtomicityResult, checkAtomicity } from './atomicity.js';
import { type HarnessHint, resolveHarnessHint } from './harness-hint.js';
import { autoDispatch } from './index.js';
import { buildSpawnPrompt, type SpawnProtocolPhase, type SpawnTier } from './spawn-prompt.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Options accepted by {@link composeSpawnPayload}.
 *
 * Every field is optional. The composer applies the following defaults:
 *
 *  - `tier`    → derived from role: orchestrator=2, lead=1, worker=0
 *  - `role`    → derived from `ResolvedAgent.orchLevel` (0/1/2 → o/l/w)
 *  - `harnessHint` → {@link resolveHarnessHint} cascade result
 *  - `agentId` → `'cleo-subagent'` until the classify() router ships
 *  - `embedInjection` → inferred from `harnessHint` (claude-code → false)
 *  - `skipAtomicityCheck` → false (always gate workers)
 *
 * @task T889 / W3-1
 */
export interface ComposeSpawnPayloadOptions {
  /** Force a specific tier. Default: auto-select from role. */
  tier?: SpawnTier;
  /**
   * Force role. Default: resolved from `ResolvedAgent.orchLevel`.
   * Mirrors the `AgentSpawnCapability` taxonomy so the atomicity guard can
   * consume the role directly without remapping.
   */
  role?: AgentSpawnCapability;
  /** Harness hint override. Default: {@link resolveHarnessHint}. */
  harnessHint?: HarnessHint;
  /** Project root for path + profile resolution. Default: `process.cwd()`. */
  projectRoot?: string;
  /**
   * Explicit agent id. Default: `'cleo-subagent'` (classify router not yet
   * wired — T891 will swap this default for the classify() result).
   */
  agentId?: string;
  /**
   * Force CLEO-INJECTION embed even when the harness has it loaded.
   *
   * Default: embed IFF `harnessHint !== 'claude-code'`. Override to `true`
   * for audited/offline captures where the full prompt must be archived
   * verbatim regardless of the running harness.
   */
  embedInjection?: boolean;
  /**
   * Skip the atomicity gate. Reserved for orchestrator-invoked meta-spawns
   * (e.g. the `cleo orchestrate` engine itself spawning lead coordinators)
   * that are allowed to exceed the worker file budget.
   *
   * Default: `false`. When `true`, the composer returns
   * `atomicity.allowed = true` with no further checks.
   */
  skipAtomicityCheck?: boolean;
  /**
   * Protocol phase to dispatch. Default: {@link autoDispatch} result for the
   * task. Callers that have already dispatched externally can pin the
   * phase here to avoid a redundant classification.
   */
  protocol?: SpawnProtocolPhase | string;
  /**
   * Orchestrator's active session id to thread into the prompt so the
   * subagent logs every mutation against the caller's session.
   */
  sessionId?: string | null;
}

/**
 * Full payload returned by {@link composeSpawnPayload}.
 *
 * Contains both the ready-to-use prompt string AND the traceability
 * metadata the orchestrator needs for its manifest and telemetry. Callers
 * that only want the prompt should read `payload.prompt`; everything else
 * is diagnostic.
 */
export interface SpawnPayload {
  /** Task id the spawn is about (mirrors `task.id`). */
  taskId: string;
  /** Agent id the spawn is routed to. */
  agentId: string;
  /** Role the agent will execute as. */
  role: AgentSpawnCapability;
  /** Tier of the rendered prompt. */
  tier: SpawnTier;
  /** Harness hint that drove the dedup decision. */
  harnessHint: HarnessHint;
  /** Full resolved agent envelope (see {@link ResolvedAgent}). */
  resolvedAgent: ResolvedAgent;
  /** Atomicity verdict from the worker file-scope guard. */
  atomicity: AtomicityResult;
  /**
   * The fully-resolved spawn prompt. Copy-pastable into any LLM runtime
   * (Claude, GPT-4, Gemini) that accepts a system-prompt string.
   */
  prompt: string;
  /** Traceability / accounting metadata. */
  meta: SpawnPayloadMeta;
}

/**
 * Diagnostic metadata attached to every {@link SpawnPayload}.
 */
export interface SpawnPayloadMeta {
  /** Tier the resolved agent was sourced from (mirrors `resolvedAgent.tier`). */
  sourceTier: AgentTier;
  /** Characters saved by skipping the tier-1 CLEO-INJECTION embed. */
  dedupSavedChars: number;
  /** Character length of the final prompt. */
  promptChars: number;
  /** Protocol phase the prompt was rendered for. */
  protocol: string;
  /** ISO 8601 timestamp when the payload was generated. */
  generatedAt: string;
  /** Pinned composer contract version — bump on breaking changes. */
  composerVersion: '3.0.0';
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Map an `orchLevel` (0/1/2) to the canonical {@link AgentSpawnCapability}.
 *
 * Out-of-range values default to `worker` — the safest terminal role. The
 * v3 schema CHECK constraint already pins `orch_level` to [0, 2] so this
 * fallback only matters for fallback-tier envelopes or misconfigured rows
 * that slip past the constraint.
 */
function orchLevelToRole(orchLevel: number): AgentSpawnCapability {
  if (orchLevel === 0) return 'orchestrator';
  if (orchLevel === 1) return 'lead';
  return 'worker';
}

/**
 * Default-tier selection from role.
 *
 * - orchestrator → tier 2 (full context, skill excerpts, anti-patterns)
 * - lead         → tier 1 (standard + CLEO-INJECTION embed)
 * - worker       → tier 0 (minimal pointer, lowest token cost)
 *
 * Callers that want a different mapping (e.g. size-weighted tiers) should
 * pass `options.tier` explicitly. The full T892 heuristic ships in a later
 * wave of the epic.
 */
function defaultTierForRole(role: AgentSpawnCapability): SpawnTier {
  if (role === 'orchestrator') return 2;
  if (role === 'lead') return 1;
  return 0;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Compose a fully-populated spawn payload for a given task.
 *
 * Resolution pipeline:
 *
 *  1. Resolve the agent via {@link resolveAgent} (4-tier precedence).
 *  2. Determine role (explicit option > derived from `orchLevel`).
 *  3. Resolve tier (explicit option > role-default).
 *  4. Resolve harness hint via {@link resolveHarnessHint} cascade.
 *  5. Run the {@link checkAtomicity} guard (unless explicitly skipped).
 *  6. Render the prompt via the T882 {@link buildSpawnPrompt} engine.
 *  7. Package everything in a {@link SpawnPayload} with traceability meta.
 *
 * Atomicity violations are surfaced in `payload.atomicity.allowed` rather
 * than thrown — callers choose how to react. Throwing the
 * {@link AtomicityViolationError} is still available by inspecting the
 * `atomicity.code` field and raising at the CLI boundary.
 *
 * @param db     - Open handle to the global `signaldock.db`. Caller owns
 *                 lifecycle; the composer does not close it.
 * @param task   - Task record being dispatched.
 * @param options - See {@link ComposeSpawnPayloadOptions}.
 * @returns A {@link SpawnPayload} with the prompt, atomicity verdict, and
 *          traceability metadata.
 *
 * @task T889 / T891 / W3-1
 */
export async function composeSpawnPayload(
  db: DatabaseSync,
  task: Task,
  options: ComposeSpawnPayloadOptions = {},
): Promise<SpawnPayload> {
  const projectRoot = options.projectRoot ?? process.cwd();

  // 1. Agent id — explicit wins, else classify() (stubbed to cleo-subagent).
  const agentId = options.agentId ?? 'cleo-subagent';

  // 2. Resolve the agent envelope from the 4-tier registry.
  const resolvedAgent = resolveAgent(db, agentId, { projectRoot });

  // 3. Role — explicit option wins, else derive from orchLevel.
  const role: AgentSpawnCapability = options.role ?? orchLevelToRole(resolvedAgent.orchLevel);

  // 4. Tier — explicit option wins, else role-default.
  const tier: SpawnTier = options.tier ?? defaultTierForRole(role);

  // 5. Harness hint — explicit option flows into the cascade.
  const hintResult = resolveHarnessHint({
    explicit: options.harnessHint,
    projectRoot,
  });
  const harnessHint = hintResult.hint;

  // 6. Atomicity gate — workers only (the check itself no-ops for other
  //    roles). Callers that want to skip entirely (orchestrator-spawned
  //    meta-work) pass `skipAtomicityCheck: true`.
  const atomicity: AtomicityResult = options.skipAtomicityCheck
    ? { allowed: true }
    : checkAtomicity({
        taskId: task.id,
        role,
        acceptance: task.acceptance?.map((item) =>
          typeof item === 'string' ? item : (item.description ?? ''),
        ),
        declaredFiles: task.files,
      });

  // 7. Build the prompt via the T882 engine. The engine is now the internal
  //    assembler; callers that previously imported buildSpawnPrompt directly
  //    continue to work unchanged.
  const protocol = options.protocol ?? autoDispatch(task);
  const shouldEmbedInjection = options.embedInjection ?? harnessHint !== 'claude-code';
  const promptResult = buildSpawnPrompt({
    task,
    protocol,
    tier,
    projectRoot,
    sessionId: options.sessionId ?? null,
    harnessHint,
    skipCleoInjectionEmbed: !shouldEmbedInjection,
  });

  // 8. Assemble the traceability envelope. `dedupSavedChars` only counts
  //    when the embed was actually skipped — an explicit `embedInjection:
  //    true` keeps the embed and therefore saves zero chars regardless of
  //    harness.
  const effectiveDedup = !shouldEmbedInjection ? hintResult.dedupSavedChars : 0;

  return {
    taskId: task.id,
    agentId: resolvedAgent.agentId,
    role,
    tier,
    harnessHint,
    resolvedAgent,
    atomicity,
    prompt: promptResult.prompt,
    meta: {
      sourceTier: resolvedAgent.tier,
      dedupSavedChars: effectiveDedup,
      promptChars: promptResult.prompt.length,
      protocol: promptResult.protocol,
      generatedAt: new Date().toISOString(),
      composerVersion: '3.0.0',
    },
  };
}

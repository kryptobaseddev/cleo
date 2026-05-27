/**
 * Stage-Aware LLM Prompt Guidance (Phase 2, refactored Phase 4).
 *
 * **Architecture (SSoT)**: The protocol text for each RCASD-IVTR+C stage is
 * authoritatively encoded in the `@cleocode/skills` package at
 * `packages/skills/skills/ct-*` — specifically:
 *
 *   - Tier 0 (always loaded): `ct-cleo`, `ct-orchestrator`, `ct-task-executor`
 *   - Stage-specific (per RCASD-IVTR+C stage): see `STAGE_SKILL_MAP` below
 *
 * This module is a **thin loader** — it does NOT embed protocol text. It
 * resolves stage → skill names via `STAGE_SKILL_MAP`, then calls the
 * existing `prepareSpawnMulti()` helper (from `../skills/dispatch.ts`) to
 * compose the full prompt from real `SKILL.md` files.
 *
 * If the skill files are unavailable at runtime (e.g. fresh install, skills
 * package missing), we fall back to a minimal structured description built
 * from `STAGE_DEFINITIONS` alone — never hand-authored prose.
 *
 * @task Phase 2 — Pi harness registration + stage guidance injection
 * @task Phase 4 — SSoT alignment: pull from skill files, not inline text
 */

import { findSkill } from '../skills/discovery.js';
import { prepareSpawnMulti } from '../skills/dispatch.js';
import { STAGE_DEFINITIONS, type Stage } from './stages.js';

// ============================================================================
// SSoT: Stage → Skill mapping
// ============================================================================

/**
 * Canonical mapping from RCASD-IVTR+C pipeline stages to the primary skill
 * that encodes the protocol for that stage.
 *
 * Each pipeline stage maps to exactly one **dedicated** skill that owns
 * the protocol contract for that stage. The keys here are the canonical
 * `Stage` union from `./stages.ts`; the values are skill names that MUST
 * exist under `packages/skills/skills/` and be registered in the global
 * manifest at `packages/skills/skills/manifest.json`.
 *
 * **Relationship to manifest.json:** This table is the runtime authority
 * for stage→skill resolution by `buildStageGuidance()`. The manifest's
 * `dispatch_matrix.by_protocol` table is the broader catalog (it also
 * covers cross-cutting protocols like contribution, artifact-publish, and
 * provenance which are NOT pipeline stages and therefore are not in this
 * map). When the two tables overlap, they MUST agree on the skill name.
 *
 * **Cross-cutting protocols** (`contribution`, `artifact-publish`,
 * `provenance`) compose with pipeline stages but are not themselves
 * stages — see `lifecycle/default-chain.ts#DEFAULT_PROTOCOL_STAGE_MAP`
 * for the cross-cutting → host-stage mapping.
 *
 * @task T260 — replace overloaded ct-validator/ct-dev-workflow assignments
 *              with dedicated skills (ct-adr-recorder, ct-consensus-voter,
 *              ct-ivt-looper, ct-release-orchestrator). Validation stays on
 *              ct-validator now that consensus duties are split out.
 */
export const STAGE_SKILL_MAP: Record<Stage, string> = {
  research: 'ct-research-agent',
  consensus: 'ct-consensus-voter',
  architecture_decision: 'ct-adr-recorder',
  specification: 'ct-spec-writer',
  decomposition: 'ct-epic-architect',
  implementation: 'ct-task-executor',
  validation: 'ct-validator',
  testing: 'ct-ivt-looper',
  release: 'ct-release-orchestrator',
};

/**
 * Tier 0 skills — always loaded alongside the stage-specific skill.
 *
 * - `ct-cleo`: CLEO task management protocol (session, task, memory CLI)
 * - `ct-orchestrator`: pipeline-aware orchestration constraints (ORC-001..009)
 *
 * `ct-task-executor` is NOT unconditionally included because most stages
 * already resolve to a more-specific executor skill; it's only added when
 * no stage-specific skill exists.
 */
export const TIER_0_SKILLS: readonly string[] = ['ct-cleo', 'ct-orchestrator'];

// ============================================================================
// Public types
// ============================================================================

/**
 * Structured guidance for a single pipeline stage.
 *
 * Pi extensions consume the `.prompt` field directly (render via
 * `{ systemPrompt }` in `before_agent_start`). The structured fields are
 * exposed for TUI widgets, badges, and logging.
 */
export interface StageGuidance {
  /** The canonical stage identifier. */
  stage: Stage;
  /** Human-readable stage name (e.g. "Research"). */
  name: string;
  /** Numeric stage order (1-9). */
  order: number;
  /** Primary skill loaded for this stage (SSoT from STAGE_SKILL_MAP). */
  primarySkill: string;
  /** All skills loaded (Tier 0 + stage primary). */
  loadedSkills: readonly string[];
  /** Gates that must pass before the stage can be completed. */
  requiredGates: readonly string[];
  /** Artifacts the agent is expected to produce before advancing. */
  expectedArtifacts: readonly string[];
  /** Composed prompt text, ready for LLM system prompt injection. */
  prompt: string;
  /** Source of the prompt: 'skills' (real SKILL.md files) or 'fallback'. */
  source: 'skills' | 'fallback';
}

// ============================================================================
// Fallback prompt builder — used only when skills are unavailable
// ============================================================================

/**
 * Build a minimal stage prompt from canonical metadata when the skill files
 * cannot be resolved. Uses only `STAGE_DEFINITIONS` — no hand-authored prose.
 *
 * This intentionally produces a compact prompt that tells the agent what
 * stage it's in and where to find the authoritative protocol. It is NOT a
 * substitute for the real skill content.
 */
function buildFallbackPrompt(stage: Stage, primarySkill: string): string {
  const def = STAGE_DEFINITIONS[stage];
  const lines: string[] = [];
  lines.push(`## CLEO Pipeline Stage: ${def.name} (stage ${def.order}/9)`);
  lines.push('');
  lines.push(`**Description**: ${def.description}`);
  lines.push(`**Category**: ${def.category}`);
  lines.push(`**Skippable**: ${def.skippable ? 'yes' : 'no'}`);
  lines.push('');
  lines.push('### Required Gates');
  for (const gate of def.requiredGates) {
    lines.push(`- \`${gate}\``);
  }
  lines.push('');
  lines.push('### Expected Artifacts');
  for (const artifact of def.expectedArtifacts) {
    lines.push(`- \`${artifact}\``);
  }
  lines.push('');
  lines.push('### Primary Skill');
  lines.push(
    `- **${primarySkill}** — protocol unavailable at runtime. Install \`@cleocode/skills\` or run \`cleo admin scaffold-hub\` to provision.`,
  );
  lines.push('');
  lines.push('### Tier 0 Skills (always loaded)');
  for (const s of TIER_0_SKILLS) {
    lines.push(`- ${s}`);
  }
  lines.push('');
  lines.push(
    '> Fallback guidance — the full `SKILL.md` files could not be resolved. ' +
      'Check skill installation with `cleo skills list`.',
  );
  return lines.join('\n');
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Build structured stage guidance for a given pipeline stage.
 *
 * Resolves the primary skill for the stage from `STAGE_SKILL_MAP`, composes
 * a prompt from the real `SKILL.md` files via `prepareSpawnMulti()`, and
 * returns a `StageGuidance` object suitable for Pi extension injection or
 * direct CLI rendering.
 *
 * If the skills cannot be resolved, returns a fallback prompt built from
 * `STAGE_DEFINITIONS` metadata only — no hand-authored protocol text.
 *
 * @param stage - The canonical pipeline stage identifier
 * @param cwd - Optional project root override for skill resolution
 * @returns Structured guidance with `.prompt` ready for LLM injection
 *
 * @example
 * ```typescript
 * const guidance = buildStageGuidance('implementation');
 * // guidance.primarySkill === 'ct-task-executor'
 * // guidance.loadedSkills === ['ct-task-executor', 'ct-cleo', 'ct-orchestrator']
 * // guidance.prompt starts with "## Skills Loaded (3 total)"
 * ```
 */
export function buildStageGuidance(stage: Stage, cwd?: string): StageGuidance {
  const def = STAGE_DEFINITIONS[stage];
  const primarySkill = STAGE_SKILL_MAP[stage];

  // Primary first, then Tier 0 (de-dup if the primary is itself tier 0)
  const skillNames = [primarySkill, ...TIER_0_SKILLS.filter((s) => s !== primarySkill)];

  // Verify every skill can actually be found before calling prepareSpawnMulti
  const allFound = skillNames.every((name) => findSkill(name, cwd) !== null);

  if (!allFound) {
    return {
      stage,
      name: def.name,
      order: def.order,
      primarySkill,
      loadedSkills: skillNames,
      requiredGates: def.requiredGates,
      expectedArtifacts: def.expectedArtifacts,
      prompt: buildFallbackPrompt(stage, primarySkill),
      source: 'fallback',
    };
  }

  try {
    const composition = prepareSpawnMulti(skillNames, {}, cwd);
    return {
      stage,
      name: def.name,
      order: def.order,
      primarySkill,
      loadedSkills: skillNames,
      requiredGates: def.requiredGates,
      expectedArtifacts: def.expectedArtifacts,
      prompt: composition.prompt,
      source: 'skills',
    };
  } catch {
    return {
      stage,
      name: def.name,
      order: def.order,
      primarySkill,
      loadedSkills: skillNames,
      requiredGates: def.requiredGates,
      expectedArtifacts: def.expectedArtifacts,
      prompt: buildFallbackPrompt(stage, primarySkill),
      source: 'fallback',
    };
  }
}

/**
 * Format stage guidance as a Markdown-wrapped system prompt.
 *
 * Since `buildStageGuidance()` now returns the already-composed prompt in
 * `.prompt`, this helper simply passes it through with a header banner
 * identifying which skills are loaded and which stage is active.
 *
 * @param guidance - The structured guidance from `buildStageGuidance()`
 * @returns Markdown text suitable for LLM system prompt injection
 *
 * @example
 * ```typescript
 * const g = buildStageGuidance('research');
 * const text = formatStageGuidance(g);
 * return { systemPrompt: text };  // Pi before_agent_start hook return
 * ```
 */
export function formatStageGuidance(guidance: StageGuidance): string {
  const banner = [
    `## CLEO Stage-Aware Injection`,
    `**Stage**: ${guidance.name} (${guidance.order}/9) — primary skill: \`${guidance.primarySkill}\``,
    `**Loaded skills**: ${guidance.loadedSkills.join(', ')}`,
    `**Source**: ${guidance.source}`,
    `**Required gates**: ${guidance.requiredGates.map((g) => `\`${g}\``).join(', ')}`,
    '',
    '---',
    '',
  ].join('\n');
  return banner + guidance.prompt;
}

/**
 * Convenience wrapper: build AND format in a single call.
 *
 * @param stage - The canonical pipeline stage identifier
 * @param cwd - Optional project root override for skill resolution
 * @returns Markdown text ready for LLM system prompt injection
 */
export function renderStageGuidance(stage: Stage, cwd?: string): string {
  return formatStageGuidance(buildStageGuidance(stage, cwd));
}

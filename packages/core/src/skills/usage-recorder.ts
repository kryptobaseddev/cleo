/**
 * Skill-usage telemetry recorder — best-effort fire-and-forget writer.
 *
 * Every skill load / view / edit / patch / review event is funneled through
 * {@link recordSkillUsage} which delegates to {@link insertUsage} from
 * `@cleocode/core/store/skills-store`. The recorder is intentionally
 * synchronous at the call site (returns `void`) — the underlying DB write is
 * launched as a detached promise so that telemetry failures NEVER block the
 * skill-load path.
 *
 * This module deliberately mirrors the Hermes "best-effort _mutate" pattern:
 * if the database is missing, locked, mid-migration, or otherwise unreachable
 * the recorder swallows the error and continues. The skill load proceeds.
 *
 * @task T9689
 * @epic T9561
 * @saga T9560
 * @architecture docs/architecture/SG-CLEO-SKILLS-architecture-v3.md §5
 */

import { resolveProjectByCwd } from '@cleocode/paths';
import type { NewSkillUsageRow } from '../store/skills-store.js';
import { enqueueSkillUsage } from '../store/skills-usage-queue.js';

/**
 * Best-effort resolution of the active project's canonical ID from `cwd`.
 *
 * Stamped onto every usage row (`project_id`) so cross-project skill-usage
 * analytics can attribute usage to the project the skill was loaded under
 * (T11544). Returns `null` whenever there is no resolvable CLEO project
 * (global usage outside any repo, corrupt `project-info.json`, etc.) — the
 * column is nullable by design, and telemetry MUST NOT throw on the hot path.
 *
 * The paths-package resolver is itself non-throwing (returns `null`), but the
 * `try/catch` guards against any unexpected fs/parse error so the recorder
 * contract (never break skill loading) holds unconditionally.
 *
 * @returns The canonical projectId, or `null` when no project context exists.
 *
 * @task T11544
 */
function resolveActiveProjectId(): string | null {
  try {
    return resolveProjectByCwd()?.projectId ?? null;
  } catch {
    /* swallowed — telemetry MUST NOT block skill loading (architecture v3 §5) */
    return null;
  }
}

/**
 * Discriminated-union of actions the recorder accepts.
 *
 * - `load`   — the skill was discovered & its `SKILL.md` was read into memory
 * - `view`   — a `cleo skills info <name>` (or equivalent) inspection
 * - `edit`   — the skill body / frontmatter was mutated on disk
 * - `patch`  — an auto-improve diff was applied (T9694+ pipeline)
 * - `review` — a council/grade run emitted a review row
 *
 * Free-form `event_kind` strings are NOT accepted — callers must use this
 * enum so analytics queries stay deterministic across CLEO versions.
 *
 * @architecture v3 §5 telemetry action enum
 */
export type SkillUsageAction = 'load' | 'view' | 'edit' | 'patch' | 'review';

/**
 * Optional context payload attached to a usage row.
 *
 * `taskId` and `modelId` get persisted as dedicated columns; everything else
 * is JSON-encoded into `skill_usage.metadata`.
 */
export interface SkillUsageContext {
  /** CLEO task ID (e.g. `T9689`) if the recorder is running inside a task. */
  readonly taskId?: string;
  /** Model identifier the calling agent was running under (e.g. `claude-opus-4-7`). */
  readonly modelId?: string;
  /** Free-form key/value pairs to JSON-encode into `metadata`. */
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * Internal flag — set to `true` in tests via {@link __setSkillUsageRecorderEnabled}
 * so unit tests can verify the recorder fires without depending on global
 * environment variables. Production callers leave this `true`.
 */
let _enabled = true;

/**
 * Toggle the recorder on / off — test-only seam.
 *
 * The user-facing opt-out lives at the architecture §5 boundary (CLI flag /
 * config key), not here. This helper exists ONLY so the discovery test
 * suite can disable recording in cases where the tmp skills.db is not
 * provisioned.
 *
 * @internal
 */
export function __setSkillUsageRecorderEnabled(enabled: boolean): void {
  _enabled = enabled;
}

/**
 * Returns whether the recorder is currently enabled.
 *
 * @internal
 */
export function __isSkillUsageRecorderEnabled(): boolean {
  return _enabled;
}

/**
 * Record a single skill-usage event — best-effort, fire-and-forget.
 *
 * The DB write happens on a detached promise so the caller never awaits.
 * If the write fails (skills.db missing / locked / read-only filesystem /
 * schema drift / any other error), the failure is silently swallowed. This
 * is BY DESIGN — telemetry must never break skill loading.
 *
 * @example
 * ```typescript
 * recordSkillUsage('ct-orchestrator', 'load');
 * recordSkillUsage('my-skill', 'edit', { taskId: 'T9689' });
 * ```
 *
 * @param name - Skill identifier as returned by {@link findSkill} /
 *   {@link discoverSkill}.
 * @param action - The kind of usage event — see {@link SkillUsageAction}.
 * @param context - Optional `taskId` / `modelId` / metadata.
 *
 * @task T9689
 */
export function recordSkillUsage(
  name: string,
  action: SkillUsageAction,
  context?: SkillUsageContext,
): void {
  if (!_enabled) return;
  if (!name) return;

  const metadataObj = context?.metadata ?? {};
  const row: NewSkillUsageRow = {
    skillName: name,
    eventKind: action,
    taskId: context?.taskId ?? null,
    // T11544: attribute the usage event to the active project (null when
    // running outside any resolvable CLEO project — global usage stays valid).
    projectId: resolveActiveProjectId(),
    modelId: context?.modelId ?? null,
    metadata: JSON.stringify(metadataObj),
  };

  // Enqueue into the batched-write queue (T9694). The queue keeps the
  // hot path sync — no DB open, no INSERT — and coalesces bursts of skill
  // loads into a single batched INSERT on idle / capacity / beforeExit.
  try {
    enqueueSkillUsage(row);
  } catch {
    /* swallowed — telemetry MUST NOT block skill loading (architecture v3 §5) */
  }
}

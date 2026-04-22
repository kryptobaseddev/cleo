/**
 * Manifest entry builder — constructs a fully-populated
 * {@link ExtendedManifestEntry} from the minimal shorthand fields agents
 * and CLI callers provide.
 *
 * The `pipeline_manifest` validator (see `pipelineManifestAppend` in
 * `pipeline-manifest-sqlite.ts`) REJECTS entries missing any of:
 * `id`, `file`, `title`, `date`, `status`, `agent_type`, `topics`, `actionable`.
 * Agents writing to the manifest from a spawn prompt only know `task`, `type`,
 * and `content` — so this helper fills the rest with sensible defaults.
 *
 * Lives in `@cleocode/core` (SDK layer) so every consumer — CLI (`cleo
 * manifest append`), Studio, VS Code extension, API server, direct SDK
 * callers — produces identically-shaped entries without duplicating the
 * defaulting logic (AGENTS.md package-boundary rule / T1096 / ADR-027 §6.2).
 *
 * @task T1187-followup · v2026.4.113
 */

import type { ExtendedManifestEntry } from './index.js';

/**
 * Shorthand fields a subagent or CLI caller typically supplies.
 *
 * @remarks
 * Every field is optional to keep the helper flexible, but at least one of
 * `task` / `type` / `content` should be provided or the resulting entry will
 * carry only generic defaults.
 */
export interface ManifestShorthand {
  /** Task ID to associate — becomes `linked_tasks[0]` and the id prefix. */
  task?: string;
  /** Entry type — becomes `agent_type` (e.g. "research", "implementation"). */
  type?: string;
  /** One-paragraph summary — becomes `key_findings[0]` and (truncated) `title`. */
  content?: string;
  /** Explicit title override when the first line of `content` is not ideal. */
  title?: string;
  /** Entry status — defaults to `"completed"`. */
  status?: 'completed' | 'partial' | 'blocked';
  /** Explicit file path override (defaults to `.cleo/agent-outputs/<id>.md`). */
  file?: string;
  /** Optional date override (YYYY-MM-DD). Defaults to today (UTC). */
  date?: string;
  /** Optional explicit id override. Defaults to `<task>-<type>-<timestamp>`. */
  id?: string;
  /** Optional topic tags added in addition to the defaulted `[task, type]`. */
  extraTopics?: string[];
  /** Optional additional linked tasks beyond `task`. */
  extraLinkedTasks?: string[];
  /** Whether the findings are actionable — defaults to `false`. */
  actionable?: boolean;
  /** Explicit key_findings array — bypasses the content-to-bullet default. */
  keyFindings?: string[];
  /** Explicit needs_followup list — defaults to `[]`. */
  needsFollowup?: string[];
  /** Optional confidence score (0..1). */
  confidence?: number;
  /** Optional sha256:<hex> of the output file. */
  fileChecksum?: string;
  /** Optional wallclock duration in seconds. */
  durationSeconds?: number;
}

/**
 * Default entry type used when `shorthand.type` is omitted.
 *
 * Chosen to match the default spawn-prompt protocol phase so casual callers
 * without context land in the `implementation` bucket rather than something
 * surprising.
 */
export const DEFAULT_MANIFEST_ENTRY_TYPE = 'implementation';

/**
 * Build a fully-populated {@link ExtendedManifestEntry} from shorthand fields.
 *
 * @param shorthand - Partial shorthand; `task` / `type` / `content` are the
 *   most useful, everything else falls back to a sensible default.
 * @param now       - Optional injectable clock (defaults to real `new Date()`).
 *   Tests pass a frozen Date to pin the generated `id` timestamp.
 * @returns A manifest entry that satisfies every validator requirement for
 *   `pipeline.manifest.append`. Hand the result directly to
 *   `pipelineManifestAppend` or `dispatchFromCli('mutate', 'pipeline',
 *   'manifest.append', { entry })`.
 *
 * @example
 * ```ts
 * import { buildManifestEntryFromShorthand } from '@cleocode/core/memory';
 *
 * const entry = buildManifestEntryFromShorthand({
 *   task: 'T1187',
 *   type: 'implementation',
 *   content: 'Shipped tree viz overhaul',
 * });
 * // → { id: "T1187-implementation-<stamp>", file: "...", title: "...",
 * //     date: "YYYY-MM-DD", status: "completed", agent_type: "implementation",
 * //     topics: ["T1187","implementation"], key_findings: [...],
 * //     actionable: false, needs_followup: [], linked_tasks: ["T1187"] }
 * ```
 */
export function buildManifestEntryFromShorthand(
  shorthand: ManifestShorthand,
  now: Date = new Date(),
): ExtendedManifestEntry {
  const date = shorthand.date ?? now.toISOString().slice(0, 10);
  const stamp = now
    .toISOString()
    .replace(/[:T.-]/g, '')
    .slice(0, 14);
  const taskId = shorthand.task;
  const entryType = shorthand.type ?? DEFAULT_MANIFEST_ENTRY_TYPE;
  const content = shorthand.content ?? '';

  const id = shorthand.id ?? (taskId ? `${taskId}-${entryType}-${stamp}` : `manifest-${stamp}`);

  const firstLine = content.split('\n')[0]?.slice(0, 120) ?? '';
  const title =
    shorthand.title ??
    (firstLine || (taskId ? `${taskId} ${entryType}` : `Manifest entry ${stamp}`));

  const file =
    shorthand.file ??
    (taskId
      ? `.cleo/agent-outputs/${taskId}-${entryType}-${stamp}.md`
      : `.cleo/agent-outputs/${id}.md`);

  const status = shorthand.status ?? 'completed';

  const baseTopics = taskId ? [taskId, entryType] : [entryType];
  const topics = [...baseTopics, ...(shorthand.extraTopics ?? [])].filter(
    (t, i, arr) => arr.indexOf(t) === i,
  );

  const linkedBase = taskId ? [taskId] : [];
  const linked_tasks = [...linkedBase, ...(shorthand.extraLinkedTasks ?? [])].filter(
    (t, i, arr) => t && arr.indexOf(t) === i,
  );

  const key_findings = shorthand.keyFindings ?? (content ? [content] : []);

  const entry: ExtendedManifestEntry = {
    id,
    file,
    title,
    date,
    status,
    agent_type: entryType,
    topics,
    key_findings,
    actionable: shorthand.actionable ?? false,
    needs_followup: shorthand.needsFollowup ?? [],
    linked_tasks,
  };

  if (shorthand.confidence !== undefined) entry.confidence = shorthand.confidence;
  if (shorthand.fileChecksum !== undefined) entry.file_checksum = shorthand.fileChecksum;
  if (shorthand.durationSeconds !== undefined) entry.duration_seconds = shorthand.durationSeconds;

  return entry;
}

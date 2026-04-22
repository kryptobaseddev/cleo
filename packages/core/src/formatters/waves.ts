/**
 * Pure wave formatter — presentation-agnostic wave plan rendering.
 *
 * Exports {@link formatWaves} which renders an enriched wave array into one
 * of four output modes (rich, json, markdown, quiet) without importing any
 * CLI or platform-specific module.  ANSI colors are injected by the caller
 * via the optional `colorize` callback so that this module remains
 * dependency-free of terminal utilities.
 *
 * @module
 */

import type { ColorStyle, FormatMode, FormatOpts } from './tree.js';

// Re-export shared types so consumers can import everything from the barrel.
export type { ColorStyle, FormatMode, FormatOpts };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single task entry within an {@link EnrichedWave}.
 *
 * The `id` field is the only required property; all others are optional to
 * maintain backward compatibility with non-enriched wave responses that may
 * only carry string IDs.
 */
export interface WaveTask {
  /** Task identifier, e.g. `"T001"`. */
  id: string;
  /** Human-readable task title. */
  title?: string;
  /** Task status string, e.g. `"pending"`, `"active"`, `"done"`. */
  status?: string;
  /** Task priority string, e.g. `"critical"`, `"high"`, `"medium"`, `"low"`. */
  priority?: string;
  /** Open dependency IDs blocking this task.  Present after T1199 enrichment. */
  blockedBy?: string[];
  /**
   * Whether the task is immediately actionable (no open deps, not yet done).
   * Present after T1199 enrichment.
   */
  ready?: boolean;
}

/**
 * A single wave returned by `orchestrate.waves` / `deps waves`.
 *
 * Tasks may be either {@link WaveTask} objects (enriched) or plain strings
 * (non-enriched legacy format).
 */
export interface EnrichedWave {
  /** 1-based wave sequence number. */
  waveNumber?: number;
  /** Aggregate status of the wave: `"pending"`, `"in_progress"`, or `"completed"`. */
  status?: string;
  /** Tasks in this wave (enriched objects or plain IDs). */
  tasks?: Array<WaveTask | string>;
  /** ISO timestamp when all tasks in the wave completed (enriched format). */
  completedAt?: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Maps a status string to a compact display symbol.
 *
 * Unicode codepoints match {@link TASK_STATUS_SYMBOLS_UNICODE} from
 * `@cleocode/contracts` so that core formatter output is consistent with
 * the CLI renderer (no import needed — values are inlined for portability).
 */
const STATUS_SYMBOLS: Record<string, string> = {
  pending: '○', // ○  not yet started
  active: '◉', // ◉  in progress
  done: '✓', // ✓  complete
  blocked: '⊗', // ⊗  cannot advance
  cancelled: '✗', // ✗  abandoned
  archived: '▣', // ▣  stored, inactive
  proposed: '◇', // ◇  tier-2 proposal queue
};

function defaultStatusSymbol(status: string): string {
  return STATUS_SYMBOLS[status] ?? '?';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Format enriched wave data as a string in the requested mode.
 *
 * The function is pure — it has no side-effects and does not read from
 * `process.env` or the filesystem.  All terminal concerns are delegated to
 * the caller through {@link FormatOpts.colorize}.
 *
 * @param data - Normalized response payload containing a `waves` array.
 *               The key must be literally `"waves"`.
 * @param opts - Rendering options.  All fields are optional.
 * @returns    A formatted string in the requested mode, or a fallback
 *             message / empty string when `data.waves` is absent.
 *
 * @example
 * // Rich mode — plain text (no colorize)
 * const plain = formatWaves({ waves }, { mode: 'rich' });
 *
 * @example
 * // Rich mode — with ANSI color injection
 * const colored = formatWaves({ waves }, {
 *   mode: 'rich',
 *   colorize: (text, style) => applyAnsi(text, style),
 * });
 *
 * @example
 * // JSON mode — machine-readable passthrough
 * const json = formatWaves({ waves }, { mode: 'json' });
 * const parsed = JSON.parse(json); // { waves: [...] }
 *
 * @example
 * // Markdown mode — for GitHub issue comments
 * const md = formatWaves({ waves }, { mode: 'markdown' });
 *
 * @example
 * // Quiet mode — <waveNumber>\t<taskId> per line, safe for awk / cut
 * const quiet = formatWaves({ waves }, { mode: 'quiet' });
 */
export function formatWaves(data: { waves?: EnrichedWave[] }, opts?: FormatOpts): string {
  const mode = opts?.mode ?? 'rich';
  const colorize = opts?.colorize ?? identity;
  const waves = data.waves;

  if (!waves) {
    return mode === 'quiet' ? '' : 'No wave data.';
  }

  switch (mode) {
    case 'quiet':
      return formatWavesQuiet(waves);

    case 'json':
      return JSON.stringify({ waves });

    case 'markdown':
      return formatWavesMarkdown(waves);

    default:
      return formatWavesRich(waves, colorize);
  }
}

// ---------------------------------------------------------------------------
// Internal renderers
// ---------------------------------------------------------------------------

/**
 * Render waves in rich terminal mode.
 *
 * Output is byte-identical to the original CLI renderer in `system.ts` when
 * `colorize` injects equivalent ANSI sequences, because the same connector
 * characters (`├── `, `└── `) and status badge logic are applied.
 *
 * @param waves    - Array of {@link EnrichedWave} objects.
 * @param colorize - Color injection callback.
 */
function formatWavesRich(
  waves: EnrichedWave[],
  colorize: (text: string, style: ColorStyle) => string,
): string {
  const richLines: string[] = [];

  for (const wave of waves) {
    const waveNumber = wave.waveNumber;
    const status = wave.status;
    const tasks = wave.tasks;

    const waveHeader =
      `${colorize('Wave ' + (waveNumber ?? '?'), 'bold')}  ` + buildStatusBadge(status, colorize);
    richLines.push(waveHeader);

    if (tasks && tasks.length > 0) {
      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i]!;
        const isLast = i === tasks.length - 1;
        const connector = isLast ? '└── ' : '├── ';

        if (typeof t === 'string') {
          richLines.push(`  ${connector}${t}`);
        } else {
          const id = t.id;
          const title = t.title ?? '';
          const tStatus = t.status ?? '';
          const sSym = defaultStatusSymbol(tStatus);
          const coloredTitle = applyPriorityColor(title, t.priority, colorize);
          const indicator = buildBlockerIndicator(t.blockedBy, t.ready, colorize);

          richLines.push(
            `  ${connector}${sSym}${indicator} ${colorize(id, 'bold')} ${coloredTitle}`,
          );
        }
      }
    } else {
      richLines.push(`  ${colorize('(no tasks)', 'dim')}`);
    }

    richLines.push('');
  }

  return richLines.join('\n').trimEnd();
}

/**
 * Render waves as GitHub-flavored Markdown.
 *
 * Format: `## Wave N — status\n\n- [status] TID Title\n`.
 * No ANSI sequences are emitted.
 *
 * @param waves - Array of {@link EnrichedWave} objects.
 */
function formatWavesMarkdown(waves: EnrichedWave[]): string {
  const lines: string[] = [];

  for (const wave of waves) {
    const waveNumber = wave.waveNumber;
    const status = wave.status;
    const tasks = wave.tasks;

    lines.push(`## Wave ${waveNumber ?? '?'} — ${status ?? 'pending'}`);
    lines.push('');

    if (tasks && tasks.length > 0) {
      for (const t of tasks) {
        if (typeof t === 'string') {
          lines.push(`- ${t}`);
        } else {
          const id = t.id;
          const title = t.title ?? '';
          const tStatus = t.status ?? '';
          lines.push(`- [${tStatus}] ${id} ${title}`);
        }
      }
    } else {
      lines.push('_No tasks in this wave._');
    }

    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

/**
 * Render waves in quiet mode.
 *
 * Emits one `<waveNumber>\t<taskId>` line per task across all waves.
 * No decoration — safe for `awk` / `cut` / shell pipelines.
 *
 * @param waves - Array of {@link EnrichedWave} objects.
 */
function formatWavesQuiet(waves: EnrichedWave[]): string {
  return waves
    .flatMap((w) => {
      const waveNumber = w.waveNumber;
      const tasks = w.tasks;
      if (!tasks) return [];
      return tasks.map((t) => {
        const id = typeof t === 'string' ? t : t.id;
        return `${waveNumber ?? '?'}\t${id}`;
      });
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Helper utilities
// ---------------------------------------------------------------------------

/** Identity function — returns text unchanged (default colorize). */
function identity(text: string, _style: ColorStyle): string {
  return text;
}

/**
 * Build a colored status badge for a wave header.
 *
 * - `'completed'`  → green text
 * - `'in_progress'` → yellow text
 * - `(other)`      → dim text
 *
 * @param status   - Wave status string (may be undefined).
 * @param colorize - Color injection callback.
 */
function buildStatusBadge(
  status: string | undefined,
  colorize: (text: string, style: ColorStyle) => string,
): string {
  const s = status ?? 'pending';
  if (s === 'completed') return colorize(s, 'green');
  if (s === 'in_progress') return colorize(s, 'yellow');
  return colorize(s, 'dim');
}

/**
 * Apply priority-based color to a title string via the caller's colorize.
 *
 * Maps priority strings to {@link ColorStyle} tokens:
 * - `'critical'` → `'red'`
 * - `'high'`     → `'yellow'`
 * - `'medium'`   → `'blue'`
 * - `'low'`      → `'dim'`
 * - (none/other) → no color applied
 *
 * @param title    - Task title string.
 * @param priority - Task priority string (may be undefined).
 * @param colorize - Color injection callback.
 */
function applyPriorityColor(
  title: string,
  priority: string | undefined,
  colorize: (text: string, style: ColorStyle) => string,
): string {
  switch (priority) {
    case 'critical':
      return colorize(title, 'red');
    case 'high':
      return colorize(title, 'yellow');
    case 'medium':
      return colorize(title, 'blue');
    case 'low':
      return colorize(title, 'dim');
    default:
      return title;
  }
}

/**
 * Build a blocker indicator string for rich mode.
 *
 * - Blocked by N open deps → `colorize("⊗(N)", "red")`
 * - Ready (no open deps, immediately actionable) → `colorize("●", "green")`
 * - Otherwise → `""`
 *
 * @param blockedBy - Open dependency IDs (may be undefined for pre-T1199 nodes).
 * @param ready     - Whether the task is immediately actionable.
 * @param colorize  - Color injection callback.
 */
function buildBlockerIndicator(
  blockedBy: string[] | undefined,
  ready: boolean | undefined,
  colorize: (text: string, style: ColorStyle) => string,
): string {
  if (blockedBy !== undefined && blockedBy.length > 0) {
    return ` ${colorize(`⊗(${blockedBy.length})`, 'red')}`;
  }
  if (ready === true) {
    return ` ${colorize('●', 'green')}`;
  }
  return '';
}

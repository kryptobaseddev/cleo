/**
 * Wave plan renderer for `cleo orchestrate waves` / `cleo deps waves`.
 *
 * Migrated from `packages/cleo/src/cli/renderers/system.ts` (T10131 — B6).
 *
 * Delegates to {@link formatWaves} in the core formatters, injecting
 * the {@link cliColorize} adapter so that all ANSI concerns stay in the
 * render layer.
 *
 * @task T10131
 */

import { formatWaves } from '../../formatters/index.js';
import { cliColorize } from '../cli-colorize.js';

/**
 * Output mode for {@link renderWaves}.
 *
 * - `'rich'`     — Full terminal output with ANSI colors, wave headers,
 *                  status badges, priority colors, and blocker indicators.
 * - `'json'`     — Passthrough: returns `JSON.stringify({ waves })` so the
 *                  caller receives machine-readable data.
 * - `'markdown'` — GitHub-flavored Markdown: `## Wave N — status\n- [status] ID Title`
 * - `'quiet'`    — One `<waveNumber>\t<taskId>` line per task (script-extractable).
 */
export type RenderWavesMode = 'rich' | 'json' | 'markdown' | 'quiet';

/**
 * Options for {@link renderWaves}.
 */
export interface RenderWavesOptions {
  /**
   * Output mode.
   *
   * @defaultValue `'rich'`
   */
  mode?: RenderWavesMode;
  /** Epic ID displayed in the rich-mode header (e.g. `"T100"`). */
  epicId?: string;
  /** Total number of waves, used in the rich-mode header. */
  totalWaves?: number;
  /** Total number of tasks, used in the rich-mode header. */
  totalTasks?: number;
}

/**
 * Render wave data from `orchestrate.waves` / `deps waves` output.
 *
 * Supports four output modes controlled by `opts.mode`:
 *
 * - **rich** (default): Terminal-friendly output with wave headers, ANSI
 *   status badges, priority-colored titles, and blocker indicators.
 * - **json**: Returns `JSON.stringify({ waves })` — a raw passthrough for
 *   machine-readable consumers that have already obtained the data payload.
 * - **markdown**: GitHub-flavored Markdown suitable for issue comments or
 *   documentation. Format: `## Wave N — status\n- [status] TID Title\n`.
 * - **quiet**: One `<waveNumber>\t<taskId>` line per task across all waves,
 *   with no decoration — safe for `awk` / `cut` / shell pipelines.
 *
 * The function is the canonical wave renderer. {@link renderTree} delegates
 * to it when `data.waves` is present.
 *
 * @param data - Normalized response payload containing `data.waves`.
 * @param opts - Rendering options.
 */
export function renderWaves(data: Record<string, unknown>, opts?: RenderWavesOptions): string {
  // Delegate to the core formatter, injecting the CLI ANSI colorize adapter.
  // The data shape is compatible: waves.ts accepts { waves?: EnrichedWave[] }
  // and data has the same structure (waves key).
  return formatWaves(data as Parameters<typeof formatWaves>[0], {
    mode: opts?.mode ?? 'rich',
    colorize: cliColorize,
  });
}

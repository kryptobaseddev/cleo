/**
 * Animation bridge — single place that wires the resolved CLI format context
 * into a {@link SpinnerHandle} from `@cleocode/animations`.
 *
 * @remarks
 * Centralising this here means every dispatch path uses the same render gate
 * (LAFS `FlagResolution` → `AnimateContext` → spinner). The `AnimateContext`
 * is silent on `--json`, `--quiet`, non-TTY, and `NO_COLOR`, so callers can
 * unconditionally call `start()`/`stop()` without branching on output mode.
 *
 * Lint rule: any `process.stdout.write` of a string starting with `\r` outside
 * `@cleocode/animations` is a violation. Route through this helper.
 */

import {
  type CanonSpinnerName,
  createAnimateContext,
  createSpinnerHandle,
  type SpinnerHandle,
} from '@cleocode/animations';
import { getFormatContext } from './format-context.js';

/**
 * Map a `domain.operation` pair (e.g. `tasks.list`) to a friendly user label
 * and a canon spinner that matches the activity. Conservative defaults: any
 * unknown pair falls back to "Working…" + the `weaving` spinner.
 */
function deriveSpinnerLabel(
  domain: string,
  operation: string,
): { label: string; spinner: CanonSpinnerName } {
  const key = `${domain}.${operation}`;
  // Hot paths get specific labels; the rest fall through to a sensible default.
  // Keep this table small — the goal is reassuring feedback, not micro-tuning.
  switch (key) {
    case 'tasks.list':
    case 'tasks.find':
    case 'tasks.search':
      return { label: 'Searching tasks…', spinner: 'sweeping' };
    case 'tasks.show':
    case 'tasks.depends':
      return { label: 'Loading task…', spinner: 'weaving' };
    case 'tasks.tree':
    case 'tasks.deps.tree':
    case 'tasks.deps.validate':
      return { label: 'Building dep graph…', spinner: 'looming' };
    case 'orchestrate.waves':
    case 'orchestrate.ready':
      return { label: 'Computing waves…', spinner: 'tapestry' };
    case 'session.briefing.show':
    case 'session.status':
      return { label: 'Resolving session…', spinner: 'awakening' };
    case 'memory.find':
    case 'brain.find':
    case 'brain.digest':
      return { label: 'Querying BRAIN…', spinner: 'refinery' };
    case 'nexus.query':
    case 'nexus.context':
    case 'nexus.impact':
      return { label: 'Walking the graph…', spinner: 'looming' };
    default:
      return { label: 'Working…', spinner: 'weaving' };
  }
}

/**
 * Create a spinner for the given dispatch invocation.
 *
 * The returned handle is a no-op when the format context is JSON/quiet or the
 * environment is non-TTY/NO_COLOR. Callers should `start()` before the await
 * and `stop()` in a `finally` block so the cursor is always restored.
 */
export function createDispatchSpinner(domain: string, operation: string): SpinnerHandle {
  const flagResolution = getFormatContext();
  const animCtx = createAnimateContext({ flagResolution });
  const { label, spinner } = deriveSpinnerLabel(domain, operation);
  return createSpinnerHandle(animCtx, spinner, label);
}

/**
 * scaffold-global SDK Tool — pure-functional label on `ensureGlobalScaffold`.
 *
 * Wraps the three global-scope `ensure*` calls (home, templates, CleoOS hub)
 * into a single typed entry point for SDK consumers that need to provision
 * the global `~/.local/share/cleo/` directory tree without going through
 * the `cleo init` command.
 *
 * Taxonomy: Category B SDK Tool (ADR-064).
 *
 * @example
 * ```typescript
 * import { scaffoldGlobal } from '@cleocode/core/tools/scaffold-global';
 *
 * const result = await scaffoldGlobal();
 * console.log(result.home.action);      // 'created' | 'repaired' | 'skipped'
 * console.log(result.templates.action); // 'created' | 'repaired' | 'skipped'
 * ```
 *
 * @task T10069 (T9835b — Saga T9831)
 * @epic T9835
 */

import type { ScaffoldGlobalResult } from '@cleocode/contracts/project-tools';
import { ensureGlobalScaffold } from '../scaffold.js';

export type { ScaffoldGlobalResult };

/**
 * Provision the global CLEO home directory tree.
 *
 * Delegates to `ensureGlobalScaffold()` and adds a `success` flag so
 * callers can treat the result uniformly alongside other SDK tool results.
 *
 * Steps:
 * - `home`      — `~/.local/share/cleo/` (or platform equivalent)
 * - `templates` — `~/.local/share/cleo/templates/`
 * - `cleoosHub` — CleoOS hub directory tree copied from npm package templates
 *
 * All three steps are idempotent and never overwrite existing files.
 *
 * @returns Typed result for each global scaffold step plus `success` flag.
 */
export async function scaffoldGlobal(): Promise<ScaffoldGlobalResult> {
  const { home, templates, cleoosHub } = await ensureGlobalScaffold();
  return { home, templates, cleoosHub, success: true };
}

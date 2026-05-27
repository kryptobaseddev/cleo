/**
 * `cleo templates upgrade <id> [--project <root>] [--diff] [--accept]` —
 * reconcile an installed template against the shipped copy, respecting the
 * entry's `updateStrategy`.
 *
 * Strategy semantics:
 *   - `overwrite-on-bump` — overwrite unconditionally.
 *   - `diff-prompt`       — emit the diff; require `--accept` to apply.
 *   - `immutable`         — never overwrite; return `skipped: true`.
 *   - `manifest-merge`    — three-way merge (stub: returns `notSupported`).
 *
 * The `--diff` flag forces preview-only mode regardless of strategy — useful
 * for CI dry-runs and `templates diff` consumers that want a single CLI
 * surface for "what would change".
 *
 * @task T9886
 * @saga T9855
 * @epic T9874
 * @adr 076
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ExitCode, type UpdateStrategy } from '@cleocode/contracts';
import { getTemplateById } from '@cleocode/core/templates/registry';
import { defineCommand } from '../../lib/define-cli-command.js';
import { cliError, cliOutput } from '../../renderers/index.js';
import { unifiedDiff } from './diff.js';
import { applySubstitution, readTemplateSource, resolveProjectRoot } from './lib.js';

/**
 * Outcome discriminator emitted by `cleo templates upgrade`.
 *
 * - `overwritten` — the destination file was replaced.
 * - `noop`        — destination already matched the rendered source.
 * - `skipped`     — `immutable` strategy or `diff-prompt` without `--accept`.
 * - `not-supported` — strategy not yet implemented (e.g. `manifest-merge`).
 *
 * @public
 */
export type TemplatesUpgradeOutcome = 'overwritten' | 'noop' | 'skipped' | 'not-supported';

/**
 * Result shape returned by `cleo templates upgrade`.
 *
 * @public
 */
export interface TemplatesUpgradeResult {
  /** The template id that was reconciled. */
  id: string;
  /** Absolute path of the install destination. */
  installPath: string;
  /** The entry's declared `updateStrategy`. */
  updateStrategy: UpdateStrategy;
  /** What actually happened. */
  outcome: TemplatesUpgradeOutcome;
  /** Why we took that path — surfaced for humans + CI logs. */
  reason: string;
  /** Diff body (unified-style) when applicable; empty otherwise. */
  diff: string;
}

/**
 * citty command — `cleo templates upgrade <id> [--project <root>] [--diff] [--accept]`.
 *
 * @public
 */
export const templatesUpgradeCommand = defineCommand({
  meta: {
    name: 'upgrade',
    description:
      'Re-install a template respecting its updateStrategy (overwrite | diff-prompt | immutable | manifest-merge)',
  },
  args: {
    id: {
      type: 'positional',
      required: true,
      description: 'Template id (kebab-case)',
    },
    project: {
      type: 'string',
      description: 'Project root to upgrade against (default: detected project root)',
    },
    diff: {
      type: 'boolean',
      description: 'Preview-only — print the diff without writing',
    },
    accept: {
      type: 'boolean',
      description: 'Apply when strategy is diff-prompt (no-op otherwise)',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    const id = String(args['id'] ?? '').trim();
    if (id.length === 0) {
      cliError(`templates upgrade failed: <id> is required`, ExitCode.INVALID_INPUT, {
        name: 'E_TEMPLATES_UPGRADE_FAILED',
      });
      process.exit(ExitCode.INVALID_INPUT);
      return;
    }

    const entry = getTemplateById(id);
    if (entry === undefined) {
      cliError(`templates upgrade failed: id "${id}" not found`, ExitCode.NOT_FOUND, {
        name: 'E_NOT_FOUND',
        details: { id },
      });
      process.exit(ExitCode.NOT_FOUND);
      return;
    }

    let projectRoot: string;
    let installPath: string;
    let rendered: string;
    try {
      projectRoot = resolveProjectRoot(args['project'] as string | undefined);
      installPath = join(projectRoot, entry.installPath);
      const source = readTemplateSource(entry);
      rendered = applySubstitution(entry, source).rendered;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(`templates upgrade failed: ${message}`, ExitCode.GENERAL_ERROR, {
        name: 'E_TEMPLATES_UPGRADE_FAILED',
      });
      process.exit(ExitCode.GENERAL_ERROR);
      return;
    }

    const previewOnly = args['diff'] === true;
    const accept = args['accept'] === true;
    const current = existsSync(installPath) ? readFileSync(installPath, 'utf8') : null;
    const diffBody =
      current === null ? '' : current === rendered ? '' : unifiedDiff(current, rendered);

    let outcome: TemplatesUpgradeOutcome;
    let reason: string;
    let shouldWrite = false;

    if (entry.updateStrategy === 'manifest-merge') {
      outcome = 'not-supported';
      reason = 'manifest-merge upgrade is not yet supported (T9886-followup)';
    } else if (entry.updateStrategy === 'immutable') {
      outcome = 'skipped';
      reason =
        current === null
          ? 'immutable: not installed yet — use `install`'
          : 'immutable: skipped per strategy';
    } else if (current !== null && current === rendered) {
      outcome = 'noop';
      reason = 'already current';
    } else if (entry.updateStrategy === 'overwrite-on-bump') {
      if (previewOnly) {
        outcome = 'skipped';
        reason = 'preview-only (--diff)';
      } else {
        outcome = 'overwritten';
        reason = current === null ? 'fresh install' : 'overwrite-on-bump';
        shouldWrite = true;
      }
    } else {
      // diff-prompt
      if (previewOnly || !accept) {
        outcome = 'skipped';
        reason = previewOnly ? 'preview-only (--diff)' : 'diff-prompt: pass --accept to apply';
      } else {
        outcome = 'overwritten';
        reason = 'diff-prompt: accepted';
        shouldWrite = true;
      }
    }

    if (shouldWrite) {
      try {
        mkdirSync(dirname(installPath), { recursive: true });
        writeFileSync(installPath, rendered, 'utf8');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        cliError(`templates upgrade failed: ${message}`, ExitCode.GENERAL_ERROR, {
          name: 'E_TEMPLATES_UPGRADE_FAILED',
        });
        process.exit(ExitCode.GENERAL_ERROR);
        return;
      }
    }

    const result: TemplatesUpgradeResult = {
      id,
      installPath,
      updateStrategy: entry.updateStrategy,
      outcome,
      reason,
      diff: diffBody,
    };
    cliOutput(result, {
      command: 'templates-upgrade',
      operation: 'templates.upgrade',
    });
  },
});

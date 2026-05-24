/**
 * `cleo templates diff <id> [--project <root>]` — compute the diff between
 * a template's rendered source and the deployed copy at its `installPath`.
 *
 * Exits 0 when the two are identical (`same: true`); exits 1 when they
 * differ. The diff payload is a unified-format string suitable for shell
 * pipelines.
 *
 * @task T9886
 * @saga T9855
 * @epic T9874
 * @adr 076
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ExitCode } from '@cleocode/contracts';
import { getTemplateById } from '@cleocode/core/templates/registry';
import { defineCommand } from '../../lib/define-cli-command.js';
import { cliError, cliOutput } from '../../renderers/index.js';
import { applySubstitution, readTemplateSource, resolveProjectRoot } from './lib.js';

/**
 * Result shape returned by `cleo templates diff`.
 *
 * @public
 */
export interface TemplatesDiffResult {
  /** The template id that was diffed. */
  id: string;
  /** Absolute path of the install destination. */
  installPath: string;
  /** `true` IFF the installed file matches the rendered source byte-for-byte. */
  same: boolean;
  /** `true` when no file exists at `installPath` (treated as "differs"). */
  missing: boolean;
  /** Unified-format diff body. Empty string when `same === true`. */
  diff: string;
}

/**
 * citty command — `cleo templates diff <id> [--project <root>]`.
 *
 * @public
 */
export const templatesDiffCommand = defineCommand({
  meta: {
    name: 'diff',
    description: 'Diff a template against its installed copy (exit 0 same, 1 different)',
  },
  args: {
    id: {
      type: 'positional',
      required: true,
      description: 'Template id (kebab-case)',
    },
    project: {
      type: 'string',
      description: 'Project root to diff against (default: detected project root)',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    const id = String(args['id'] ?? '').trim();
    if (id.length === 0) {
      cliError(`templates diff failed: <id> is required`, ExitCode.INVALID_INPUT, {
        name: 'E_TEMPLATES_DIFF_FAILED',
      });
      process.exit(ExitCode.INVALID_INPUT);
      return;
    }

    const entry = getTemplateById(id);
    if (entry === undefined) {
      cliError(`templates diff failed: id "${id}" not found`, ExitCode.NOT_FOUND, {
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
      cliError(`templates diff failed: ${message}`, ExitCode.GENERAL_ERROR, {
        name: 'E_TEMPLATES_DIFF_FAILED',
      });
      process.exit(ExitCode.GENERAL_ERROR);
      return;
    }

    if (!existsSync(installPath)) {
      const missingResult: TemplatesDiffResult = {
        id,
        installPath,
        same: false,
        missing: true,
        diff: `--- (missing) ${installPath}\n+++ (rendered) ${id}\n${unifiedDiff('', rendered)}`,
      };
      cliOutput(missingResult, {
        command: 'templates-diff',
        operation: 'templates.diff',
      });
      process.exit(ExitCode.GENERAL_ERROR);
      return;
    }

    const current = readFileSync(installPath, 'utf8');
    const same = current === rendered;
    const result: TemplatesDiffResult = {
      id,
      installPath,
      same,
      missing: false,
      diff: same ? '' : unifiedDiff(current, rendered),
    };
    cliOutput(result, {
      command: 'templates-diff',
      operation: 'templates.diff',
    });
    if (!same) {
      process.exit(ExitCode.GENERAL_ERROR);
    }
  },
});

/**
 * Minimal line-by-line diff renderer — emits a stable, dependency-free
 * unified-style body. Each removed line is prefixed `-`, each added line `+`,
 * unchanged lines are emitted as ` `. Adequate for envelope payloads + the
 * `cleo templates upgrade --diff` preview path.
 *
 * Not intended as a full Hunt-McIlroy diff — when richer output is required,
 * callers can pipe the rendered text through `git diff --no-index`.
 *
 * @internal
 */
export function unifiedDiff(a: string, b: string): string {
  const aLines = a.length === 0 ? [] : a.split('\n');
  const bLines = b.length === 0 ? [] : b.split('\n');
  const out: string[] = [];
  const max = Math.max(aLines.length, bLines.length);
  for (let i = 0; i < max; i += 1) {
    const av = aLines[i];
    const bv = bLines[i];
    if (av === bv) {
      if (av !== undefined) out.push(` ${av}`);
      continue;
    }
    if (av !== undefined) out.push(`-${av}`);
    if (bv !== undefined) out.push(`+${bv}`);
  }
  return out.join('\n');
}

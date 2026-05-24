/**
 * `cleo templates validate [--id <id>]` — verify the registry's invariants
 * against the live filesystem.
 *
 * Two checks per entry:
 *   1. The source file at `resolveSourcePathAbsolute(entry)` exists.
 *   2. `getInstalledStatus(id, projectRoot)` resolves without throwing.
 *
 * Without `--id` the command walks every entry returned by
 * `getTemplateManifest()`. With `--id` it validates a single entry and
 * returns `E_NOT_FOUND` when the id is unknown.
 *
 * Exits 0 when every check passes; exits with `VALIDATION_ERROR` (6) when
 * any entry reports a failure.
 *
 * @task T9886
 * @saga T9855
 * @epic T9874
 * @adr 076
 */

import { ExitCode, type TemplateKind } from '@cleocode/contracts';
import {
  getInstalledStatus,
  getTemplateById,
  getTemplateManifest,
  resolveSourcePathAbsolute,
} from '@cleocode/core/templates/registry';
import { defineCommand } from '../../lib/define-cli-command.js';
import { cliError, cliOutput } from '../../renderers/index.js';
import { resolveProjectRoot } from './lib.js';

/**
 * Per-entry validation outcome.
 *
 * @public
 */
export interface TemplatesValidateEntry {
  /** Template id from the manifest. */
  id: string;
  /** Template kind. */
  kind: TemplateKind;
  /** `true` when the source file resolves and exists on disk. */
  sourceExists: boolean;
  /** Absolute path the registry resolved for the source (when resolvable). */
  sourcePath: string | null;
  /** `true` when the installed copy exists at the destination. */
  installed: boolean;
  /** Absolute path of the install destination. */
  installPath: string | null;
  /** Validation issues — empty when the entry is clean. */
  issues: string[];
}

/**
 * Result shape returned by `cleo templates validate`.
 *
 * @public
 */
export interface TemplatesValidateResult {
  /** `true` IFF every entry in `entries` passed every gate. */
  ok: boolean;
  /** Number of entries validated. */
  count: number;
  /** Per-entry breakdown. */
  entries: TemplatesValidateEntry[];
}

/**
 * citty command — `cleo templates validate [--id <id>] [--project <root>]`.
 *
 * @public
 */
export const templatesValidateCommand = defineCommand({
  meta: {
    name: 'validate',
    description: 'Validate every registry entry (or one --id) against the live filesystem',
  },
  args: {
    id: {
      type: 'string',
      description: 'Validate a single entry by id (default: walk every entry)',
    },
    project: {
      type: 'string',
      description: 'Project root to probe install status against (default: detected)',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    let projectRoot: string;
    try {
      projectRoot = resolveProjectRoot(args['project'] as string | undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(`templates validate failed: ${message}`, ExitCode.GENERAL_ERROR, {
        name: 'E_TEMPLATES_VALIDATE_FAILED',
      });
      process.exit(ExitCode.GENERAL_ERROR);
      return;
    }

    const idFilter = typeof args['id'] === 'string' && args['id'].length > 0 ? args['id'] : null;
    let targets: ReturnType<typeof getTemplateManifest>;
    if (idFilter === null) {
      targets = getTemplateManifest();
    } else {
      const entry = getTemplateById(idFilter);
      if (entry === undefined) {
        cliError(`templates validate failed: id "${idFilter}" not found`, ExitCode.NOT_FOUND, {
          name: 'E_NOT_FOUND',
          details: { id: idFilter },
        });
        process.exit(ExitCode.NOT_FOUND);
        return;
      }
      targets = [entry];
    }

    const entries: TemplatesValidateEntry[] = targets.map((entry) => {
      const issues: string[] = [];
      let sourcePath: string | null = null;
      let sourceExists = false;
      try {
        sourcePath = resolveSourcePathAbsolute(entry);
        sourceExists = true;
      } catch (err) {
        issues.push(`source: ${err instanceof Error ? err.message : String(err)}`);
      }
      let installed = false;
      let installPath: string | null = null;
      try {
        const status = getInstalledStatus(entry.id, projectRoot);
        installed = status.installed;
        installPath = status.path;
      } catch (err) {
        issues.push(`install: ${err instanceof Error ? err.message : String(err)}`);
      }
      return {
        id: entry.id,
        kind: entry.kind,
        sourceExists,
        sourcePath,
        installed,
        installPath,
        issues,
      };
    });

    const ok = entries.every((e) => e.issues.length === 0);
    const result: TemplatesValidateResult = {
      ok,
      count: entries.length,
      entries,
    };
    cliOutput(result, {
      command: 'templates-validate',
      operation: 'templates.validate',
    });
    if (!ok) {
      process.exit(ExitCode.VALIDATION_ERROR);
    }
  },
});

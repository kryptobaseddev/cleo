/**
 * `cleo templates install <id> [--project <root>]` — install a single
 * template into a project root, respecting its substitution strategy.
 *
 * Idempotent: when the destination already exists AND its contents match the
 * rendered source byte-for-byte, the command emits `installed: false` with
 * `noop: true` and exits 0. Otherwise the file is written (mkdir -p) and
 * `installed: true` is reported.
 *
 * Substitution is currently a pass-through stub — see `./lib.ts`. The CLI
 * surface is the same regardless of whether the placeholder pipeline lands
 * later.
 *
 * @task T9886
 * @saga T9855
 * @epic T9874
 * @adr 076
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ExitCode } from '@cleocode/contracts';
import { getTemplateById } from '@cleocode/core/templates/registry';
import { defineCommand } from '../../lib/define-cli-command.js';
import { cliError, cliOutput } from '../../renderers/index.js';
import { applySubstitution, readTemplateSource, resolveProjectRoot } from './lib.js';

/**
 * Result shape returned by `cleo templates install`.
 *
 * @public
 */
export interface TemplatesInstallResult {
  /** The template id that was installed. */
  id: string;
  /** Absolute path of the install destination. */
  installPath: string;
  /** `true` when the file was written; `false` when it was already current. */
  installed: boolean;
  /** `true` when nothing changed on disk (idempotent skip). */
  noop: boolean;
  /** Whether any placeholders were substituted (currently always `false`). */
  substituted: boolean;
}

/**
 * citty command — `cleo templates install <id> [--project <root>]`.
 *
 * @public
 */
export const templatesInstallCommand = defineCommand({
  meta: {
    name: 'install',
    description: 'Install a template into a project root (default: current project), idempotent',
  },
  args: {
    id: {
      type: 'positional',
      required: true,
      description: 'Template id (kebab-case)',
    },
    project: {
      type: 'string',
      description: 'Project root to install into (default: detected project root)',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    const id = String(args['id'] ?? '').trim();
    if (id.length === 0) {
      cliError(`templates install failed: <id> is required`, ExitCode.INVALID_INPUT, {
        name: 'E_TEMPLATES_INSTALL_FAILED',
      });
      process.exit(ExitCode.INVALID_INPUT);
      return;
    }

    const entry = getTemplateById(id);
    if (entry === undefined) {
      cliError(`templates install failed: id "${id}" not found`, ExitCode.NOT_FOUND, {
        name: 'E_NOT_FOUND',
        details: { id },
      });
      process.exit(ExitCode.NOT_FOUND);
      return;
    }

    let projectRoot: string;
    let installPath: string;
    let rendered: string;
    let substituted: boolean;
    try {
      projectRoot = resolveProjectRoot(args['project'] as string | undefined);
      installPath = join(projectRoot, entry.installPath);
      const source = readTemplateSource(entry);
      const sub = applySubstitution(entry, source);
      rendered = sub.rendered;
      substituted = sub.substituted;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(`templates install failed: ${message}`, ExitCode.GENERAL_ERROR, {
        name: 'E_TEMPLATES_INSTALL_FAILED',
      });
      process.exit(ExitCode.GENERAL_ERROR);
      return;
    }

    if (existsSync(installPath)) {
      const current = readFileSync(installPath, 'utf8');
      if (current === rendered) {
        const noopResult: TemplatesInstallResult = {
          id,
          installPath,
          installed: false,
          noop: true,
          substituted,
        };
        cliOutput(noopResult, {
          command: 'templates-install',
          operation: 'templates.install',
        });
        return;
      }
    }

    try {
      mkdirSync(dirname(installPath), { recursive: true });
      writeFileSync(installPath, rendered, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(`templates install failed: ${message}`, ExitCode.GENERAL_ERROR, {
        name: 'E_TEMPLATES_INSTALL_FAILED',
      });
      process.exit(ExitCode.GENERAL_ERROR);
      return;
    }

    const result: TemplatesInstallResult = {
      id,
      installPath,
      installed: true,
      noop: false,
      substituted,
    };
    cliOutput(result, {
      command: 'templates-install',
      operation: 'templates.install',
    });
  },
});

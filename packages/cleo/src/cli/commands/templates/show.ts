/**
 * `cleo templates show <id>` — print a single template registry entry.
 *
 * Thin wrapper over `getTemplateById` from the CORE registry
 * (`@cleocode/core/templates/registry`, T9877). Returns `E_NOT_FOUND` when
 * the id is unknown.
 *
 * @task T9886
 * @saga T9855
 * @epic T9874
 * @adr 076
 */

import { ExitCode, type TemplateManifestEntry } from '@cleocode/contracts';
import { getTemplateById } from '@cleocode/core/templates/registry';
import { defineCommand } from '../../lib/define-cli-command.js';
import { cliError, cliOutput } from '../../renderers/index.js';

/**
 * Result shape returned by `cleo templates show`.
 *
 * @public
 */
export interface TemplatesShowResult {
  /** The id that was requested. */
  id: string;
  /** The matching manifest entry. */
  entry: TemplateManifestEntry;
}

/**
 * citty command — `cleo templates show <id>`.
 *
 * @public
 */
export const templatesShowCommand = defineCommand({
  meta: {
    name: 'show',
    description: 'Print a single template manifest entry by id',
  },
  args: {
    id: {
      type: 'positional',
      required: true,
      description: 'Template id (kebab-case)',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    const id = String(args['id'] ?? '').trim();
    if (id.length === 0) {
      cliError(`templates show failed: <id> is required`, ExitCode.INVALID_INPUT, {
        name: 'E_TEMPLATES_SHOW_FAILED',
      });
      process.exit(ExitCode.INVALID_INPUT);
      return;
    }

    const entry = getTemplateById(id);
    if (entry === undefined) {
      cliError(`templates show failed: id "${id}" not found`, ExitCode.NOT_FOUND, {
        name: 'E_NOT_FOUND',
        details: { id },
      });
      process.exit(ExitCode.NOT_FOUND);
      return;
    }

    const result: TemplatesShowResult = { id, entry };
    cliOutput(result, {
      command: 'templates-show',
      operation: 'templates.show',
    });
  },
});

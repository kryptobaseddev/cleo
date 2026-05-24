/**
 * `cleo templates list [--kind ...]` — list every template the registry
 * knows about, optionally filtered by `TemplateKind`.
 *
 * Thin wrapper over `getTemplateManifest` / `getTemplatesByKind` from the
 * CORE registry (`@cleocode/core/templates/registry`, T9877).
 *
 * @task T9886
 * @saga T9855
 * @epic T9874
 * @adr 076
 */

import {
  ExitCode,
  TEMPLATE_KINDS,
  type TemplateKind,
  type TemplateManifestEntry,
} from '@cleocode/contracts';
import { getTemplateManifest, getTemplatesByKind } from '@cleocode/core/templates/registry';
import { defineCommand } from '../../lib/define-cli-command.js';
import { cliError, cliOutput } from '../../renderers/index.js';

/**
 * Result shape returned by `cleo templates list`.
 *
 * Carries the (optional) kind filter that was applied and the matching
 * registry entries.
 *
 * @public
 */
export interface TemplatesListResult {
  /** The kind filter that was applied, or `null` when no filter was given. */
  kind: TemplateKind | null;
  /** Matching template manifest entries. */
  entries: readonly TemplateManifestEntry[];
}

/**
 * citty command — `cleo templates list [--kind ...]`.
 *
 * @public
 */
export const templatesListCommand = defineCommand({
  meta: {
    name: 'list',
    description: 'List every template the registry knows about (optionally filtered by --kind)',
  },
  args: {
    kind: {
      type: 'string',
      description: `Optional kind filter: ${TEMPLATE_KINDS.join(' | ')}`,
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    const rawKind = args['kind'];
    const kind = parseTemplateKind(typeof rawKind === 'string' ? rawKind : undefined);
    if (kind === null && rawKind !== undefined && rawKind !== '') {
      cliError(
        `templates list failed: invalid --kind (must be ${TEMPLATE_KINDS.join('|')})`,
        ExitCode.INVALID_INPUT,
        { name: 'E_TEMPLATES_LIST_FAILED' },
      );
      process.exit(ExitCode.INVALID_INPUT);
      return;
    }

    const entries = kind === null ? getTemplateManifest() : getTemplatesByKind(kind);
    const result: TemplatesListResult = { kind, entries };
    cliOutput(result, {
      command: 'templates-list',
      operation: 'templates.list',
    });
  },
});

/**
 * Validate a string against the `TemplateKind` union. Returns `null` for
 * unset/empty input AND for unknown values — callers distinguish "no filter"
 * from "bad filter" by checking the original argument.
 *
 * @internal
 */
function parseTemplateKind(raw: string | undefined): TemplateKind | null {
  if (raw === undefined || raw === '') return null;
  return (TEMPLATE_KINDS as readonly string[]).includes(raw) ? (raw as TemplateKind) : null;
}

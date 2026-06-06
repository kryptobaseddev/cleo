/**
 * `cleo docs set-alias <slug> <number>` — assign an explicit DISPLAY ALIAS
 * number to a doc, DECOUPLED from its slug.
 *
 * Under the slug-primary model (saga T11778 · ADR reconcile T11676) the kebab
 * slug is the canonical handle and the rendered number (e.g. ADR "051") is a
 * display alias only. This verb writes the real `attachments.display_alias`
 * column via the CORE SDK chokepoint so renderers/`cleo docs fetch|list` show a
 * STABLE number even when several docs share a slug-derived number. The number
 * must be UNIQUE among `type='adr'` docs (rejected with `E_ALIAS_TAKEN`).
 *
 * Pass `--clear` to remove an existing alias (revert to slug-derived rendering).
 *
 * Thin CLI boundary — all transaction + uniqueness logic lives in
 * {@link import('@cleocode/core/internal').setDisplayAlias}.
 *
 * @see setDisplayAlias — packages/core/src/docs/display-alias.ts
 * @see resolveDisplayNumber — packages/core/src/docs/numbering.ts
 *
 * @task T11875 (Epic T11781 / Saga T11778)
 * @adr ADR-078
 */

import { ExitCode } from '@cleocode/contracts';
import { CleoError, getProjectRoot, setDisplayAlias } from '@cleocode/core/internal'; // core-first-allowed: T11875 setDisplayAlias not yet promoted to public barrel
import { defineCommand } from '../../lib/define-cli-command.js';
import { cliError, cliOutput } from '../../renderers/index.js';

/**
 * `cleo docs set-alias` — display-alias assignment verb (T11875).
 *
 * @task T11875
 */
export const setAliasCommand = defineCommand({
  meta: {
    name: 'set-alias',
    description:
      'Assign an explicit display-alias number to a doc, decoupled from its ' +
      'slug (e.g. `cleo docs set-alias adr-051-override-patterns 091`). The ' +
      'number must be unique among type=adr docs. Pass --clear to remove an ' +
      'existing alias (revert to the slug-derived number).',
  },
  args: {
    slug: {
      type: 'positional',
      description: 'Canonical doc slug to alias (e.g. adr-051-override-patterns). Required.',
      required: true,
    },
    number: {
      type: 'positional',
      description: 'The display-alias number to assign (positive integer). Omit with --clear.',
      required: false,
    },
    clear: {
      type: 'boolean',
      description: 'Clear any existing alias instead of setting one (revert to slug-derived).',
    },
  },
  async run({ args }) {
    const slug = String(args.slug);
    const clear = Boolean(args.clear);

    let displayAlias: number | null;
    if (clear) {
      displayAlias = null;
    } else {
      const raw = args.number;
      if (raw === undefined || raw === null || String(raw).trim() === '') {
        cliError(
          'a positive integer <number> is required (or pass --clear to remove the alias)',
          ExitCode.VALIDATION_ERROR,
          { name: 'E_VALIDATION' },
        );
        process.exit(ExitCode.VALIDATION_ERROR);
        return;
      }
      const parsed = Number.parseInt(String(raw), 10);
      if (!Number.isInteger(parsed) || parsed < 1) {
        cliError(
          `<number> must be a positive integer (got '${String(raw)}')`,
          ExitCode.VALIDATION_ERROR,
          { name: 'E_VALIDATION' },
        );
        process.exit(ExitCode.VALIDATION_ERROR);
        return;
      }
      displayAlias = parsed;
    }

    try {
      const result = await setDisplayAlias(getProjectRoot(), { slug, displayAlias });
      cliOutput(result, { command: 'docs set-alias', operation: 'docs.set-alias' });
    } catch (err) {
      if (err instanceof CleoError) {
        cliError(err.message, err.code, {
          name:
            typeof err.details?.['code'] === 'string' ? err.details['code'] : 'E_DOCS_SET_ALIAS',
          ...(err.fix ? { fix: err.fix } : {}),
          ...(err.details ? { details: err.details } : {}),
        });
        process.exit(err.code);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      cliError(`docs set-alias failed: ${message}`, ExitCode.GENERAL_ERROR, {
        name: 'E_DOCS_SET_ALIAS_FAILED',
      });
      process.exit(ExitCode.GENERAL_ERROR);
    }
  },
});

/**
 * `cleo docs modernize` CLI command — turn a messy docs folder into clean,
 * linked CleoDocs (T14113).
 *
 *   cleo docs modernize docs                       — dry run: the plan, nothing written
 *   cleo docs modernize docs --out plan.json       — dry run, plan saved for review
 *   cleo docs modernize docs --apply               — plan and apply, with a receipt
 *   cleo docs modernize --apply --plan plan.json   — apply a reviewed plan verbatim
 *   cleo docs modernize --rollback <runId>         — reverse an apply run
 *   cleo docs modernize .cleo/rcasd --store-only --kind rcasd --apply
 *                                                  — bulk-ingest, task-owned, folder untouched
 *
 * @task T14113
 * @epic T14106
 */

import { dispatchFromCli } from '../../../dispatch/adapters/cli.js';
import { defineCommand } from '../../lib/define-cli-command.js';

/** `cleo docs modernize` — dry run by default; `--apply` executes; `--rollback` reverses. */
export const modernizeCommand = defineCommand({
  meta: {
    name: 'modernize',
    description:
      'Turn a messy docs folder into clean, linked CleoDocs (T14113). Dry run by default: ' +
      'per file a kind, a stable slug (no task, session or date tokens) and ' +
      'keep/rename/merge-into/delete with reasons; ambiguous classify and merge calls go ' +
      'to System One (cleo decide) with a rule fallback. --apply stores docs, merges ' +
      'duplicates, records supersession, moves files and writes wikilink edges, with a ' +
      'receipt under .cleo/modernize/; --rollback <runId> reverses a run.',
  },
  args: {
    path: {
      type: 'positional',
      description: 'Folder to modernize (required unless --rollback or --plan)',
      required: false,
    },
    apply: {
      type: 'boolean',
      description: 'Execute the plan (default: dry run, nothing written)',
    },
    plan: {
      type: 'string',
      description: 'Apply this saved plan JSON verbatim (with --apply)',
    },
    out: {
      type: 'string',
      description: 'Save the plan JSON to this path for review',
    },
    rollback: {
      type: 'string',
      description: 'Roll back the apply run with this id (from the receipt)',
    },
    exclude: {
      type: 'string',
      description: 'Extra folder names to skip, comma-separated',
    },
    overrides: {
      type: 'string',
      description: 'Reviewer decisions JSON keyed by path; they win over rules and System One',
    },
    kind: {
      type: 'string',
      description: 'Use this kind for every file instead of classifying (bulk ingest)',
    },
    'allow-dirty': {
      type: 'boolean',
      description: 'Apply even when the root is not a clean git checkout (default: refuse)',
    },
    'store-only': {
      type: 'boolean',
      description: 'Ingest every file into the store (task-owned) and leave the folder untouched',
    },
  } as const,
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'docs',
      'modernize',
      {
        ...(typeof args.path === 'string' ? { path: args.path } : {}),
        apply: args.apply === true,
        ...(typeof args.plan === 'string' ? { planFile: args.plan } : {}),
        ...(typeof args.out === 'string' ? { out: args.out } : {}),
        ...(typeof args.rollback === 'string' ? { rollback: args.rollback } : {}),
        ...(typeof args.exclude === 'string' ? { exclude: args.exclude } : {}),
        ...(typeof args.overrides === 'string' ? { overrides: args.overrides } : {}),
        ...(typeof args.kind === 'string' ? { kind: args.kind } : {}),
        storeOnly: args['store-only'] === true,
        allowDirty: args['allow-dirty'] === true,
      },
      { command: 'docs modernize' },
    );
  },
});

/**
 * Foreground project knowledge assessment and sourced repair CLI.
 *
 * Code placed in `packages/cleo/` per Package-Boundary Check — verified
 * against AGENTS.md. Domain logic remains in the core doctor service.
 */

import { readFile } from 'node:fs/promises';
import {
  KnowledgeRepairError,
  parseKnowledgeRepairProposal,
  runKnowledgeDoctor,
} from '@cleocode/core/doctor/knowledge.js';
import { getProjectRoot } from '@cleocode/core/paths.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliError, cliOutput } from '../renderers/index.js';

/** Assess knowledge, preview repairs, submit sourced resolutions, or restore a receipt. */
export const doctorKnowledgeSubcommand = defineCommand({
  meta: {
    name: 'knowledge',
    description: 'Assess project knowledge and apply bounded, sourced, reversible repairs',
  },
  args: {
    fix: {
      type: 'boolean',
      description: 'Apply deterministic repairs to confirmed derived defects',
    },
    'dry-run': { type: 'boolean', description: 'Preview findings and proposals without mutations' },
    resolve: { type: 'string', description: 'Apply a sourced repair proposal from a JSON file' },
    rollback: {
      type: 'string',
      description: 'Restore a prior repair receipt after checking its post-state',
    },
    decision: {
      type: 'string',
      description:
        'Assess explicit decision-to-task-to-code evidence and supported linking actions',
    },
    task: {
      type: 'string',
      description: 'Include evidence-derived footprint findings for one task',
    },
    'budget-ms': {
      type: 'string',
      default: '30000',
      description:
        'Explicit assessment budget in milliseconds (1–120000); background maintenance defaults to 2000',
    },
    json: { type: 'boolean', description: 'Output one structured envelope' },
  },
  async run({ args }) {
    try {
      const budgetMs = Number(args['budget-ms']);
      if (!Number.isFinite(budgetMs) || budgetMs < 1 || budgetMs > 120000)
        throw new KnowledgeRepairError(
          'E_REPAIR_INPUT',
          '--budget-ms must be between 1 and 120000.',
        );
      const proposal = args.resolve
        ? parseKnowledgeRepairProposal(await readFile(args.resolve, 'utf8'))
        : undefined;
      const result = await runKnowledgeDoctor(getProjectRoot(), {
        budgetMs,
        fix: args.fix,
        dryRun: args['dry-run'],
        proposal,
        rollback: args.rollback,
        taskId: args.task,
        decisionId: args.decision,
      });
      cliOutput(result, { command: 'doctor', operation: 'doctor.knowledge' });
    } catch (error) {
      cliError(
        error instanceof Error ? error.message : String(error),
        6,
        {
          name: error instanceof KnowledgeRepairError ? error.code : 'E_REPAIR_INPUT',
        },
        { operation: 'doctor.knowledge' },
      );
      process.exitCode = 6;
    }
  },
});

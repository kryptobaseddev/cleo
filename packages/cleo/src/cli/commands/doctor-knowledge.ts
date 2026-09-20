/**
 * Foreground project knowledge assessment and sourced repair CLI.
 *
 * Code placed in `packages/cleo/` per Package-Boundary Check — verified
 * against AGENTS.md. Domain logic remains in the core doctor service.
 */

import { readFile } from 'node:fs/promises';
import type { OperationExecutionContext } from '@cleocode/contracts/jobs';
import type { KnowledgeRepairPreparation } from '@cleocode/contracts/knowledge-health';
import {
  applyPreparedKnowledgeRepair,
  cancelPreparedKnowledgeRepair,
  createKnowledgeRepairInvocation,
  inspectPreparedKnowledgeRepair,
  KnowledgeRepairError,
  parseKnowledgeRepairProposal,
  prepareKnowledgeRepair,
  prepareKnowledgeRollback,
  resumePreparedKnowledgeRepair,
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
    prepare: { type: 'string', description: 'Persist a sourced JSON proposal without applying it' },
    apply: {
      type: 'string',
      description: 'Apply an immutable prepared job under a fresh bounded attempt',
    },
    inspect: {
      type: 'string',
      description: 'Inspect a prepared job, retained receipts and lifecycle ledger',
    },
    cancel: {
      type: 'string',
      description: 'Request cancellation; committed repair effects are preserved',
    },
    resume: {
      type: 'string',
      description: 'Explicitly retry recoverable work while retaining prior attempts',
    },
    actor: {
      type: 'string',
      description: 'Explicit stable repair actor; must match prepared work',
    },
    'proposal-id': {
      type: 'string',
      description: 'Immutable proposal identity for job operations or new rollback',
    },
    limit: { type: 'string', default: '100', description: 'Inspection ledger page size (1–1000)' },
    offset: { type: 'string', default: '0', description: 'Inspection ledger page offset' },
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
      default: '2000',
      description:
        'Shared invocation budget in milliseconds (1–120000), default 2000; synchronous work is cooperative',
    },
    json: { type: 'boolean', description: 'Output one structured envelope' },
  },
  async run({ args }) {
    // Capture both before proposal-file I/O or any other asynchronous boundary.
    const startedAt = Date.now();
    const root = getProjectRoot();
    let context: OperationExecutionContext | undefined;
    let pending: KnowledgeRepairPreparation | undefined;
    try {
      const budgetMs = Number(args['budget-ms']);
      if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 120000)
        throw new KnowledgeRepairError(
          'E_REPAIR_INPUT',
          '--budget-ms must be an integer between 1 and 120000.',
        );
      const deadlineAt = startedAt + budgetMs;
      const actions = [
        args.fix,
        args.resolve,
        args.rollback,
        args.prepare,
        args.apply,
        args.inspect,
        args.cancel,
        args.resume,
      ];
      if (actions.filter(Boolean).length > 1)
        throw new KnowledgeRepairError(
          'E_REPAIR_INPUT',
          'Select exactly one repair lifecycle action.',
        );
      if (
        args['dry-run'] &&
        (args.prepare || args.apply || args.inspect || args.cancel || args.resume || args.rollback)
      )
        throw new KnowledgeRepairError(
          'E_REPAIR_INPUT',
          '--dry-run cannot execute a repair lifecycle action.',
        );
      const lifecycle = actions.some(Boolean) && !args['dry-run'];
      if (lifecycle && !args.actor?.trim())
        throw new KnowledgeRepairError(
          'E_REPAIR_ACTOR',
          '--actor explicitly identifies the stable repair caller.',
        );
      if (
        (args.apply || args.inspect || args.cancel || args.resume || args.rollback) &&
        !args['proposal-id']?.trim()
      )
        throw new KnowledgeRepairError(
          'E_REPAIR_INPUT',
          '--proposal-id must identify the immutable prepared input or new rollback.',
        );
      let proposal =
        args.prepare || args.resolve
          ? parseKnowledgeRepairProposal(await readFile((args.prepare || args.resolve)!, 'utf8'))
          : undefined;
      if (proposal && args['proposal-id'] && proposal.id !== args['proposal-id'])
        throw new KnowledgeRepairError(
          'E_REPAIR_INPUT',
          '--proposal-id differs from the sourced proposal.',
        );
      if (!lifecycle || args.fix) {
        const report = await runKnowledgeDoctor(root, {
          budgetMs: Math.max(0, deadlineAt - Date.now()),
          fix: args.fix,
          dryRun: true,
          proposal,
          taskId: args.task,
          decisionId: args.decision,
        });
        if (
          !lifecycle ||
          report.health.coverage.maintenanceState === 'pending' ||
          !report.proposals[0]
        ) {
          cliOutput(report, { command: 'doctor', operation: 'doctor.knowledge' });
          return;
        }
        proposal = report.proposals[0];
      }
      if (proposal && args['proposal-id'] && proposal.id !== args['proposal-id'])
        throw new KnowledgeRepairError(
          'E_REPAIR_INPUT',
          '--proposal-id differs from the assessed proposal.',
        );
      const proposalId = proposal?.id ?? args['proposal-id'];
      if (!proposalId || !args.actor)
        throw new KnowledgeRepairError(
          'E_REPAIR_INPUT',
          'Explicit actor and immutable proposal identity are required.',
        );
      context = await createKnowledgeRepairInvocation(root, args.actor, proposalId, deadlineAt);
      if (args.inspect) {
        cliOutput(
          await inspectPreparedKnowledgeRepair(
            context,
            args.inspect,
            Number(args.limit),
            Number(args.offset),
          ),
          { command: 'doctor', operation: 'doctor.knowledge' },
        );
        return;
      }
      if (args.cancel) {
        cliOutput(await cancelPreparedKnowledgeRepair(context, args.cancel), {
          command: 'doctor',
          operation: 'doctor.knowledge',
        });
        return;
      }
      if (proposal) pending = await prepareKnowledgeRepair(context, proposal);
      else if (args.rollback) pending = await prepareKnowledgeRollback(context, args.rollback);
      if (args.prepare) {
        cliOutput(pending, { command: 'doctor', operation: 'doctor.knowledge' });
        return;
      }
      const jobId = pending?.jobId ?? args.apply ?? args.resume;
      if (!jobId) throw new KnowledgeRepairError('E_REPAIR_INPUT', 'A prepared job is required.');
      const result = args.resume
        ? await resumePreparedKnowledgeRepair(context, jobId)
        : await applyPreparedKnowledgeRepair(context, jobId);
      cliOutput(result, { command: 'doctor', operation: 'doctor.knowledge' });
    } catch (error) {
      cliError(
        error instanceof Error ? error.message : String(error),
        6,
        {
          name:
            error instanceof Error && 'code' in error && typeof error.code === 'string'
              ? error.code
              : 'E_REPAIR_INPUT',
          details: {
            prepared: pending,
            attemptFailure:
              error instanceof KnowledgeRepairError ? error.attemptFailure : undefined,
            recoveryState: error instanceof KnowledgeRepairError ? error.recoveryState : undefined,
            deadlineAt: context?.deadlineAt,
            elapsedMs: Date.now() - startedAt,
          },
        },
        { operation: 'doctor.knowledge' },
      );
      process.exitCode = 6;
    } finally {
      context?.close();
    }
  },
});

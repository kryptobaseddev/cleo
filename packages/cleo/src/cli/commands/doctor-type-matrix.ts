/**
 * `cleo doctor type-matrix` — repair parent/child pairs that break the type
 * matrix (saga→epic, epic→task, task→subtask).
 *
 * A dry run by default: every violation with its proposed operation, or its
 * options when it is ambiguous. `--apply` applies the proposals plus the
 * operations a `--resolutions <file>` names, with a receipt in the task audit
 * log; `--rollback <receipt>` restores the rows that receipt changed.
 *
 * @task T14096
 */

import { existsSync, readFileSync } from 'node:fs';
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import type { TypeMatrixRepairOp } from '@cleocode/core/doctor/type-matrix-repair.js';
import { getProjectRoot } from '@cleocode/core/paths.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliError, cliOutput } from '../renderers/index.js';

/**
 * `cleo doctor type-matrix` subcommand.
 *
 * Exits 1 while a violation is left unresolved, so it can gate a cleanup step.
 *
 * @task T14096
 */
export const doctorTypeMatrixCommand = defineCommand({
  meta: {
    name: 'type-matrix',
    description:
      'Repair parent/child pairs that break the type matrix (dry run; --apply, --rollback <receipt>)',
  },
  args: {
    apply: {
      type: 'boolean',
      description: 'Apply the proposals and the --resolutions operations in one transaction.',
    },
    resolutions: {
      type: 'string',
      description:
        'JSON file of operations for ambiguous pairs: [{"kind":"retype","taskId":"T1","to":"epic"}, ' +
        '{"kind":"reparent","taskId":"T2","toParentId":"T3"}]; toParentId null moves to the root; ' +
        'one task may take one re-type and one reparent.',
    },
    plan: {
      type: 'string',
      description:
        'With --apply: the reviewed dry run (its JSON output). The apply runs only those operations, ' +
        'and only on rows unchanged since that plan read them (E_CONFLICT otherwise).',
    },
    rollback: {
      type: 'string',
      description: 'Receipt id of an applied repair to undo.',
    },
    json: { type: 'boolean', description: 'Output as JSON' },
    human: { type: 'boolean', description: 'Force human-readable output' },
    quiet: { type: 'boolean', description: 'Suppress non-essential output' },
  },
  async run({ args }) {
    const root = getProjectRoot();
    const repair = await import('@cleocode/core/doctor/type-matrix-repair.js');
    if (typeof args.rollback === 'string' && args.rollback !== '') {
      const result = await repair.rollbackTypeMatrixRepair(root, args.rollback);
      cliOutput(result, { command: 'doctor', operation: 'doctor.type-matrix.rollback' });
      return;
    }
    const fromFile = <T>(
      flag: string,
      path: unknown,
      parse: (text: string) => { ok: true; value: T } | { ok: false; reason: string },
    ): { ok: true; value: T | undefined } | { ok: false } => {
      if (typeof path !== 'string' || path === '') return { ok: true, value: undefined };
      const parsed = existsSync(path)
        ? parse(readFileSync(path, 'utf-8'))
        : { ok: false as const, reason: 'no such file' };
      if (parsed.ok) return parsed;
      cliError(`--${flag} ${path}: ${parsed.reason}`, ExitCode.VALIDATION_ERROR, {
        name: 'E_VALIDATION',
      });
      return { ok: false };
    };
    const resolutions = fromFile('resolutions', args.resolutions, (text) => {
      const r = repair.parseTypeMatrixResolutions(text);
      return r.ok ? { ok: true, value: r.operations } : r;
    });
    const plan = fromFile('plan', args.plan, repair.parseTypeMatrixPlan);
    if (!resolutions.ok || !plan.ok) return;
    const ops: TypeMatrixRepairOp[] = resolutions.value ?? [];
    const report =
      args.apply === true
        ? await repair.applyTypeMatrixRepair(root, ops, plan.value ? { plan: plan.value } : {})
        : await repair.planTypeMatrixRepair(root, ops);
    cliOutput(report, {
      command: 'doctor',
      operation: args.apply === true ? 'doctor.type-matrix.apply' : 'doctor.type-matrix.plan',
    });
    if (
      report.unresolved.length > 0 &&
      (process.exitCode === undefined || process.exitCode === 0)
    ) {
      process.exitCode = 1;
    }
  },
});

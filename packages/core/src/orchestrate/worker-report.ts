/**
 * Worker report check (T14361): a lead hands the report its worker returned
 * to `cleo done <id> --report "<report>"`, which refuses it before recording
 * anything unless it carries proof and stays within {@link WORKER_REPORT_MAX_WORDS}.
 *
 * The report is the spawn prompt's Return Format Contract block:
 *
 * ```
 * Implementation complete. manifest:<entryId>
 * conclusion: <one line>
 * blocker: none
 * proof: <command> => exit <code>
 * proof: <PR url | commit sha | file>
 * ```
 *
 * @task T14361
 * @epic T14351
 */

import type { WorkerProof, WorkerReport } from '@cleocode/contracts';
import { E_WORKER_REPORT_PROOF, ExitCode } from '@cleocode/contracts/exit-codes.js';
import { parseReturnMessage } from '../validation/protocol-common.js';

/** Most words a worker report may carry; detail belongs in the PR body. */
export const WORKER_REPORT_MAX_WORDS = 100;

/** Outcome of {@link checkWorkerReport}. */
export type WorkerReportCheck =
  | { ok: true; report: WorkerReport }
  | {
      ok: false;
      /** `E_WORKER_REPORT_PROOF` for missing proof, `E_VALIDATION` for length. */
      code: typeof E_WORKER_REPORT_PROOF | 'E_VALIDATION';
      /** CLI exit code: 61 for missing proof, 6 for length. */
      exitCode: ExitCode;
      message: string;
      fix: string;
    };

/** Read one `proof:` value: `<command> => exit <n>`, else an artifact. */
function parseProof(value: string): WorkerProof {
  const run = /^(.+?)\s*=>\s*exit\s+(-?\d+)$/.exec(value);
  return run?.[1] && run[2] ? { command: run[1], exitCode: Number(run[2]) } : { artifact: value };
}

/**
 * Check a worker report: it must parse as the Return Format Contract, carry a
 * `conclusion:` line and at least one `proof:` line that is not `none`, and
 * hold at most {@link WORKER_REPORT_MAX_WORDS} words.
 *
 * @param text - The report exactly as the worker returned it.
 * @returns The parsed {@link WorkerReport}, or the refusal with its fix.
 *
 * @example
 * ```ts
 * const check = checkWorkerReport(report);
 * if (!check.ok) throw new Error(`${check.code}: ${check.message}`);
 * ```
 */
export function checkWorkerReport(text: string): WorkerReportCheck {
  const words = text
    .replace(/```[\w-]*/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
  if (words > WORKER_REPORT_MAX_WORDS) {
    return {
      ok: false,
      code: 'E_VALIDATION',
      exitCode: ExitCode.VALIDATION_ERROR,
      message: `Worker report is ${words} words; the limit is ${WORKER_REPORT_MAX_WORDS}`,
      fix: 'Move the detail into the PR body and cite the PR in a proof: line',
    };
  }
  const parsed = parseReturnMessage(text);
  const proof = (parsed?.proof ?? []).filter((p) => p.toLowerCase() !== 'none').map(parseProof);
  if (!parsed?.conclusion || proof.length === 0) {
    return {
      ok: false,
      code: E_WORKER_REPORT_PROOF,
      exitCode: ExitCode.INVALID_RETURN_MESSAGE,
      message: parsed
        ? 'Worker report has no conclusion: line or no proof: line backing it'
        : 'Worker report does not match the Return Format Contract',
      fix: 'Add a conclusion: line and one proof: line per item (<command> => exit <code>, or a PR url, commit sha or file)',
    };
  }
  const blocker = parsed.blocker && parsed.blocker !== 'none' ? parsed.blocker : null;
  return { ok: true, report: { conclusion: parsed.conclusion, blocker, proof } };
}

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

/** Template keys and syntax, left out of the word count. */
const TEMPLATE_TOKENS = new Set(['conclusion:', 'blocker:', 'proof:', '=>']);

/**
 * True for a value that proves nothing: an unfilled `<placeholder>` from the
 * template, or a stand-in such as `n/a`, `TBD` or `-`.
 */
function isPlaceholder(value: string): boolean {
  const v = value.trim();
  return (
    /<[^<>]*>/.test(v) ||
    /^[\s\-–—.?_*]*$/.test(v) ||
    /^(none|n\/?a|tbd|todo|tba|pending|null|nil|unknown|xxx+)$/i.test(v)
  );
}

/**
 * Read one `proof:` value: `<command> => exit <n>`, else an artifact; `null`
 * when it proves nothing — a placeholder, a run with no command or a
 * malformed exit, or, when `requireExitZero` is set (a complete report), a
 * command that exited non-zero. A partial or blocked report may cite a
 * non-zero exit as proof of its blocker.
 */
function parseProof(value: string, requireExitZero: boolean): WorkerProof | null {
  if (isPlaceholder(value)) return null;
  if (!value.includes('=>')) return { artifact: value };
  const run = /^(.*?)\s*=>\s*exit\s+(-?\d+)$/.exec(value);
  const command = run?.[1]?.trim();
  const exitCode = Number(run?.[2]);
  if (!command || isPlaceholder(command) || !Number.isInteger(exitCode)) return null;
  if (requireExitZero && exitCode !== 0) return null;
  return { command, exitCode };
}

/**
 * Check a worker report: it must parse as the Return Format Contract, carry a
 * filled `conclusion:` line and at least one `proof:` line, and hold at most
 * {@link WORKER_REPORT_MAX_WORDS} words (the template's own keys not counted).
 * Every `proof:` line must prove something: a placeholder (`<cmd>`, `n/a`,
 * `TBD`, `-`), a run with no command or a malformed exit refuses the whole
 * report whatever its status. A complete report (status `complete` and no
 * blocker) also needs every command proof at exit 0; a partial or blocked
 * report may cite non-zero exits. `blocker: none` in any case means no blocker.
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
    .filter((w) => w && !TEMPLATE_TOKENS.has(w.toLowerCase())).length;
  if (words > WORKER_REPORT_MAX_WORDS) {
    return {
      ok: false,
      // @sync-invariant none:input-shape report length is an input contract, never acceptance evidence
      code: 'E_VALIDATION',
      exitCode: ExitCode.VALIDATION_ERROR,
      message: `Worker report is ${words} words; the limit is ${WORKER_REPORT_MAX_WORDS}`,
      fix: 'Move the detail into the PR body and cite the PR in a proof: line',
    };
  }
  const parsed = parseReturnMessage(text);
  const refuse = (message: string): WorkerReportCheck => ({
    ok: false,
    code: E_WORKER_REPORT_PROOF,
    exitCode: ExitCode.INVALID_RETURN_MESSAGE,
    message,
    fix: 'Add a filled conclusion: line and one proof: line per item (<command> => exit 0, or a PR url, commit sha or file)',
  });
  if (!parsed) return refuse('Worker report does not match the Return Format Contract');
  if (!parsed.conclusion || isPlaceholder(parsed.conclusion)) {
    return refuse('Worker report has no filled conclusion: line');
  }
  const blocker = parsed.blocker && parsed.blocker.toLowerCase() !== 'none' ? parsed.blocker : null;
  const complete = (parsed.status === 'complete' || parsed.status === 'completed') && !blocker;
  const proof = parsed.proof.map((p) => parseProof(p, complete));
  if (proof.length === 0) return refuse('Worker report has no proof: line backing it');
  const bad = proof.indexOf(null);
  if (bad !== -1) {
    return refuse(
      `Worker report proof "${parsed.proof[bad]}" proves nothing: a placeholder, a run with no command, a malformed exit, or a non-zero exit in a complete report`,
    );
  }
  return {
    ok: true,
    report: {
      conclusion: parsed.conclusion,
      blocker,
      proof: proof.filter((p): p is WorkerProof => p !== null),
    },
  };
}

#!/usr/bin/env node
/**
 * PR task-line check (T14143, owner decision D11212).
 *
 * Every PR names the tasks it delivers, one `Closes: T#### AC1,AC2` or
 * `Refs: T#### AC1` line per task (ADR-099), so each change is traceable from
 * task to PR to release. This flags a PR whose body names no task, or whose
 * task lines are malformed, when the PR opens or its body changes.
 *
 * The line grammar mirrors `parseMergeDirectives` in
 * `packages/core/src/tasks/merge-close.ts`, which the merge sweep uses;
 * `scripts/__tests__/lint-pr-task-lines.test.mjs` asserts the two agree.
 *
 * Exempt: release branches (`release/*`, the post-publish CHANGELOG and
 * version PR), bot authors, and PRs labelled `no-task`.
 *
 * Inputs (environment): PR_BODY, PR_HEAD_REF, PR_AUTHOR, PR_LABELS (JSON array
 * of label names). Exit 0 when the PR passes or is exempt, 1 when flagged.
 *
 * @task T14143
 */

import { isMain } from './lib/is-main.mjs';

const DIRECTIVE_LINE = /^[ \t>*-]*(Closes|Refs)[ \t]*:[ \t]*(.*)$/gim;
const DIRECTIVE_PAYLOAD = /^(T\d+)\s+(AC\d+(?:\s*,\s*AC\d+)*)\s*$/i;

/** Label that opts a PR out of the check (a change no task owns). */
export const NO_TASK_LABEL = 'no-task';

/**
 * Parse a PR body's `Closes:` / `Refs:` task lines.
 *
 * @param {string} body - The PR body.
 * @returns {{ directives: Array<{kind: 'closes' | 'refs', taskId: string, acs: string[]}>, errors: string[] }}
 */
export function parseTaskLines(body) {
  const directives = [];
  const errors = [];
  for (const match of body.matchAll(DIRECTIVE_LINE)) {
    const keyword = (match[1] ?? '').toLowerCase() === 'closes' ? 'Closes' : 'Refs';
    const payload = (match[2] ?? '').replace(/`/g, '').trim();
    if (!/^T\d/i.test(payload)) continue;
    const parsed = DIRECTIVE_PAYLOAD.exec(payload);
    if (!parsed) {
      errors.push(
        `"${keyword}: ${payload}" is not "${keyword}: T#### AC1,AC2": name the task, then every criterion this PR delivers (no wildcard).`,
      );
      continue;
    }
    const taskId = (parsed[1] ?? '').toUpperCase();
    if (directives.some((d) => d.taskId === taskId)) {
      errors.push(`${taskId} is named on more than one Closes:/Refs: line; use one line per task.`);
      continue;
    }
    const acs = [...new Set((parsed[2] ?? '').split(',').map((a) => a.trim().toUpperCase()))];
    directives.push({ kind: keyword === 'Closes' ? 'closes' : 'refs', taskId, acs });
  }
  return { directives, errors };
}

/**
 * Judge one PR.
 *
 * @param {{ body: string, headRef: string, author: string, labels: string[] }} pr
 * @returns {{ ok: boolean, exempt: string | null, problems: string[], tasks: string[] }}
 */
export function checkPrTaskLines(pr) {
  if (pr.headRef.startsWith('release/')) {
    return { ok: true, exempt: `release branch ${pr.headRef}`, problems: [], tasks: [] };
  }
  if (pr.author.endsWith('[bot]')) {
    return { ok: true, exempt: `bot author ${pr.author}`, problems: [], tasks: [] };
  }
  if (pr.labels.includes(NO_TASK_LABEL)) {
    return { ok: true, exempt: `label ${NO_TASK_LABEL}`, problems: [], tasks: [] };
  }
  const { directives, errors } = parseTaskLines(pr.body);
  const problems = [...errors];
  if (directives.length === 0 && errors.length === 0) {
    problems.push(
      'The PR body names no task. Add one line per task it delivers: ' +
        '"Closes: T#### AC1,AC2" (completes the task once merged PRs cover every criterion) or ' +
        '"Refs: T#### AC1" (partial delivery). A change no task owns takes the "no-task" label.',
    );
  }
  return {
    ok: problems.length === 0,
    exempt: null,
    problems,
    tasks: directives.map((d) => `${d.kind === 'closes' ? 'Closes' : 'Refs'} ${d.taskId}`),
  };
}

/** Read the PR from the environment the workflow sets. */
function prFromEnv(env) {
  let labels = [];
  try {
    const parsed = JSON.parse(env.PR_LABELS ?? '[]');
    if (Array.isArray(parsed)) labels = parsed.filter((l) => typeof l === 'string');
  } catch {
    labels = [];
  }
  return {
    body: env.PR_BODY ?? '',
    headRef: env.PR_HEAD_REF ?? '',
    author: env.PR_AUTHOR ?? '',
    labels,
  };
}

if (isMain(import.meta.url)) {
  const result = checkPrTaskLines(prFromEnv(process.env));
  if (result.exempt !== null) {
    process.stdout.write(`lint-pr-task-lines: exempt (${result.exempt}).\n`);
    process.exit(0);
  }
  if (result.ok) {
    process.stdout.write(`lint-pr-task-lines: OK — ${result.tasks.join(', ')} (T14143).\n`);
    process.exit(0);
  }
  for (const problem of result.problems) process.stdout.write(`::error::${problem}\n`);
  process.exit(1);
}

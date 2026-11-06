/**
 * Tests for scripts/lint-pr-ledger.mjs (T14247): a durability PR pairs every
 * exception it adds with the rule it deletes; models and parts need no pair.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { checkPrLedger, parseLedger, parseLedgerItem } from '../lint-pr-ledger.mjs';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../lint-pr-ledger.mjs');

/** Run the check as the workflow does: the body in PR_BODY, judged by the exit code. */
const run = (body) =>
  spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, PR_BODY: body },
  });

describe('lint-pr-ledger (T14247)', () => {
  it('fails an unpaired exception, and the script exits 1', () => {
    const body =
      'Closes: T1 AC1\n\nLedger:\n- adds code E_NEW_REFUSAL\n- deletes the old fallback\n';
    const result = checkPrLedger(body);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(
      /adds code E_NEW_REFUSAL: an exception names the rule it deletes/,
    );
    const proc = run(body);
    expect(proc.status).toBe(1);
    expect(proc.stdout).toContain('::error::adds code E_NEW_REFUSAL');
  });

  it('passes a paired exception, inline or bulleted', () => {
    const inline =
      'Ledger: adds code E_SESSION_AMBIGUOUS -> deletes the silent shared-session fallback';
    const bulleted =
      'Ledger:\n- adds gate 41 lint-no-raw-worktree-removal -> deletes the raw removal exports\n';
    for (const body of [inline, bulleted]) {
      expect(checkPrLedger(body)).toMatchObject({ durability: true, ok: true, problems: [] });
      expect(run(body).status).toBe(0);
    }
  });

  it('passes a model and a part without a pairing', () => {
    const body =
      'Ledger: adds model the attribution receipt; adds part isSettledChild predicate; deletes nothing';
    expect(checkPrLedger(body).ok).toBe(true);
    expect(run(body).status).toBe(0);
  });

  it('every exception kind needs its pairing', () => {
    for (const kind of ['verdict', 'code', 'key', 'flag', 'registry', 'gate']) {
      expect(checkPrLedger(`Ledger: adds ${kind} x`).ok, kind).toBe(false);
      expect(checkPrLedger(`Ledger: adds ${kind} x -> deletes y`).ok, kind).toBe(true);
    }
  });

  it('flags an unknown kind, an empty name and "-> deletes nothing"', () => {
    expect(checkPrLedger('Ledger: adds helper x').problems[0]).toMatch(/"helper" is not a kind/);
    expect(checkPrLedger('Ledger: adds gate').problems[0]).toMatch(
      /is not a kind|name what it adds/,
    );
    expect(checkPrLedger('Ledger: adds key k -> deletes nothing').problems[0]).toMatch(
      /pairs nothing/,
    );
  });

  it('a Durability: marker without a ledger fails; a PR with neither is not checked', () => {
    expect(checkPrLedger('Durability: T14239\nCloses: T1 AC1')).toMatchObject({
      durability: true,
      ok: false,
    });
    const plain = checkPrLedger('Closes: T1 AC1\n\nA plain change.');
    expect(plain).toMatchObject({ durability: false, ok: true });
    expect(run('Closes: T1 AC1').status).toBe(0);
  });

  it('parses the machine-readable items a task description carries (for cleo doctor durability)', () => {
    const description =
      'Phase 1. Root cause … Ledger: adds one engine (prose, mid-paragraph, not parsed).\n' +
      'Ledger: adds model disposeWorktree; adds gate 41 -> deletes forceRemoveWorktreeDir; deletes the force-dirty branch';
    const { found, items, errors } = parseLedger(description);
    expect(found).toBe(true);
    expect(errors).toEqual([]);
    expect(items).toEqual([
      { type: 'add', kind: 'model', name: 'disposeWorktree', deletes: null, exception: false },
      { type: 'add', kind: 'gate', name: '41', deletes: 'forceRemoveWorktreeDir', exception: true },
      { type: 'delete', rule: 'the force-dirty branch' },
    ]);
    expect(parseLedgerItem('adds nothing').item).toEqual({ type: 'none', what: 'adds' });
  });

  it('runs in the PR Task Lines workflow on body edits', () => {
    const wf = parseYaml(
      readFileSync(resolve(dirname(SCRIPT), '../.github/workflows/pr-task-lines.yml'), 'utf8'),
    );
    expect(wf.on.pull_request.types).toContain('edited');
    const steps = Object.values(wf.jobs).flatMap((job) => job.steps ?? []);
    const step = steps.find(
      (s) => typeof s.run === 'string' && s.run.includes('lint-pr-ledger.mjs'),
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, matched literally
    expect(step?.env?.PR_BODY).toBe('${{ github.event.pull_request.body }}');
  });
});

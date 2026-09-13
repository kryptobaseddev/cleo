/**
 * Regression tests for gh#1234 claim 2 — "task ids resolve to different tasks
 * depending on cwd, with no warning".
 *
 * The store is selected by cwd, and task ids are PROJECT-SCOPED while LOOKING
 * global: `T100` carries no qualifier. So the same command with the same id
 * answers from a different store depending on where it ran — and nothing in
 * the response said which.
 *
 * Measured across one workspace with 38 CLEO stores: `cleo show T100` returned
 * "Task 100" from one project and "Phone management in the customer account
 * p…" from another, with byte-identical `meta` key sets. A verification gate
 * was written to the wrong project as a result.
 *
 * Per-project stores are correct (ADR-068). The defect was the absence of
 * disclosure, so these tests pin the disclosure.
 *
 * @task T12151 (gh#1234)
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatSuccess } from '../output.js';

/** `formatSuccess` returns a serialised envelope; parse it to inspect `meta`. */
function envelope(data: unknown, operation: string): { meta: Record<string, unknown> } {
  return JSON.parse(formatSuccess(data, undefined, { operation })) as {
    meta: Record<string, unknown>;
  };
}

let originalRoot: string | undefined;
const roots: string[] = [];

/** The form `meta.projectRoot` is expected to carry: home prefix collapsed. */
function expected(root: string): string {
  const home = homedir();
  return home && root.startsWith(`${home}/`) ? `~${root.slice(home.length)}` : root;
}

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gh1234-root-'));
  roots.push(dir);
  return dir;
}

beforeEach(() => {
  originalRoot = process.env.CLEO_ROOT;
});
afterEach(() => {
  if (originalRoot === undefined) delete process.env.CLEO_ROOT;
  else process.env.CLEO_ROOT = originalRoot;
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe('gh#1234 — every envelope discloses which store answered', () => {
  it('THE regression test: the same id from two roots yields two different projectRoots', () => {
    // This is the reproduction from the issue, pinned. Before the fix both
    // envelopes were indistinguishable — identical meta key sets, nothing
    // naming the store — so a reader could not tell a correct answer from an
    // answer about a different project.
    const rootA = makeRoot();
    const rootB = makeRoot();

    process.env.CLEO_ROOT = rootA;
    const a = envelope({ task: { id: 'T100' } }, 'tasks.show');

    process.env.CLEO_ROOT = rootB;
    const b = envelope({ task: { id: 'T100' } }, 'tasks.show');

    expect(a.meta.projectRoot).toBe(expected(rootA));
    expect(b.meta.projectRoot).toBe(expected(rootB));
    expect(a.meta.projectRoot).not.toBe(b.meta.projectRoot);
  });

  it('stamps projectRoot regardless of the operation', () => {
    // The ambiguity is in RESOLUTION, so it affects every command that reads or
    // writes — not just `show`. Stamped in the one place meta is built, so a
    // new command cannot forget it.
    const root = makeRoot();
    process.env.CLEO_ROOT = root;

    for (const operation of ['tasks.add', 'tasks.list', 'tasks.complete', 'cli.output']) {
      const env = envelope({ ok: true }, operation);
      expect(env.meta.projectRoot, operation).toBe(expected(root));
    }
  });

  it('collapses the home prefix so envelopes do not leak a username', () => {
    // Envelopes get pasted into public issue trackers. A raw absolute path
    // would put the user's account name in every one of them, permanently, as
    // a side effect of a disclosure field. `~/…` still answers "which store
    // answered this?" for the reader who ran the command.
    const home = homedir();
    const root = join(home, 'gh1234-home-probe');
    mkdirSync(root, { recursive: true });
    roots.push(root);
    process.env.CLEO_ROOT = root;

    const env = envelope({ ok: true }, 'tasks.show');
    expect(env.meta.projectRoot).toBe('~/gh1234-home-probe');
    expect(String(env.meta.projectRoot)).not.toContain(home);
  });

  it('does not disturb the existing meta contract', () => {
    const root = makeRoot();
    process.env.CLEO_ROOT = root;

    const env = envelope({ ok: true }, 'tasks.show');
    expect(env.meta.operation).toBe('tasks.show');
    expect(typeof env.meta.requestId).toBe('string');
    expect(typeof env.meta.timestamp).toBe('string');
    expect(typeof env.meta.duration_ms).toBe('number');
  });
});

/**
 * T14188 — docs status, doctor and modernize read the invoking checkout.
 *
 * Run from a CLEO worktree, the published mirrors and the folder to modernize
 * are that worktree's docs/, while the docs store, the publication ledger,
 * the modernize journal and backups stay at the project root. An explicit
 * `CLEO_ROOT` wins for both roots.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveInvokingCheckout } from '../../paths.js';
import { closeDb } from '../../store/sqlite.js';
import { createDocsReadModel } from '../docs-read-model.js';
import { runDocsDoctor } from '../doctor.js';
import { runDocsModernize } from '../modernize/index.js';
import { upsertDocsPublication } from '../publications-store.js';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

const PUBLISHED = '# Published\n\nas the store has it\n';
const SPEC = '# Gate integrity spec\n\n## Requirements\n- gates must hold\n';

let tmp: string;
let root: string;
let worktree: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    stdio: 'ignore',
  });
}

beforeEach(async () => {
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_PROJECT_ROOT', undefined);
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-t14188-')));
  root = join(tmp, 'root');
  worktree = join(tmp, 'worktrees', 'hash', 'T14188');
  mkdirSync(join(root, '.cleo'), { recursive: true });
  mkdirSync(join(root, 'docs', 'specs'), { recursive: true });
  writeFileSync(join(root, '.gitignore'), '.cleo/\n');
  writeFileSync(join(root, 'docs', 'published.md'), PUBLISHED);
  writeFileSync(join(root, 'docs', 'specs', 'T832-gate-integrity-spec.md'), SPEC);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'seed');
  git(root, 'worktree', 'add', '-q', '-b', 'task/T14188', worktree, 'main');
  vi.stubEnv('CLEO_DIR', join(root, '.cleo'));
  closeDb();
  // The store and ledger live at the project root only.
  await upsertDocsPublication(root, {
    ownerId: 'T9999',
    blobName: 'published.md',
    publishedPath: 'docs/published.md',
    lastBlobSha: sha(PUBLISHED),
  });
  // The worktree's mirror was edited on its branch.
  writeFileSync(join(worktree, 'docs', 'published.md'), '# Published\n\nedited in the worktree\n');
});

afterEach(() => {
  closeDb();
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

describe('docs status and doctor from a worktree (T14188)', () => {
  it("compare the project store against the worktree's mirrors", async () => {
    const checkout = resolveInvokingCheckout(join(worktree, 'docs'));
    expect(checkout).toBe(worktree);
    const status = await createDocsReadModel(root).status(root, checkout);
    expect(status.items.map((i) => [i.publishedPath, i.drift])).toEqual([
      ['docs/published.md', 'modified'],
    ]);
    // The same store read against the root checkout is in sync.
    expect((await createDocsReadModel(root).status(root)).allInSync).toBe(true);

    const report = await runDocsDoctor(root, { checkoutRoot: checkout });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const drift = report.report.diagnostics.find((d) => d.kind === 'publication-ledger-drift');
    expect(drift?.items.map((i) => [i['publishedPath'], i['proposed']])).toEqual([
      ['docs/published.md', 'reconcile-edit'],
    ]);
    const fromRoot = await runDocsDoctor(root);
    expect(
      fromRoot.ok &&
        fromRoot.report.diagnostics.find((d) => d.kind === 'publication-ledger-drift')?.count,
    ).toBe(0);
    // Nothing was written into the worktree.
    expect(existsSync(join(worktree, '.cleo'))).toBe(false);
  });

  it('an explicit CLEO_ROOT wins for both roots', async () => {
    vi.stubEnv('CLEO_ROOT', root);
    const checkout = resolveInvokingCheckout(worktree);
    expect(checkout).toBe(root);
    expect((await createDocsReadModel(root).status(root, checkout)).allInSync).toBe(true);
  });
});

describe('docs modernize from a worktree (T14188)', () => {
  it("dry run, apply and rollback act on the worktree's docs/; store, receipt and backups stay at the project", async () => {
    const checkout = resolveInvokingCheckout(worktree);
    const options = { checkoutRoot: checkout, decide: { connection: null }, allowDirty: true };

    const dry = await runDocsModernize(root, { path: 'docs' }, options);
    expect(dry.plan?.root).toBe(join(worktree, 'docs'));
    expect(
      dry.plan?.rows.find((r) => r.path === 'specs/T832-gate-integrity-spec.md')?.disposition,
    ).toBe('rename');

    const applied = await runDocsModernize(root, { path: 'docs', apply: true }, options);
    const runId = applied.receipt?.runId ?? '';
    expect(existsSync(join(worktree, 'docs', 'spec', 'gate-integrity-spec.md'))).toBe(true);
    expect(existsSync(join(worktree, 'docs', 'specs'))).toBe(false);
    // The root checkout is untouched; the receipt lives at the project root.
    expect(readFileSync(join(root, 'docs', 'specs', 'T832-gate-integrity-spec.md'), 'utf-8')).toBe(
      SPEC,
    );
    expect(existsSync(join(root, '.cleo', 'modernize', `${runId}.json`))).toBe(true);
    expect(existsSync(join(worktree, '.cleo'))).toBe(false);

    const rolled = await runDocsModernize(root, { rollback: runId }, options);
    expect(rolled.receipt?.rolledBackAt).not.toBeNull();
    expect(
      readFileSync(join(worktree, 'docs', 'specs', 'T832-gate-integrity-spec.md'), 'utf-8'),
    ).toBe(SPEC);
    expect(existsSync(join(worktree, 'docs', 'spec'))).toBe(false);
  });

  it('refuses a root outside both the project and the invoking checkout', async () => {
    const elsewhere = join(tmp, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    await expect(
      runDocsModernize(
        root,
        { path: elsewhere, apply: true },
        { checkoutRoot: worktree, decide: { connection: null }, allowDirty: true },
      ),
    ).rejects.toThrow(/not inside the project/);
  });

  it('refuses a checkout of another repository: no modernize read, apply or rollback, no doctor run', async () => {
    // A foreign repository with its own docs/ (what a stray CLEO_ROOT or a
    // gitlink of another repo would resolve to).
    const foreign = join(tmp, 'foreign');
    mkdirSync(join(foreign, 'docs', 'specs'), { recursive: true });
    writeFileSync(join(foreign, 'docs', 'specs', 'T1-foreign-spec.md'), SPEC);
    git(foreign, 'init', '-q', '-b', 'main');
    git(foreign, 'add', '.');
    git(foreign, 'commit', '-q', '-m', 'foreign');
    const options = { checkoutRoot: foreign, decide: { connection: null }, allowDirty: true };
    await expect(runDocsModernize(root, { path: 'docs' }, options)).rejects.toThrow(
      /not a worktree of the project/,
    );
    await expect(runDocsModernize(root, { path: 'docs', apply: true }, options)).rejects.toThrow(
      /not a worktree of the project/,
    );
    await expect(runDocsModernize(root, { rollback: 'dm-any' }, options)).rejects.toThrow(
      /not a worktree of the project/,
    );
    expect(readFileSync(join(foreign, 'docs', 'specs', 'T1-foreign-spec.md'), 'utf-8')).toBe(SPEC);
    const doctor = await runDocsDoctor(root, { checkoutRoot: foreign });
    expect(doctor.ok).toBe(false);
    if (doctor.ok) return;
    expect(doctor.error.code).toBe('E_DOCS_DOCTOR_FOREIGN_CHECKOUT');
  });
});

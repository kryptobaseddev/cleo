/**
 * Tests for scripts/release-run.mjs — the single release PR, end to end
 * (T13825). Every `gh`, `git`, `cleo` and `node` call goes through a fake
 * `exec`, so the flow is exercised step by step without touching GitHub.
 *
 * @task T13825
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AUDIT_LOG,
  auditLine,
  isVersionOnly,
  notesSha256,
  parseArgs,
  reviewProblem,
  runRelease,
} from '../release-run.mjs';

const V = 'v2026.10.19';
const NOTES = '## v2026.10.19\n\n- faster releases\n';
const SHA = createHash('sha256').update(NOTES).digest('hex');
const BASE = 'b'.repeat(40);
const HEAD = 'h'.repeat(40);
const MERGE = 'm'.repeat(40);

describe('parseArgs', () => {
  it('normalises the version and requires exactly one scope', () => {
    expect(parseArgs(['2026.10.19', '--epic', 'T1'])).toMatchObject({
      version: V,
      epic: 'T1',
      execute: false,
    });
    expect(() => parseArgs([V])).toThrow('exactly one of --epic or --tasks');
    expect(() => parseArgs([V, '--epic', 'T1', '--tasks', 'T2'])).toThrow('exactly one');
    expect(() => parseArgs(['latest', '--epic', 'T1'])).toThrow('not a release version');
    expect(() => parseArgs([V, '--epic'])).toThrow('needs a value');
    expect(() => parseArgs([V, '--epic', 'T1', '--force'])).toThrow('unknown flag');
  });
});

describe('notes review', () => {
  const plan = { meta: { releaseNotes: NOTES } };
  it('accepts an approving review of these exact notes by someone else', () => {
    expect(
      reviewProblem(notesSha256(plan), { reviewer: 'rev', notesSha256: SHA, approved: true }, 'op'),
    ).toBeNull();
  });
  it('refuses a missing, unapproved, self-, nameless or stale review', () => {
    const sha = notesSha256(plan);
    expect(reviewProblem(sha, undefined, 'op')).toContain('no --notes-review');
    expect(reviewProblem(sha, { reviewer: 'rev', notesSha256: SHA }, 'op')).toContain(
      'does not approve',
    );
    expect(
      reviewProblem(sha, { reviewer: 'op', notesSha256: SHA, approved: true }, 'op'),
    ).toContain('independent');
    expect(reviewProblem(sha, { notesSha256: SHA, approved: true }, 'op')).toContain('no reviewer');
    expect(
      reviewProblem(sha, { reviewer: 'rev', notesSha256: 'x', approved: true }, 'op'),
    ).toContain("the plan's notes are");
    expect(
      reviewProblem(notesSha256({}), { reviewer: 'rev', notesSha256: SHA, approved: true }, 'op'),
    ).toContain('no meta.releaseNotes');
  });
});

describe('helpers', () => {
  it('reads the version-only verdict and writes one audit line', () => {
    expect(isVersionOnly('version_only=true (3 path(s), all version-only)\n')).toBe(true);
    expect(isVersionOnly('version_only=false (path outside the version-only shape: x)\n')).toBe(
      false,
    );
    const line = auditLine({
      ts: 't',
      pr: 7,
      head: HEAD,
      merge: MERGE,
      version: V,
      operator: 'op',
      reviewer: 'rev',
      ciRun: 'u',
    });
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toMatchObject({
      pr: 7,
      kind: 'admin-merge-release-bump',
      head: HEAD,
      merge: MERGE,
      operator: 'op',
    });
  });
});

describe('runRelease', () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'release-run-'));
    mkdirSync(join(root, '.cleo/release'), { recursive: true });
    writeFileSync(
      join(root, `.cleo/release/${V}.plan.json`),
      JSON.stringify({ meta: { releaseNotes: NOTES } }),
    );
    writeFileSync(join(root, 'CHANGELOG.md'), NOTES);
    writeFileSync(
      join(root, 'review.json'),
      JSON.stringify({ reviewer: 'rev', notesSha256: SHA, approved: true }),
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** A fake GitHub + git: answers by command shape, records every call. */
  function fakeIo({
    versionOnly = true,
    ciConclusion = 'success',
    changelogNumstat = '5\t0\tCHANGELOG.md',
  } = {}) {
    const calls = [];
    let merged = false;
    const exec = (cmd, args) => {
      const c = [cmd, ...args].join(' ');
      calls.push(c);
      if (c.startsWith('gh repo view')) return 'main\n';
      if (c.startsWith('git config user.name')) return 'op\n';
      if (c.startsWith('git rev-parse')) return `${BASE}\n`;
      if (c.startsWith('git status')) return ' M CHANGELOG.md\n';
      if (c.startsWith('git diff --numstat')) return `${changelogNumstat}\n`;
      if (c.includes('matching-refs')) return '';
      if (c.includes('git/blobs')) return '{"sha":"blob"}';
      if (c.includes(`git/commits/${BASE}`)) return 'tree0\n';
      if (c.includes('git/trees')) return '{"sha":"tree1"}';
      if (c.includes('-X POST repos/{owner}/{repo}/git/commits')) return '{"sha":"planc"}';
      if (c.includes('git/refs')) return '{}';
      if (c.startsWith('cleo release open')) {
        return JSON.stringify({
          success: true,
          data: { workflowRunUrl: 'https://github.com/o/r/actions/runs/99' },
        });
      }
      if (c.startsWith('gh run view 99')) return '{"status":"completed","conclusion":"success"}';
      if (c.startsWith('gh pr list'))
        return JSON.stringify({ number: 7, headRefOid: HEAD, state: 'OPEN' });
      if (c.startsWith('gh run list')) {
        return JSON.stringify([
          { headSha: HEAD, status: 'completed', conclusion: ciConclusion, url: 'ci-url' },
        ]);
      }
      if (c.startsWith('git merge-base')) return `${BASE}\n`;
      if (c.startsWith('node scripts/ci-detect-version-only.mjs'))
        return `version_only=${versionOnly} (x)\n`;
      if (c.startsWith('gh pr view')) {
        return JSON.stringify(
          merged
            ? { state: 'MERGED', mergeCommit: { oid: MERGE }, headRefOid: HEAD }
            : { state: 'OPEN', mergeCommit: null, headRefOid: HEAD },
        );
      }
      if (c.startsWith('gh pr merge')) {
        merged = true;
        return '';
      }
      return '';
    };
    return { calls, io: { root, exec, sleep: () => {}, now: () => 0, log: () => {} } };
  }

  const opts = (extra = {}) => ({
    version: V,
    epic: 'T1',
    notesReview: join(root, 'review.json'),
    execute: true,
    ...extra,
  });

  it('runs plan branch -> open --ref -> wait -> version-only -> audited admin merge -> explicit tag', () => {
    const { calls, io } = fakeIo();
    runRelease(opts(), io);
    const at = (needle) => calls.findIndex((c) => c.includes(needle));
    expect(at('git/refs')).toBeGreaterThan(-1);
    expect(calls).toContain(`cleo release open ${V} --ref release/plan-${V} --epic T1`);
    expect(calls).toContain(`gh pr merge 7 --admin --merge --match-head-commit ${HEAD}`);
    expect(calls).toContain(`git tag -a ${V} -m Release ${V} ${MERGE}`);
    expect(calls).toContain(`git push origin refs/tags/${V}`);
    // Order: branch before open, version-only assert before merge, merge before tag.
    expect(at('git/refs')).toBeLessThan(at('cleo release open'));
    expect(at('ci-detect-version-only')).toBeLessThan(at('gh pr merge'));
    expect(at('gh pr merge')).toBeLessThan(at('git tag -a'));
    const audit = JSON.parse(readFileSync(join(root, AUDIT_LOG), 'utf8'));
    expect(audit).toMatchObject({
      pr: 7,
      head: HEAD,
      merge: MERGE,
      kind: 'admin-merge-release-bump',
    });
    expect(audit.reason).toContain('notes reviewed by rev');
  });

  it('a dry run mutates nothing', () => {
    const { calls, io } = fakeIo();
    runRelease(opts({ execute: false }), io);
    expect(
      calls.some((c) => /git\/(blobs|refs)|cleo release|pr merge|git tag|git push/.test(c)),
    ).toBe(false);
  });

  it('stops before any mutation without an independent notes review', () => {
    const { calls, io } = fakeIo();
    expect(() => runRelease(opts({ notesReview: undefined }), io)).toThrow('notes review');
    expect(calls.some((c) => /git\/refs|cleo release open/.test(c))).toBe(false);
  });

  it('never merges or tags a bump PR that is not version-only, or whose CI failed', () => {
    for (const io of [fakeIo({ versionOnly: false }), fakeIo({ ciConclusion: 'failure' })]) {
      expect(() => runRelease(opts(), io.io)).toThrow();
      expect(io.calls.some((c) => /gh pr merge|git tag/.test(c))).toBe(false);
    }
  });

  it('refuses a CHANGELOG with deleted lines', () => {
    const { calls, io } = fakeIo({ changelogNumstat: '5\t2\tCHANGELOG.md' });
    expect(() => runRelease(opts(), io)).toThrow('added lines only');
    expect(calls.some((c) => c.includes('git/refs'))).toBe(false);
  });
});

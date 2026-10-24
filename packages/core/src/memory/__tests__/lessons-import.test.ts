/**
 * One-time import of a Claude Code memory directory as lessons (T13949 part
 * (c), D11181): dry-run plan with provenance per row, digest-gated apply with
 * a receipt, and nothing written or deleted outside the main brain.
 *
 * @task T13949
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyLessonImport,
  defaultLessonImportDir,
  LessonImportError,
  type LessonWriter,
  planLessonImport,
} from '../lessons-import.js';

let dir = '';
let out = '';

/** A memory file with Claude Code's frontmatter shape. */
function memory(file: string, type: string | null, description: string, body: string): void {
  const meta = type === null ? '' : `metadata:\n  node_type: memory\n  type: ${type}\n`;
  writeFileSync(
    join(dir, file),
    `---\nname: ${file.replace(/\.md$/, '')}\ndescription: ${description}\n${meta}---\n\n${body}\n`,
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lessons-import-src-'));
  out = mkdtempSync(join(tmpdir(), 'lessons-import-out-'));
  writeFileSync(join(dir, 'MEMORY.md'), '# index\n- [x](x.md)\n');
  memory(
    'biome-before-push.md',
    'feedback',
    '"Biome the exact changed set before \\"every\\" push"',
    'Two PRs went red skipping it.\n\n**Why:** CI lint.\n**How to apply:** run biome first.',
  );
  memory('main-ci-red.md', 'project', 'Main CI red ~8 h while the queue merged', 'Watch main CI.');
  memory('dashboard.md', 'reference', 'Grafana board for latency', 'https://example.test');
  memory('no-type.md', null, 'A note', 'Body.');
  memory('long-rule.md', 'feedback', 'x'.repeat(201), 'Body.');
  memory('empty-why.md', 'feedback', 'A rule with no why', '');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});

describe('planLessonImport (T13949)', () => {
  it('plans feedback and project memories as lessons, with provenance, and says why the rest are skipped', () => {
    const plan = planLessonImport(dir);
    expect(plan.candidates.map((c) => [c.file, c.memoryType, c.rule])).toEqual([
      ['biome-before-push.md', 'feedback', 'Biome the exact changed set before "every" push'],
      ['main-ci-red.md', 'project', 'Main CI red ~8 h while the queue merged'],
    ]);
    const biome = plan.candidates[0]!;
    expect(biome.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(biome.text).toMatch(/^Two PRs went red skipping it\./);
    expect(
      biome.text.endsWith(
        `Imported from Claude memory biome-before-push.md (sha256 ${biome.sha256.slice(0, 16)}).`,
      ),
    ).toBe(true);
    expect(plan.skipped).toEqual([
      { file: 'dashboard.md', reason: 'memory type reference is not a lesson' },
      { file: 'empty-why.md', reason: 'empty body (no why)' },
      {
        file: 'long-rule.md',
        reason: 'no usable one-line rule: A lesson rule (--title) must be at most 200 characters',
      },
      { file: 'no-type.md', reason: 'memory type (none) is not a lesson' },
    ]);
    expect(plan.digest).toMatch(/^[0-9a-f]{16}$/);
    expect(planLessonImport(dir).digest).toBe(plan.digest);
  });

  it('changes the digest when a planned file changes, and refuses a missing directory', () => {
    const before = planLessonImport(dir).digest;
    memory('main-ci-red.md', 'project', 'Main CI red ~8 h while the queue merged', 'Edited.');
    expect(planLessonImport(dir).digest).not.toBe(before);
    expect(() => planLessonImport(join(dir, 'nope'))).toThrow(LessonImportError);
  });

  it('defaults to the project-keyed Claude memory directory', () => {
    expect(defaultLessonImportDir('/Users/me/repo', '/home/me')).toBe(
      '/home/me/.claude/projects/-Users-me-repo/memory',
    );
  });
});

describe('applyLessonImport (T13949)', () => {
  it('writes each planned lesson to the main brain and records a receipt', async () => {
    const plan = planLessonImport(dir);
    const writes: Array<{ title: string; text: string }> = [];
    const write: LessonWriter = async (lesson) => {
      writes.push(lesson);
      return writes.length === 2
        ? { id: 'O-existing', stored: false }
        : { id: `O-${writes.length}` };
    };
    const receiptPath = join(out, 'migrations', 'lessons.json');
    const receipt = await applyLessonImport(dir, plan.digest, receiptPath, { write });
    expect(writes.map((w) => w.title)).toEqual(plan.candidates.map((c) => c.rule));
    expect(writes.map((w) => w.text)).toEqual(plan.candidates.map((c) => c.text));
    expect(receipt).toMatchObject({ status: 'complete', digest: plan.digest, sourceDir: dir });
    expect(receipt.written).toEqual([
      { file: 'biome-before-push.md', sha256: plan.candidates[0]!.sha256, id: 'O-1', stored: true },
      {
        file: 'main-ci-red.md',
        sha256: plan.candidates[1]!.sha256,
        id: 'O-existing',
        stored: false,
      },
    ]);
    expect(JSON.parse(readFileSync(receiptPath, 'utf-8'))).toEqual(receipt);
    // The source directory is untouched.
    expect(readdirSync(dir).sort()).toEqual([
      'MEMORY.md',
      'biome-before-push.md',
      'dashboard.md',
      'empty-why.md',
      'long-rule.md',
      'main-ci-red.md',
      'no-type.md',
    ]);
  });

  it('refuses, writing nothing, when the directory no longer matches the approved digest', async () => {
    const plan = planLessonImport(dir);
    memory('new-lesson.md', 'feedback', 'A lesson added after review', 'Why.');
    let writes = 0;
    const receiptPath = join(out, 'lessons.json');
    await expect(
      applyLessonImport(dir, plan.digest, receiptPath, {
        write: async () => {
          writes++;
          return { id: 'O-x' };
        },
      }),
    ).rejects.toMatchObject({ code: 'E_LESSON_IMPORT_DIGEST_MISMATCH' });
    expect(writes).toBe(0);
    expect(() => readFileSync(receiptPath)).toThrow();
  });
});

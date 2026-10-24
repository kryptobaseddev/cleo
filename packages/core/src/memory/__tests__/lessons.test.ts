/**
 * Lessons index and rule validation (T13949, owner decision D11181).
 *
 * @task T13949
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LESSON_RULE_MAX, lessonRuleError, listLessons } from '../lessons.js';

describe('lessonRuleError (T13949)', () => {
  it('accepts a one-line rule and refuses a missing, multi-line or overlong one', () => {
    expect(lessonRuleError('Run biome on the exact changed files before push')).toBeNull();
    expect(lessonRuleError(undefined)).toMatch(/--title/);
    expect(lessonRuleError('   ')).toMatch(/--title/);
    expect(lessonRuleError('first line\nsecond line')).toMatch(/one line/);
    expect(lessonRuleError('x'.repeat(LESSON_RULE_MAX + 1))).toMatch(/at most/);
  });
});

describe('listLessons (T13949)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cleo-lessons-'));
    await mkdir(join(root, '.cleo'), { recursive: true });
    process.env['CLEO_DIR'] = join(root, '.cleo');
  });

  afterEach(async () => {
    const { closeBrainDb } = await import('../../store/memory-sqlite.js');
    closeBrainDb();
    delete process.env['CLEO_DIR'];
    await rm(root, { recursive: true, force: true });
  });

  it('lists current project lessons newest first and hides superseded ones', async () => {
    const { getBrainAccessor } = await import('../../store/memory-accessor.js');
    const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    const accessor = await getBrainAccessor(root);
    const add = (id: string, type: 'lesson' | 'discovery', title: string, createdAt: string) =>
      accessor.addObservation({
        id,
        type,
        title,
        narrative: `why ${id}`,
        sourceType: 'manual',
        createdAt,
      });
    await add('O-old', 'lesson', 'Old rule', '2026-10-01 00:00:00');
    await add('O-new', 'lesson', 'New rule', '2026-10-20 00:00:00');
    await add('O-gone', 'lesson', 'Superseded rule', '2026-10-21 00:00:00');
    await add('O-note', 'discovery', 'Not a lesson', '2026-10-22 00:00:00');
    getBrainNativeDb(root)!
      .prepare(
        "UPDATE brain_observations SET invalid_at = '2026-10-22 00:00:00' WHERE id = 'O-gone'",
      )
      .run();

    const lessons = await listLessons(root, { scope: 'project' });

    expect(lessons.map((l) => l.id)).toEqual(['O-new', 'O-old']);
    expect(lessons[0]).toMatchObject({ rule: 'New rule', why: 'why O-new', scope: 'project' });
  });

  it('still lists project lessons when the global brain fails under scope all (T14003)', async () => {
    const { writeFile } = await import('node:fs/promises');
    const { _resetDualScopeDbCache } = await import('../../store/dual-scope-db.js');
    const { getBrainAccessor } = await import('../../store/memory-accessor.js');
    const accessor = await getBrainAccessor(root);
    await accessor.addObservation({
      id: 'O-rule',
      type: 'lesson',
      title: 'Project rule',
      narrative: 'why',
      sourceType: 'manual',
    });
    // CLEO_HOME is a file, so the global store cannot open.
    const home = join(root, 'home-is-a-file');
    await writeFile(home, '');
    _resetDualScopeDbCache();
    process.env['CLEO_HOME'] = home;
    try {
      const failed: string[] = [];
      const lessons = await listLessons(root, {
        scope: 'all',
        onStoreError: (store) => failed.push(store),
      });
      expect(lessons.map((lesson) => lesson.id)).toEqual(['O-rule']);
      expect(failed).toEqual(['global']);
      await expect(listLessons(root, { scope: 'global' })).rejects.toThrow();
    } finally {
      delete process.env['CLEO_HOME'];
      _resetDualScopeDbCache();
    }
  });
});

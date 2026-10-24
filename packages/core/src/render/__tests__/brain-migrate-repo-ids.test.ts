/**
 * Human output of `cleo brain migrate-repo-ids` (T14012): counts, every
 * ambiguous link, and how to apply or where the receipt is.
 *
 * @task T14012
 */

import { describe, expect, it } from 'vitest';
import { renderBrainMigrateRepoIds } from '../brain/migrate-repo-ids.js';

/** Strip ANSI colour codes. */
const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '');

const unresolved = [
  { from: 'task:T3', target: 'file:src/x.ts', reason: 'more than one checkout has this path' },
];
const moved = [{ from: 'task:T1', oldTarget: 'file:src/a.ts', newTarget: 'file:a::src/a.ts' }];
const nodes = [{ oldId: 'file:src/a.ts', newId: 'file:a::src/a.ts' }];

describe('renderBrainMigrateRepoIds (T14012)', () => {
  it('previews counts and lists every ambiguous link on a dry run', () => {
    const text = plain(
      renderBrainMigrateRepoIds(
        { dryRun: true, receiptPath: null, moved, nodes, unresolved },
        false,
      ),
    );
    expect(text).toContain(
      'Dry run: would move 1 evidence link(s) to 1 repo-qualified node(s); 1 ambiguous',
    );
    expect(text).toContain(
      'ambiguous task:T3 -> file:src/x.ts: more than one checkout has this path',
    );
    expect(text).toContain('Rerun with --apply');
  });

  it('names the receipt after an apply, and prints the count when quiet', () => {
    const data = { dryRun: false, receiptPath: '/r.json', moved, nodes, unresolved: [] };
    expect(plain(renderBrainMigrateRepoIds(data, false))).toContain('Receipt: /r.json');
    expect(renderBrainMigrateRepoIds(data, true)).toBe('1');
  });
});

/**
 * Update before create (T14109, D11210): a likely duplicate doc is found by
 * content, slug, title or text, and routed to `cleo docs update`.
 *
 * @task T14109
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type DuplicateCandidate,
  describeDuplicate,
  findDuplicateDoc,
  markdownTitle,
  readDuplicateThresholds,
  recordNewBecause,
} from '../duplicate-check.js';

const words = (seed: string, n: number): string =>
  Array.from({ length: n }, (_, i) => `${seed}${i % 17} word${i}`).join(' ');

const existing: DuplicateCandidate[] = [
  {
    slug: 'release-flow',
    kind: 'guide',
    title: 'How the release flow works',
    sha256: 'a'.repeat(64),
    content: `# How the release flow works\n\n${words('release', 120)}`,
  },
  {
    slug: 'cache-evidence',
    kind: 'concept',
    title: 'Cache evidence',
    sha256: 'b'.repeat(64),
    content: '# Cache evidence\n\nShort.',
  },
  {
    slug: 't12345-fix',
    kind: 'changeset',
    title: 'Release flow works how',
    sha256: 'c'.repeat(64),
    content: null,
  },
];

describe('findDuplicateDoc', () => {
  it('flags the same bytes under another slug as an exact duplicate', () => {
    expect(
      findDuplicateDoc({ slug: 'other', kind: 'note', sha256: 'a'.repeat(64) }, existing),
    ).toMatchObject({ slug: 'release-flow', rule: 'exact', score: 1 });
  });

  it('flags a near slug of the same kind, ignoring task ids and dates', () => {
    expect(
      findDuplicateDoc({ slug: 't14109-release-flows', kind: 'guide' }, existing),
    ).toMatchObject({ slug: 'release-flow', rule: 'slug' });
    expect(
      findDuplicateDoc({ slug: 'release-flow-2026-10-28', kind: 'guide' }, existing),
    ).toMatchObject({ slug: 'release-flow', rule: 'slug' });
    expect(findDuplicateDoc({ slug: 'release-flows', kind: 'spec' }, existing)).toBeNull();
  });

  it('never matches names that differ in their numbers', () => {
    const numbered: DuplicateCandidate[] = [
      { slug: 'adr-0123-x', kind: 'adr', title: 'Phase 1 plan', sha256: 'e'.repeat(64), content: null },
      { slug: 'phase-1-plan', kind: 'plan', title: 'Phase 1 plan', sha256: 'f'.repeat(64), content: null },
      { slug: 'node-20-upgrade', kind: 'guide', title: 'Node 20 upgrade', sha256: '1'.repeat(64), content: null },
      { slug: 'test-doc-1793224723322-1', kind: 'spec', title: 'Spec A', sha256: '2'.repeat(64), content: null },
    ];
    expect(findDuplicateDoc({ slug: 'adr-0124-x', kind: 'adr' }, numbered)).toBeNull();
    expect(
      findDuplicateDoc({ slug: 'phase-2-plan', kind: 'plan', title: 'Phase 2 plan' }, numbered),
    ).toBeNull();
    expect(
      findDuplicateDoc({ slug: 'node-22-upgrade', kind: 'guide', title: 'Node 22 upgrade' }, numbered),
    ).toBeNull();
    expect(
      findDuplicateDoc({ slug: 'test-doc-1793224723322-3', kind: 'spec', title: 'Spec B' }, numbered),
    ).toBeNull();
    // The same number is still the same subject.
    expect(findDuplicateDoc({ slug: 'phase-1-plans', kind: 'plan' }, numbered)).toMatchObject({
      slug: 'phase-1-plan',
      rule: 'slug',
    });
  });

  it('flags a near title of the same kind', () => {
    expect(
      findDuplicateDoc(
        { slug: 'shipping', kind: 'guide', title: 'How the release flow works' },
        existing,
      ),
    ).toMatchObject({ slug: 'release-flow', rule: 'title', score: 1 });
    expect(
      findDuplicateDoc(
        { slug: 'shipping', kind: 'spec', title: 'How the release flow works' },
        existing,
      ),
    ).toBeNull();
  });

  it('flags a doc whose text mostly repeats an existing one', () => {
    const content = `# Something else\n\n${words('release', 120)} and a little more`;
    expect(
      findDuplicateDoc({ slug: 'shipping-notes', kind: 'guide', content }, existing),
    ).toMatchObject({
      slug: 'release-flow',
      rule: 'content',
    });
  });

  it('accepts a distinct doc, and never compares release plumbing', () => {
    expect(
      findDuplicateDoc(
        {
          slug: 'nexus-graph',
          kind: 'concept',
          title: 'The Nexus symbol graph',
          content: `# The Nexus symbol graph\n\n${words('graph', 120)}`,
          sha256: 'd'.repeat(64),
        },
        existing,
      ),
    ).toBeNull();
    expect(findDuplicateDoc({ slug: 't12345-fix', kind: 'changeset' }, existing)).toBeNull();
  });

  it('lets a project tighten a threshold, never loosen it', () => {
    expect(
      findDuplicateDoc({ slug: 'release-floe', kind: 'guide' }, existing, { slug: 0.99 }),
    ).toMatchObject({ rule: 'slug' });
    expect(
      findDuplicateDoc({ slug: 'releases-fl', kind: 'guide' }, existing, { slug: 0.5 }),
    ).toMatchObject({ rule: 'slug' });
  });
});

describe('the refusal and the override record', () => {
  it('names the existing doc, its title, and how to read and update it', () => {
    const { message, fix } = describeDuplicate({
      slug: 'release-flow',
      kind: 'guide',
      title: 'How the release flow works',
      rule: 'title',
      score: 1,
    });
    expect(message).toContain(
      'the existing guide "release-flow" (title: "How the release flow works")',
    );
    expect(message).toContain('cleo docs fetch release-flow');
    expect(message).toContain('cleo docs update release-flow');
    expect(message).toContain('--new-because');
    expect(fix).toBe('cleo docs fetch release-flow && cleo docs update release-flow');
    expect(markdownTitle('intro\n# Title Here #\nbody')).toBe('Title Here');
  });

  it('records a --new-because override with the doc it resembled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cleo-new-because-'));
    try {
      await recordNewBecause(root, {
        slug: 'release-flow-v2',
        kind: 'guide',
        resembles: { slug: 'release-flow', kind: 'guide', title: 'x', rule: 'slug', score: 0.9 },
        reason: 'covers the hotfix path the original never did',
      });
      const line = JSON.parse(
        (await readFile(join(root, '.cleo', 'audit', 'docs-new-because.jsonl'), 'utf-8')).trim(),
      );
      expect(line).toMatchObject({
        slug: 'release-flow-v2',
        resembles: { slug: 'release-flow' },
        reason: 'covers the hotfix path the original never did',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('readDuplicateThresholds', () => {
  const withCanon = async (yaml: string | null): Promise<Record<string, number>> => {
    const root = await mkdtemp(join(tmpdir(), 'dup-canon-'));
    try {
      if (yaml !== null) {
        await mkdir(join(root, '.cleo'));
        await writeFile(join(root, '.cleo', 'canon.yml'), yaml);
      }
      return await readDuplicateThresholds(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };

  it('reads similarity.warnThreshold as the slug threshold', async () => {
    expect(await withCanon('similarity:\n  warnThreshold: 0.7\n  mode: warn\n')).toEqual({
      slug: 0.7,
    });
  });

  it('yields the defaults for a missing, malformed or out-of-range block', async () => {
    expect(await withCanon(null)).toEqual({});
    expect(await withCanon('version: 1\n')).toEqual({});
    expect(await withCanon('similarity: [1\n')).toEqual({});
    expect(await withCanon('similarity:\n  warnThreshold: 2\n')).toEqual({});
  });

  it('can only tighten: a looser configured slug threshold is ignored', () => {
    const proposed = { slug: 'release-flows', kind: 'guide' };
    const tight = findDuplicateDoc(proposed, existing, { slug: 0.99 });
    expect(tight?.rule).toBe('slug');
    expect(tight).toEqual(findDuplicateDoc(proposed, existing));
  });
});

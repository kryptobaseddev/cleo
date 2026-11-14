/**
 * `cleo docs modernize` (T14113): rules, plan, apply and rollback on a
 * fixture docs tree inside a temp project.
 *
 * Covers the AC5 list: classify (rules + System One with a fake provider),
 * duplicate merge, rename, supersession, wikilink graph edges, rollback.
 *
 * @task T14113
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BlobAttachment, DecisionOutcome, DecisionRequest } from '@cleocode/contracts';
import { BUILTIN_DOC_KINDS } from '@cleocode/contracts/docs-taxonomy.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryTokenBucket } from '../../../decide/budget.js';
import { createDecisionCache } from '../../../decide/cache.js';
import type { DecideOptions } from '../../../decide/client.js';
import { createMemorySpendLedger } from '../../../decide/spend.js';
import { createAttachmentStore } from '../../../store/attachment-store.js';
import { closeDb } from '../../../store/sqlite.js';
import { extractWikilinkTargets } from '../../derive-links.js';
import { getDocsWikilinks } from '../../wikilinks.js';
import { applyDocsModernize, rollbackDocsModernize } from '../apply.js';
import { parseModernizeOverrides, parseModernizePlan } from '../guard.js';
import { planDocsModernize } from '../plan.js';
import {
  applyLinkFixes,
  classifyDocByRules,
  docSimilarity,
  markdownLinkFixes,
  mergeDocBodies,
  renameWikilinks,
  repointMarkdownLinks,
  rewriteDocLinks,
  stableSlugFor,
} from '../rules.js';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('modernize rules', () => {
  it('classifies by front matter, ADR number, folder, then falls back low', () => {
    expect(
      classifyDocByRules('x/a.md', '---\ntype: spec\n---\n# A', BUILTIN_DOC_KINDS),
    ).toMatchObject({
      kind: 'spec',
      confidence: 1,
    });
    expect(classifyDocByRules('adr-012-thing.md', '# x', BUILTIN_DOC_KINDS).kind).toBe('adr');
    expect(classifyDocByRules('plans/x.md', '# x', BUILTIN_DOC_KINDS)).toMatchObject({
      kind: 'plan',
      confidence: 0.9,
    });
    expect(classifyDocByRules('handoffs/x.md', '# x', BUILTIN_DOC_KINDS).kind).toBe('handoff');
    const unsure = classifyDocByRules('misc/thoughts.md', '# Thoughts', BUILTIN_DOC_KINDS);
    expect(unsure.kind).toBe('note');
    expect(unsure.confidence).toBeLessThan(0.75);
  });

  it('drops task, session and date tokens from slugs and keeps ADR numbers', () => {
    expect(stableSlugFor('specs/T832-gate-integrity-spec.md', '', 'spec')).toBe(
      'gate-integrity-spec',
    );
    expect(
      stableSlugFor('handoffs/T12256-comprehensive-agent-handoff-20260920.md', '', 'handoff'),
    ).toBe('comprehensive-agent-handoff');
    expect(stableSlugFor('plans/2026-04-21-agi-self-healing-plan-v2.md', '', 'plan')).toBe(
      'agi-self-healing-plan-v2',
    );
    expect(stableSlugFor('adr/ADR-7-store-layout.md', '', 'adr')).toBe('adr-007-store-layout');
    // Dotted calver names (T14107 rule via subjectSlug); a passing name is kept.
    expect(stableSlugFor('handoff/v2026.9.8-release-integrity-handoff.md', '', 'handoff')).toBe(
      'release-integrity-handoff',
    );
    expect(stableSlugFor('note/notes-2026.10.28.md', '', 'note')).toBe('notes');
    expect(stableSlugFor('release/v2026.10.28.md', '', 'release-note')).toBe('v2026.10.28');
    expect(stableSlugFor('adr/adr-001-store.md', '', 'adr')).toBe('adr-001-store');
    expect(stableSlugFor('x/T942-MANIFEST.md', '# Closeout manifest for wave two\n', 'note')).toBe(
      'closeout-manifest-for-wave-two',
    );
  });

  it('never drops duplicate content when merging', () => {
    const survivor = '# Plan\n\nintro text\n\n## Goal\nship it\n';
    const dupes = [
      '# Plan\n\nother intro\n\n## Goal\na different goal\n\n## Risks\nr1\n',
      'no headings at all\njust lines\n',
      '# Another title\n\n## Goal\nship it\n',
    ];
    for (const dup of dupes) {
      const merged = mergeDocBodies(survivor, dup, '[[old-plan]]');
      // Every non-blank line survives (a heading may carry a "(from …)" suffix);
      // only a title equal to the survivor's is treated as the same line.
      for (const line of dup.split('\n').filter((l) => l.trim() && l.trim() !== '# Plan')) {
        expect(merged.includes(line) || merged.includes(`${line} (from [[old-plan]])`)).toBe(true);
      }
    }
    expect(mergeDocBodies(survivor, survivor, '`same`')).toBe(survivor);
  });

  it('merges only new sections and rewrites links to wikilinks', () => {
    expect(docSimilarity('a\nbbb\nccc', 'a\nbbb\nccc')).toBe(1);
    const merged = mergeDocBodies(
      '# P\n\n## Goal\nx\n',
      '# P\n\n## Goal\ny\n\n## Risks\nz\n',
      '[[p-old]]',
    );
    expect(merged).toContain('## Risks');
    expect(merged).toContain('## Goal (from [[p-old]])\ny');
    const rewritten = rewriteDocLinks(
      'see [the spec](../specs/T1-a-spec.md) and [[T1-a-spec]]',
      'handoffs/h.md',
      new Map([['specs/T1-a-spec.md', 'a-spec']]),
    );
    expect(rewritten).toBe('see [[a-spec|the spec]] and [[T1-a-spec]]');
    expect(extractWikilinkTargets(rewritten)).toEqual(['T1-a-spec', 'a-spec']);
    expect(renameWikilinks(rewritten, new Map([['T1-a-spec', 'a-spec']]))).toBe(
      'see [[a-spec|the spec]] and [[a-spec]]',
    );
  });

  it('re-points relative markdown links after a move and keeps them markdown (T14185)', () => {
    const finalPathOf = new Map([
      ['specs/a.md', 'spec/a.md'],
      ['specs/b.md', 'spec/b.md'],
      ['plans/old.md', 'plan/merged.md'],
    ]);
    const body =
      'see [b](./b.md#part), [merged](../plans/old.md), ![img](../images/x.png), ' +
      '[web](https://example.com/a.md) and [here](#top)';
    expect(repointMarkdownLinks(body, 'specs/a.md', 'spec/a.md', finalPathOf)).toBe(
      'see [b](./b.md#part), [merged](../plan/merged.md), ![img](../images/x.png), ' +
        '[web](https://example.com/a.md) and [here](#top)',
    );
    // Moved one level deeper: links to files that stayed put are re-pointed too.
    expect(
      repointMarkdownLinks('[img](../images/x.png)', 'specs/a.md', 'spec/deep/a.md', finalPathOf),
    ).toBe('[img](../../images/x.png)');
    // Unmoved file, unmoved target: untouched byte for byte.
    expect(
      repointMarkdownLinks('[o](../other/o.md)', 'notes/n.md', 'notes/n.md', finalPathOf),
    ).toBe('[o](../other/o.md)');
    // A kept file: only hrefs whose targets move are listed, and applying the
    // list changes those hrefs and nothing else.
    const kept = '# Kept\n\n[m](../plans/old.md) twice [m2](../plans/old.md), [o](../other/o.md)\n';
    const fixes = markdownLinkFixes(kept, 'notes/k.md', finalPathOf);
    expect(fixes).toEqual([{ href: '../plans/old.md', newHref: '../plan/merged.md' }]);
    expect(applyLinkFixes(kept, fixes)).toBe(
      '# Kept\n\n[m](../plan/merged.md) twice [m2](../plan/merged.md), [o](../other/o.md)\n',
    );
  });
});

describe('modernize plan → apply → rollback (fixture tree)', () => {
  let projectRoot: string;
  let docsRoot: string;
  let prevCleoDir: string | undefined;
  let prevCwd: string;
  const original = new Map<string, string>();

  const fixture: Record<string, string> = {
    'specs/T832-gate-integrity-spec.md':
      '# Gate integrity spec\n\n## Requirements\n- gates must hold\n',
    'plans/2026-04-21-self-healing-plan.md':
      '# Self-healing plan\n\n## Goal\nheal the system\n\n## Steps\nstep one\nstep two\nstep three\n\n## Risks\nrisk a\n',
    'plans/2026-04-22-self-healing-plan.md':
      '# Self-healing plan\n\n## Goal\nheal the system\n\n## Steps\nstep one\nstep two\nstep three\n\n## Owners\nowner a\n',
    'handoffs/T12256-agent-handoff-20260920.md':
      '# Agent handoff\n\nRead [the spec](../specs/T832-gate-integrity-spec.md) first. Work on T12256.\n',
    'research/foo-report.md': '# Foo report\n\nfindings here\n',
    'analysis/foo-report.md': '# Foo report\n\nfindings here\n',
    'adr/adr-001-store.md':
      '# ADR 001 store\n\n## Context\nc\n\n## Decision\nd, see [the spec](../specs/T832-gate-integrity-spec.md)\n',
    'misc/random-thoughts.md': '# Random thoughts\n\nsome loose text\n',
  };

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'cleo-modernize-'));
    mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
    mkdirSync(join(projectRoot, '.git'), { recursive: true });
    prevCleoDir = process.env['CLEO_DIR'];
    process.env['CLEO_DIR'] = join(projectRoot, '.cleo');
    prevCwd = process.cwd();
    process.chdir(projectRoot);
    docsRoot = join(projectRoot, 'docs');
    original.clear();
    for (const [rel, text] of Object.entries(fixture)) {
      const abs = join(docsRoot, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, text);
      original.set(rel, text);
    }
  });

  afterEach(() => {
    closeDb();
    process.chdir(prevCwd);
    if (prevCleoDir === undefined) delete process.env['CLEO_DIR'];
    else process.env['CLEO_DIR'] = prevCleoDir;
    rmSync(projectRoot, { recursive: true, force: true });
  });

  /** A fake System One that answers `research` to classify and `merge` to merge. */
  function fakeSystemOne(asked: DecisionRequest[]): DecideOptions {
    return {
      cache: createDecisionCache(),
      budget: createMemoryTokenBucket(),
      spend: createMemorySpendLedger(),
      spendCapMicros: 1_000_000,
      timeoutMs: 2_000,
      audit: null,
      provider: {
        decide: async (req): Promise<DecisionOutcome> => {
          asked.push(req);
          const [name] = Object.keys(req.questions);
          const value = name === 'classify' ? 'research' : 'merge';
          return {
            answers: {
              [name ?? 'classify']: {
                type: 'choice',
                value,
                probabilities: { [value]: 0.9 },
                confidence: 0.9,
              },
            },
            source: 'provider',
            latencyMs: 1,
          };
        },
      },
    };
  }

  it('plans kinds, stable slugs and dispositions, with System One judging the ambiguous file', async () => {
    const asked: DecisionRequest[] = [];
    const plan = await planDocsModernize({
      root: docsRoot,
      projectRoot,
      mode: 'on',
      decide: fakeSystemOne(asked),
    });
    const row = (path: string) => plan.rows.find((r) => r.path === path);

    expect(row('specs/T832-gate-integrity-spec.md')).toMatchObject({
      kind: 'spec',
      slug: 'gate-integrity-spec',
      disposition: 'rename',
      target: 'spec/gate-integrity-spec.md',
    });
    expect(row('adr/adr-001-store.md')).toMatchObject({
      slug: 'adr-001-store',
      disposition: 'keep',
    });
    // T14107 naming rule: the old name broke it, the new slug does not.
    expect(row('specs/T832-gate-integrity-spec.md')?.baselineRemove).toBe(true);
    expect(row('adr/adr-001-store.md')?.baselineRemove).toBe(false);
    expect(row('plans/2026-04-22-self-healing-plan.md')).toMatchObject({
      slug: 'self-healing-plan',
      disposition: 'rename',
      target: 'plan/self-healing-plan.md',
    });
    expect(row('plans/2026-04-21-self-healing-plan.md')).toMatchObject({
      disposition: 'merge-into',
      target: 'self-healing-plan',
    });
    const dupes = [row('analysis/foo-report.md'), row('research/foo-report.md')];
    expect(dupes.map((r) => r?.disposition).sort()).toEqual(['delete', 'keep']);

    const ambiguous = row('misc/random-thoughts.md');
    expect(ambiguous?.kind).toBe('research');
    expect(ambiguous?.judgments[0]).toMatchObject({
      question: 'classify',
      site: 'docs.modernize.classify',
      ruleAnswer: 'note',
      decidedAnswer: 'research',
      source: 'provider',
      acted: 'research',
    });
    expect(asked.length).toBeGreaterThan(0);
    for (const r of plan.rows) expect(r.reasons.length).toBeGreaterThan(0);
  });

  it('falls back to the rule and records it when System One is unreachable', async () => {
    const plan = await planDocsModernize({
      root: docsRoot,
      projectRoot,
      decide: { connection: null },
    });
    const ambiguous = plan.rows.find((r) => r.path === 'misc/random-thoughts.md');
    expect(ambiguous?.kind).toBe('note');
    expect(ambiguous?.judgments[0]).toMatchObject({
      mode: 'off',
      source: 'fallback',
      decidedAnswer: null,
      acted: 'note',
    });
  });

  it('applies: stores, merges, supersedes, moves files and writes graph edges; rollback restores all', async () => {
    const plan = await planDocsModernize({
      root: docsRoot,
      projectRoot,
      decide: { connection: null },
    });
    const receipt = await applyDocsModernize({ plan, projectRoot, allowDirty: true });
    const store = createAttachmentStore();

    // Rename + no task/date names left + no duplicate category folders.
    expect(existsSync(join(docsRoot, 'spec/gate-integrity-spec.md'))).toBe(true);
    expect(existsSync(join(docsRoot, 'specs'))).toBe(false);
    expect(existsSync(join(docsRoot, 'plans'))).toBe(false);
    expect(existsSync(join(docsRoot, 'analysis'))).toBe(false);

    // Duplicate merge: the survivor carries the merged doc's extra section.
    const plan2 = readFileSync(join(docsRoot, 'plan/self-healing-plan.md'), 'utf-8');
    expect(plan2).toContain('## Owners');
    expect(plan2).toContain('## Risks');

    // Supersession: the merged file is stored under its legacy name and superseded.
    const legacy = await store.findBySlug('self-healing-plan-superseded', projectRoot);
    expect(legacy?.lifecycleStatus).toBe('superseded');
    // T14185: the fold heading cites that resolvable slug, never a folder-prefixed path id.
    expect(plan2).toContain('merged from `self-healing-plan-superseded`');
    expect(plan2).not.toMatch(/plans-/);

    // T14185: a kept file that links to a moved file gets only that href
    // re-pointed, and the dry run listed exactly that edit.
    const keptFix = {
      kind: 'link-fix',
      path: 'adr/adr-001-store.md',
      href: '../specs/T832-gate-integrity-spec.md',
      newHref: '../spec/gate-integrity-spec.md',
    };
    expect(plan.linkFixes).toEqual([keptFix]);
    expect(readFileSync(join(docsRoot, 'adr/adr-001-store.md'), 'utf-8')).toBe(
      original.get('adr/adr-001-store.md')?.replace(keptFix.href, keptFix.newHref),
    );
    expect(receipt.ops.some((o) => o.op === 'supersede' && o.target === 'self-healing-plan')).toBe(
      true,
    );

    // Graph edges: the rewritten link is a links-to edge; the task mention a related-task edge.
    const handoff = readFileSync(join(docsRoot, 'handoff/agent-handoff.md'), 'utf-8');
    // T14185: the moved target's inbound link stays markdown, re-pointed at its new path.
    expect(handoff).toContain('[the spec](../spec/gate-integrity-spec.md)');
    expect(handoff).not.toContain('[[');
    const edges = await getDocsWikilinks('agent-handoff', { direction: 'out', projectRoot });
    expect(edges).toContainEqual({
      fromSlug: 'agent-handoff',
      toSlug: 'gate-integrity-spec',
      relation: 'links-to',
      toIsTask: false,
    });
    expect(edges.some((e) => e.relation === 'related-task' && e.toSlug === 'T12256')).toBe(true);

    // Every scanned file is confirmed in the blob store; moves and deletes are listed.
    expect(receipt.blobs.map((b) => b.path).sort()).toEqual([...original.keys()].sort());
    for (const b of receipt.blobs) {
      expect(
        sha(readFileSync(join(projectRoot, '.cleo', 'blobs', 'blobs', b.sha256), 'utf-8')),
      ).toBe(b.sha256);
    }
    expect(receipt.moves).toContainEqual({
      from: 'specs/T832-gate-integrity-spec.md',
      to: 'spec/gate-integrity-spec.md',
    });
    expect(receipt.deleted).toContain('plans/2026-04-21-self-healing-plan.md');
    expect(
      plan.rows.find((r) => r.path === 'handoffs/T12256-agent-handoff-20260920.md')?.ownerTasks,
    ).toEqual(['T12256']);

    // Rollback by receipt.
    const rolled = await rollbackDocsModernize(projectRoot, receipt.runId);
    expect(rolled.rolledBackAt).not.toBeNull();
    for (const [rel, text] of original) {
      expect(sha(readFileSync(join(docsRoot, rel), 'utf-8'))).toBe(sha(text));
    }
    expect(existsSync(join(docsRoot, 'spec'))).toBe(false);
    expect(await store.findBySlug('gate-integrity-spec', projectRoot)).toBeNull();
    expect(await store.findBySlug('self-healing-plan-superseded', projectRoot)).toBeNull();
    expect(await getDocsWikilinks('agent-handoff', { projectRoot })).toEqual([]);
    await expect(rollbackDocsModernize(projectRoot, receipt.runId)).rejects.toThrow(
      /already rolled back/,
    );
  });

  it('lets an override win without asking System One', async () => {
    const asked: DecisionRequest[] = [];
    const plan = await planDocsModernize({
      root: docsRoot,
      projectRoot,
      mode: 'on',
      decide: fakeSystemOne(asked),
      overrides: {
        'misc/random-thoughts.md': {
          disposition: 'delete',
          target: 'gate-integrity-spec',
          reason: 'census: scratch notes',
        },
      },
    });
    const row = plan.rows.find((r) => r.path === 'misc/random-thoughts.md');
    expect(row).toMatchObject({ disposition: 'delete', overridden: true, judgments: [] });
    expect(row?.reasons.at(-1)).toBe('override: census: scratch notes');
    expect(asked.some((r) => JSON.stringify(r).includes('random-thoughts'))).toBe(false);
  });

  it('store-only ingests every file owned by its task and leaves the folder untouched', async () => {
    const plan = await planDocsModernize({
      root: docsRoot,
      projectRoot,
      storeOnly: true,
      kind: 'note',
      decide: { connection: null },
    });
    expect(plan.mode).toBe('store-only');
    const receipt = await applyDocsModernize({ plan, projectRoot });
    for (const [rel, text] of original) {
      expect(readFileSync(join(docsRoot, rel), 'utf-8')).toBe(text);
    }
    expect(receipt.blobs).toHaveLength(original.size);
    expect(receipt.moves).toEqual([]);
    const store = createAttachmentStore();
    const owned = await store.listByOwner('task', 'T12256', projectRoot);
    expect(owned.map((m) => m.sha256)).toContain(
      sha(fixture['handoffs/T12256-agent-handoff-20260920.md'] ?? ''),
    );
    await rollbackDocsModernize(projectRoot, receipt.runId);
    expect(await store.listByOwner('task', 'T12256', projectRoot)).toEqual([]);
  });

  it('refuses --apply on a dirty git tree', async () => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
    );
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
        cwd: projectRoot,
        env,
        stdio: 'ignore',
      });
    rmSync(join(projectRoot, '.git'), { recursive: true, force: true });
    git('init', '-q');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', 'docs');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fixture');
    const plan = await planDocsModernize({
      root: docsRoot,
      projectRoot,
      decide: { connection: null },
    });
    writeFileSync(join(docsRoot, 'misc/new-file.md'), '# new\n');
    await expect(applyDocsModernize({ plan, projectRoot })).rejects.toMatchObject({
      code: 'E_MODERNIZE_DIRTY',
    });
    expect(existsSync(join(docsRoot, 'specs/T832-gate-integrity-spec.md'))).toBe(true);
  });

  it('refuses unsafe plans: paths outside the root and malformed plan files', async () => {
    const plan = await planDocsModernize({
      root: docsRoot,
      projectRoot,
      decide: { connection: null },
    });
    const escaped = {
      ...plan,
      rows: plan.rows.map((r, i) =>
        i === 0 ? { ...r, disposition: 'rename' as const, target: '../../outside.md' } : r,
      ),
    };
    await expect(
      applyDocsModernize({ plan: escaped, projectRoot, allowDirty: true }),
    ).rejects.toMatchObject({
      code: 'E_MODERNIZE_UNSAFE',
    });
    expect(existsSync(join(projectRoot, '..', 'outside.md'))).toBe(false);
    expect(() => parseModernizePlan('{"root":"/x","rows":[{"path":1}]}', projectRoot)).toThrow(
      /plan schema/,
    );
  });

  it('fails closed when git cannot vouch for the root', async () => {
    const plan = await planDocsModernize({
      root: docsRoot,
      projectRoot,
      decide: { connection: null },
    });
    await expect(applyDocsModernize({ plan, projectRoot })).rejects.toMatchObject({
      code: 'E_MODERNIZE_DIRTY',
    });
  });

  it('journals every step ahead of it and rolls back resumably, refusing edited files', async () => {
    const plan = await planDocsModernize({
      root: docsRoot,
      projectRoot,
      decide: { connection: null },
    });
    const receipt = await applyDocsModernize({ plan, projectRoot, allowDirty: true });
    const journal = readFileSync(
      join(projectRoot, '.cleo', 'modernize', `${receipt.runId}.ops.jsonl`),
      'utf-8',
    )
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { i: number; state: string });
    for (const op of receipt.ops) expect(op.state).toBe('done');
    expect(journal.filter((l) => l.state === 'pending')).toHaveLength(receipt.ops.length);
    expect(receipt.ops.some((o) => o.op === 'fold' && o.target === 'self-healing-plan')).toBe(true);
    expect(receipt.ops.some((o) => o.op === 'link' && o.slug === 'agent-handoff')).toBe(true);

    // An edit after the apply stops the rollback before it overwrites anything...
    const edited = join(docsRoot, 'spec/gate-integrity-spec.md');
    const applied = readFileSync(edited, 'utf-8');
    writeFileSync(edited, `${applied}\nhand edit\n`);
    await expect(rollbackDocsModernize(projectRoot, receipt.runId)).rejects.toThrow(
      /changed after the modernize run/,
    );
    // ...and once resolved, the rollback resumes and finishes.
    writeFileSync(edited, applied);
    await rollbackDocsModernize(projectRoot, receipt.runId);
    for (const [rel, text] of original) {
      expect(readFileSync(join(docsRoot, rel), 'utf-8')).toBe(text);
    }
  });

  for (const crashed of [false, true]) {
    it(`merges into an existing stored doc without dropping it; rollback restores the row and its links${crashed ? ' (merge journaled pending, process died after commit)' : ''}`, async () => {
      const store = createAttachmentStore();
      const storedBody =
        '# Gate integrity spec\n\n## Requirements\n- gates must hold\n- and stay held\n\n## History\nolder notes, see [[history-note]]\n';
      const bytes = Buffer.from(storedBody, 'utf-8');
      const blob: Omit<BlobAttachment, 'sha256'> = {
        kind: 'blob',
        storageKey: '',
        mime: 'text/markdown',
        size: bytes.byteLength,
      };
      const seeded = await store.put(bytes, blob, 'task', '__project__', 'test', projectRoot, {
        slug: 'gate-integrity-spec',
        type: 'spec',
      });
      const linksOf = async () =>
        (await getDocsWikilinks('gate-integrity-spec', { direction: 'out', projectRoot }))
          .filter((e) => e.relation === 'links-to')
          .map((e) => e.toSlug)
          .sort();
      expect(await linksOf()).toEqual(['history-note']);
      const plan = await planDocsModernize({
        root: docsRoot,
        projectRoot,
        decide: { connection: null },
      });
      expect(plan.rows.find((r) => r.slug === 'gate-integrity-spec')?.reasons.at(-1)).toMatch(
        /merges into the existing/,
      );
      // The crash case applies only the merging file, so the merge is the
      // last store step and truncating the journal after it is faithful.
      const used = crashed
        ? {
            ...plan,
            rows: plan.rows.filter((r) => r.slug === 'gate-integrity-spec'),
            linkFixes: [],
          }
        : plan;
      const receipt = await applyDocsModernize({ plan: used, projectRoot, allowDirty: true });
      const now = await store.findBySlug('gate-integrity-spec', projectRoot);
      const merged =
        (await store.get(now?.metadata.sha256 ?? '', projectRoot))?.bytes.toString('utf-8') ?? '';
      expect(merged).toContain('older notes');
      expect(now?.metadata.id).not.toBe(seeded.id);
      const mergeOp = receipt.ops.find((o) => o.op === 'merge');
      expect(mergeOp?.prior?.previousAttachmentId).toBe(seeded.id);
      expect(mergeOp?.prior?.linkTargets).toEqual(['history-note']);
      if (crashed) {
        // Drop every journal line after the merge's `pending` entry: the
        // store committed, the journal never heard back.
        const jp = join(projectRoot, '.cleo', 'modernize', `${receipt.runId}.ops.jsonl`);
        const lines = readFileSync(jp, 'utf-8').trim().split('\n');
        const at = lines.findIndex((l) => l.includes('"op":"merge"'));
        writeFileSync(jp, `${lines.slice(0, at + 1).join('\n')}\n`);
      }
      await rollbackDocsModernize(projectRoot, receipt.runId);
      expect((await store.findBySlug('gate-integrity-spec', projectRoot))?.metadata.id).toBe(
        seeded.id,
      );
      expect(await linksOf()).toEqual(['history-note']);
    });
  }

  it('a run that updates a successor keeps its supersession edges, and so does the rollback (T14565)', async () => {
    const store = createAttachmentStore();
    const put = async (slug: string, body: string) => {
      const bytes = Buffer.from(body, 'utf-8');
      const blob: Omit<BlobAttachment, 'sha256'> = {
        kind: 'blob',
        storageKey: '',
        mime: 'text/markdown',
        size: bytes.byteLength,
      };
      return store.put(bytes, blob, 'task', '__project__', 'test', projectRoot, {
        slug,
        type: 'spec',
      });
    };
    await put('gate-integrity-draft', '# Gate integrity draft\n\nan early draft\n');
    const seeded = await put(
      'gate-integrity-spec',
      '# Gate integrity spec\n\n## Requirements\n- gates must hold\n- and stay held\n\n## History\nolder notes\n',
    );
    const { supersedeDoc } = await import('../../supersede.js');
    const { readDocLineage } = await import('../../lineage.js');
    await supersedeDoc(projectRoot, {
      oldSlug: 'gate-integrity-draft',
      newSlug: 'gate-integrity-spec',
    });
    const expectEdge = async () => {
      expect(await readDocLineage(projectRoot, 'gate-integrity-draft')).toMatchObject({
        lifecycleStatus: 'superseded',
        supersededBy: 'gate-integrity-spec',
        currentSlug: 'gate-integrity-spec',
      });
      expect(await readDocLineage(projectRoot, 'gate-integrity-spec')).toMatchObject({
        supersedes: 'gate-integrity-draft',
        supersededBy: null,
      });
    };
    await expectEdge();

    const plan = await planDocsModernize({
      root: docsRoot,
      projectRoot,
      decide: { connection: null },
    });
    const receipt = await applyDocsModernize({ plan, projectRoot, allowDirty: true });
    // The merge wrote a new version of the successor: its slug is on a new row.
    expect(receipt.ops.some((o) => o.op === 'merge' && o.slug === 'gate-integrity-spec')).toBe(
      true,
    );
    expect((await store.findBySlug('gate-integrity-spec', projectRoot))?.metadata.id).not.toBe(
      seeded.id,
    );
    await expectEdge();

    await rollbackDocsModernize(projectRoot, receipt.runId);
    expect((await store.findBySlug('gate-integrity-spec', projectRoot))?.metadata.id).toBe(
      seeded.id,
    );
    await expectEdge();
  });

  it('skips a torn last journal line and refuses to revert a doc another writer updated', async () => {
    const store = createAttachmentStore();
    const storedBody =
      '# Gate integrity spec\n\n## Requirements\n- gates must hold\n- and stay held\n';
    const bytes = Buffer.from(storedBody, 'utf-8');
    const blob: Omit<BlobAttachment, 'sha256'> = {
      kind: 'blob',
      storageKey: '',
      mime: 'text/markdown',
      size: bytes.byteLength,
    };
    await store.put(bytes, blob, 'task', '__project__', 'test', projectRoot, {
      slug: 'gate-integrity-spec',
      type: 'spec',
    });
    const plan = await planDocsModernize({
      root: docsRoot,
      projectRoot,
      decide: { connection: null },
    });
    const only = {
      ...plan,
      rows: plan.rows.filter((r) => r.slug === 'gate-integrity-spec'),
      linkFixes: [],
    };
    const receipt = await applyDocsModernize({ plan: only, projectRoot, allowDirty: true });
    expect(receipt.ops.some((o) => o.op === 'merge')).toBe(true);
    // A crash mid-append leaves half a line at the end of the journal.
    const jp = join(projectRoot, '.cleo', 'modernize', `${receipt.runId}.ops.jsonl`);
    writeFileSync(jp, `${readFileSync(jp, 'utf-8')}{"i":99,"op":"ing`);
    // Another writer edits the doc after the run.
    const { updateDocBySlug } = await import('../../docs-update.js');
    const later = await updateDocBySlug(projectRoot, {
      slug: 'gate-integrity-spec',
      content: '# Gate integrity spec\n\nrewritten by someone else\n',
    });
    expect(later.ok).toBe(true);
    await expect(rollbackDocsModernize(projectRoot, receipt.runId)).rejects.toThrow(
      /updated after the modernize run/,
    );
  });

  it('rewrites links to wikilinks only on opt-in, with resolvable slugs, never in kept files (T14185)', async () => {
    const plan = await planDocsModernize({
      root: docsRoot,
      projectRoot,
      decide: { connection: null },
    });
    await applyDocsModernize({ plan, projectRoot, allowDirty: true, wikilinks: true });
    const handoff = readFileSync(join(docsRoot, 'handoff/agent-handoff.md'), 'utf-8');
    expect(handoff).toContain('[[gate-integrity-spec|the spec]]');
    const store = createAttachmentStore();
    for (const target of extractWikilinkTargets(
      readFileSync(join(docsRoot, 'plan/self-healing-plan.md'), 'utf-8') + handoff,
    )) {
      expect(await store.findBySlug(target, projectRoot)).not.toBeNull();
    }
    // Kept files keep markdown: their link fixes are hrefs, never wikilinks.
    expect(readFileSync(join(docsRoot, 'adr/adr-001-store.md'), 'utf-8')).toBe(
      original
        .get('adr/adr-001-store.md')
        ?.replace('../specs/T832-gate-integrity-spec.md', '../spec/gate-integrity-spec.md'),
    );
  });

  it('edits a kept file only as the plan lists, and refuses a link fix on a file it does not keep (T14185)', async () => {
    const plan = await planDocsModernize({
      root: docsRoot,
      projectRoot,
      decide: { connection: null },
    });
    await expect(
      applyDocsModernize({
        plan: {
          ...plan,
          linkFixes: [
            {
              kind: 'link-fix',
              path: 'handoffs/T12256-agent-handoff-20260920.md',
              href: 'x.md',
              newHref: 'y.md',
            },
          ],
        },
        projectRoot,
        allowDirty: true,
      }),
    ).rejects.toThrow(/link-fix/);
    // A plan without the fix row leaves the kept file byte-identical.
    await applyDocsModernize({
      plan: { ...plan, linkFixes: [] },
      projectRoot,
      allowDirty: true,
    });
    expect(readFileSync(join(docsRoot, 'adr/adr-001-store.md'), 'utf-8')).toBe(
      original.get('adr/adr-001-store.md'),
    );
  });

  it('re-points inbound links from an excluded folder as link-fix rows, with no store write (T14194)', async () => {
    const outside =
      '# Index\n\nSee [the spec](../specs/T832-gate-integrity-spec.md), ' +
      '[the plan](../plans/2026-04-21-self-healing-plan.md#goal) and [the web](https://example.com/a.md).\n';
    mkdirSync(join(docsRoot, 'concepts'), { recursive: true });
    writeFileSync(join(docsRoot, 'concepts', 'index.md'), outside);
    const plan = await planDocsModernize({
      root: docsRoot,
      projectRoot,
      exclude: ['concepts'],
      decide: { connection: null },
    });
    // Read, never planned: no row, only its link-fix rows (with the bytes they were planned on).
    expect(plan.rows.some((r) => r.path.startsWith('concepts/'))).toBe(false);
    expect(plan.linkFixes?.filter((f) => f.path === 'concepts/index.md')).toEqual([
      {
        kind: 'link-fix',
        path: 'concepts/index.md',
        href: '../specs/T832-gate-integrity-spec.md',
        newHref: '../spec/gate-integrity-spec.md',
        sha256: sha(outside),
      },
      {
        kind: 'link-fix',
        path: 'concepts/index.md',
        href: '../plans/2026-04-21-self-healing-plan.md#goal',
        newHref: '../plan/self-healing-plan.md#goal',
        sha256: sha(outside),
      },
    ]);
    // Without --exclude the folder is in scope, so it is planned, not link-fixed.
    const unscoped = await planDocsModernize({
      root: docsRoot,
      projectRoot,
      decide: { connection: null },
    });
    expect(unscoped.linkFixes?.some((f) => f.path === 'concepts/index.md')).toBe(false);

    const receipt = await applyDocsModernize({ plan, projectRoot, allowDirty: true });
    const edited = outside
      .replace('../specs/T832-gate-integrity-spec.md', '../spec/gate-integrity-spec.md')
      .replace(
        '../plans/2026-04-21-self-healing-plan.md#goal',
        '../plan/self-healing-plan.md#goal',
      );
    expect(readFileSync(join(docsRoot, 'concepts', 'index.md'), 'utf-8')).toBe(edited);
    // Nothing of it reaches the store, and it is not a blob the run confirmed.
    const store = createAttachmentStore();
    expect(await store.getMetadata(sha(outside), projectRoot)).toBeNull();
    expect(await store.getMetadata(sha(edited), projectRoot)).toBeNull();
    expect(receipt.blobs.some((b) => b.path === 'concepts/index.md')).toBe(false);
    expect(receipt.ops.filter((o) => o.path === 'concepts/index.md').map((o) => o.op)).toEqual([
      'write-file',
    ]);

    await rollbackDocsModernize(projectRoot, receipt.runId);
    expect(readFileSync(join(docsRoot, 'concepts', 'index.md'), 'utf-8')).toBe(outside);
  });

  it('refuses an out-of-scope link fix whose file changed since the plan (T14194)', async () => {
    mkdirSync(join(docsRoot, 'concepts'), { recursive: true });
    writeFileSync(
      join(docsRoot, 'concepts', 'index.md'),
      '[s](../specs/T832-gate-integrity-spec.md)\n',
    );
    const plan = await planDocsModernize({
      root: docsRoot,
      projectRoot,
      exclude: ['concepts'],
      decide: { connection: null },
    });
    writeFileSync(
      join(docsRoot, 'concepts', 'index.md'),
      '[s](../specs/T832-gate-integrity-spec.md) edited\n',
    );
    await expect(applyDocsModernize({ plan, projectRoot, allowDirty: true })).rejects.toThrow(
      /changed since the plan was made/,
    );
    expect(existsSync(join(docsRoot, 'spec'))).toBe(false);
  });

  describe('links from markdown outside the root (T14196)', () => {
    const env = (): NodeJS.ProcessEnv =>
      Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        ['-c', 'core.hooksPath=/dev/null', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
        { cwd: projectRoot, env: env(), stdio: 'ignore' },
      );
    const README =
      '# Repo\n\nRead [the spec](docs/specs/T832-gate-integrity-spec.md#requirements).\n';
    const PKG = '# Pkg\n\nSee [plan](../../docs/plans/2026-04-21-self-healing-plan.md).\n';
    const HISTORY = '- shipped [the spec](docs/specs/T832-gate-integrity-spec.md)\n';

    /** A real repo: docs/ plus a README, a package README, a CHANGELOG and a changeset linking into it. */
    function seedRepo(): void {
      writeFileSync(join(projectRoot, 'README.md'), README);
      mkdirSync(join(projectRoot, 'packages', 'x'), { recursive: true });
      writeFileSync(join(projectRoot, 'packages', 'x', 'README.md'), PKG);
      writeFileSync(join(projectRoot, 'CHANGELOG.md'), HISTORY);
      mkdirSync(join(projectRoot, '.changeset'), { recursive: true });
      writeFileSync(join(projectRoot, '.changeset', 'a.md'), HISTORY);
      writeFileSync(join(projectRoot, '.gitignore'), '.cleo/\n');
      rmSync(join(projectRoot, '.git'), { recursive: true, force: true });
      git('init', '-q');
      git('add', '.');
      git('commit', '-qm', 'fixture');
    }

    it('plans sha-pinned repo-base link fixes, never for history, and applies them with rollback', async () => {
      seedRepo();
      const plan = await planDocsModernize({
        root: docsRoot,
        projectRoot,
        decide: { connection: null },
      });
      expect(plan.repoRoot).toBe(projectRoot);
      expect(plan.linkFixes?.filter((f) => f.base === 'repo')).toEqual([
        {
          kind: 'link-fix',
          base: 'repo',
          path: 'README.md',
          href: 'docs/specs/T832-gate-integrity-spec.md#requirements',
          newHref: 'docs/spec/gate-integrity-spec.md#requirements',
          sha256: sha(README),
        },
        {
          kind: 'link-fix',
          base: 'repo',
          path: 'packages/x/README.md',
          href: '../../docs/plans/2026-04-21-self-healing-plan.md',
          newHref: '../../docs/plan/self-healing-plan.md',
          sha256: sha(PKG),
        },
      ]);
      // A clean checkout: no --allow-dirty needed.
      const receipt = await applyDocsModernize({ plan, projectRoot });
      expect(readFileSync(join(projectRoot, 'README.md'), 'utf-8')).toBe(
        README.replace(
          'docs/specs/T832-gate-integrity-spec.md',
          'docs/spec/gate-integrity-spec.md',
        ),
      );
      expect(readFileSync(join(projectRoot, 'packages', 'x', 'README.md'), 'utf-8')).toBe(
        PKG.replace('docs/plans/2026-04-21-self-healing-plan.md', 'docs/plan/self-healing-plan.md'),
      );
      // History is never rewritten.
      expect(readFileSync(join(projectRoot, 'CHANGELOG.md'), 'utf-8')).toBe(HISTORY);
      expect(readFileSync(join(projectRoot, '.changeset', 'a.md'), 'utf-8')).toBe(HISTORY);
      // Repo files never reach the store; the receipt records their base.
      const store = createAttachmentStore();
      expect(await store.getMetadata(sha(README), projectRoot)).toBeNull();
      expect(receipt.repoRoot).toBe(projectRoot);
      expect(receipt.ops.filter((o) => o.base === 'repo').map((o) => [o.op, o.path])).toEqual([
        ['write-file', 'README.md'],
        ['write-file', 'packages/x/README.md'],
      ]);

      await rollbackDocsModernize(projectRoot, receipt.runId);
      expect(readFileSync(join(projectRoot, 'README.md'), 'utf-8')).toBe(README);
      expect(readFileSync(join(projectRoot, 'packages', 'x', 'README.md'), 'utf-8')).toBe(PKG);
    });

    it('refuses repo-base fixes for history, inside the root, or with a dirty or changed file', async () => {
      seedRepo();
      const plan = await planDocsModernize({
        root: docsRoot,
        projectRoot,
        decide: { connection: null },
      });
      const fix = plan.linkFixes?.find((f) => f.path === 'README.md');
      if (!fix) throw new Error('fixture: README fix missing');
      for (const path of ['CHANGELOG.md', '.changeset/a.md', 'docs/misc/random-thoughts.md']) {
        await expect(
          applyDocsModernize({
            plan: { ...plan, linkFixes: [{ ...fix, path }] },
            projectRoot,
            allowDirty: true,
          }),
        ).rejects.toMatchObject({ code: 'E_MODERNIZE_UNSAFE' });
      }
      writeFileSync(join(projectRoot, 'README.md'), `${README}edited\n`);
      await expect(applyDocsModernize({ plan, projectRoot })).rejects.toMatchObject({
        code: 'E_MODERNIZE_DIRTY',
      });
      await expect(
        applyDocsModernize({ plan, projectRoot, allowDirty: true }),
      ).rejects.toMatchObject({ code: 'E_MODERNIZE_STALE' });
      expect(existsSync(join(docsRoot, 'spec'))).toBe(false);
    });
  });

  it('deletes with no survivor: stored under its own slug, file removed, no supersede edge (T14212)', async () => {
    // Omitted and explicit-null targets both mean "no survivor".
    expect(
      parseModernizeOverrides(
        '{"misc/random-thoughts.md":{"disposition":"delete","target":null,"reason":"census"}}',
      )['misc/random-thoughts.md']?.target,
    ).toBeNull();
    const plan = await planDocsModernize({
      root: docsRoot,
      projectRoot,
      decide: { connection: null },
      overrides: {
        'misc/random-thoughts.md': { disposition: 'delete', reason: 'census: scratch notes' },
      },
    });
    const row = plan.rows.find((r) => r.path === 'misc/random-thoughts.md');
    expect(row).toMatchObject({ disposition: 'delete', target: null, overridden: true });

    const receipt = await applyDocsModernize({ plan, projectRoot, allowDirty: true });
    expect(existsSync(join(docsRoot, 'misc/random-thoughts.md'))).toBe(false);
    expect(receipt.deleted).toContain('misc/random-thoughts.md');
    const blob = receipt.blobs.find((b) => b.path === 'misc/random-thoughts.md');
    expect(blob?.sha256).toBe(sha(original.get('misc/random-thoughts.md') ?? ''));
    const ingest = receipt.ops.find(
      (o) => o.op === 'ingest' && o.path === 'misc/random-thoughts.md',
    );
    expect(ingest?.slug).toBeTruthy();
    const stored = await createAttachmentStore().findBySlug(ingest?.slug ?? '', projectRoot);
    expect(stored?.lifecycleStatus).not.toBe('superseded');
    expect(
      receipt.ops.some((o) => o.op === 'supersede' && o.path === 'misc/random-thoughts.md'),
    ).toBe(false);
    expect(receipt.ops.some((o) => o.op === 'supersede' && o.slug === ingest?.slug)).toBe(false);
  });

  it('a delete that names a survivor still supersedes into it, and a non-survivor target is refused (T14212)', async () => {
    await expect(
      planDocsModernize({
        root: docsRoot,
        projectRoot,
        decide: { connection: null },
        overrides: {
          'misc/random-thoughts.md': { disposition: 'delete', target: 'no-such-doc', reason: 'x' },
        },
      }),
    ).rejects.toMatchObject({ code: 'E_MODERNIZE_OVERRIDE' });
    const plan = await planDocsModernize({
      root: docsRoot,
      projectRoot,
      decide: { connection: null },
      overrides: {
        'misc/random-thoughts.md': {
          disposition: 'delete',
          target: 'gate-integrity-spec',
          reason: 'census: scratch notes',
        },
      },
    });
    const receipt = await applyDocsModernize({ plan, projectRoot, allowDirty: true });
    expect(existsSync(join(docsRoot, 'misc/random-thoughts.md'))).toBe(false);
    expect(
      receipt.ops.some((o) => o.op === 'supersede' && o.target === 'gate-integrity-spec'),
    ).toBe(true);
  });

  it('validates overrides: survivor targets, keep at its own path, schema', async () => {
    await expect(
      planDocsModernize({
        root: docsRoot,
        projectRoot,
        decide: { connection: null },
        overrides: {
          'misc/random-thoughts.md': {
            disposition: 'merge-into',
            target: 'no-such-doc',
            reason: 'x',
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'E_MODERNIZE_OVERRIDE' });
    const plan = await planDocsModernize({
      root: docsRoot,
      projectRoot,
      decide: { connection: null },
      overrides: {
        'plans/2026-04-21-self-healing-plan.md': {
          disposition: 'keep',
          reason: 'census: keep both',
        },
      },
    });
    expect(plan.rows.find((r) => r.path === 'plans/2026-04-21-self-healing-plan.md')).toMatchObject(
      {
        disposition: 'keep',
        target: 'plans/2026-04-21-self-healing-plan.md',
      },
    );
    expect(() =>
      parseModernizeOverrides('{"a.md":{"disposition":"explode","reason":"x"}}'),
    ).toThrow(/schema/);
  });

  it('refuses to update a stored doc whose bytes cannot be backed up', async () => {
    const store = createAttachmentStore();
    const storedBody =
      '# Gate integrity spec\n\n## Requirements\n- gates must hold\n- and stay held\n';
    const bytes = Buffer.from(storedBody, 'utf-8');
    const blob: Omit<BlobAttachment, 'sha256'> = {
      kind: 'blob',
      storageKey: '',
      mime: 'text/markdown',
      size: bytes.byteLength,
    };
    await store.put(bytes, blob, 'task', '__project__', 'test', projectRoot, {
      slug: 'gate-integrity-spec',
      type: 'spec',
    });
    const plan = await planDocsModernize({
      root: docsRoot,
      projectRoot,
      decide: { connection: null },
    });
    // Lose every copy of the stored doc's bytes after planning.
    for (const dir of ['attachments', 'blobs']) {
      rmSync(join(projectRoot, '.cleo', dir), { recursive: true, force: true });
    }
    await expect(applyDocsModernize({ plan, projectRoot, allowDirty: true })).rejects.toMatchObject(
      {
        code: 'E_MODERNIZE_BLOB',
      },
    );
    expect(await store.findBySlug('gate-integrity-spec', projectRoot)).not.toBeNull();
  });

  it('keeps same-named docs from different folders apart and leaves ambiguous [[links]] alone', async () => {
    const extra: Record<string, string> = {
      'pkg-a/api-design.md': '# API design\n\nshared line one\nshared line two\nalpha only\n',
      'pkg-b/api-design.md': '# API design\n\nshared line one\nshared line two\nbeta only\n',
      'pkg-a/readme.md': '# A readme\n',
      'pkg-b/readme.md': '# B readme\n\nsee [[readme]]\n',
    };
    for (const [rel, text] of Object.entries(extra)) {
      mkdirSync(dirname(join(docsRoot, rel)), { recursive: true });
      writeFileSync(join(docsRoot, rel), text);
    }
    const plan = await planDocsModernize({
      root: docsRoot,
      projectRoot,
      decide: { connection: null },
    });
    const rows = plan.rows.filter((r) => r.path.endsWith('api-design.md'));
    expect(rows.map((r) => r.disposition).every((d) => d === 'keep' || d === 'rename')).toBe(true);
    expect(new Set(rows.map((r) => r.slug)).size).toBe(2);
    await applyDocsModernize({ plan, projectRoot, allowDirty: true });
    const bReadme = plan.rows.find((r) => r.path === 'pkg-b/readme.md');
    const body = readFileSync(join(docsRoot, bReadme?.target ?? ''), 'utf-8');
    expect(body).toContain('[[readme]]');
  });
});

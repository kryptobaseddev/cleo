/**
 * A spawn prompt caps the inlined prose of a task's attached documents and
 * names every document it leaves out by exact ref with its fetch command
 * (T14190: VidaPeps saw a 107k-character prompt from linked review history).
 *
 * @task T14190
 */

import type { Task } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import {
  buildSpawnPrompt,
  DEFAULT_SPAWN_DOC_BUDGET_CHARS,
  type TaskDocAttachment,
} from '../spawn-prompt.js';

const TASK: Task = {
  id: 'T9100',
  title: 'Task with a long linked review history',
  description: 'Fixture for the spawn prompt document budget.',
  status: 'pending',
  priority: 'medium',
  type: 'task',
  size: 'small',
  acceptance: ['AC1: do the work'],
  createdAt: '2026-11-02T00:00:00Z',
};

/** A review-finding style note of `chars` characters. */
const review = (n: number, chars: number): TaskDocAttachment => ({
  name: `review-findings-${n}.md`,
  sha256: String(n).repeat(64).slice(0, 64),
  sizeBytes: chars,
  mimeType: 'text/markdown',
  textContent: `# Review ${n}\n${'finding text '.repeat(Math.ceil(chars / 13))}`.slice(0, chars),
});

describe('spawn prompt document budget (T14190)', () => {
  const docs = [1, 2, 3, 4, 5, 6, 7].map((n) => review(n, 15_000));

  it('large linked review prose stays under the budget, every dropped document named by ref', () => {
    const { prompt } = buildSpawnPrompt({
      task: TASK,
      protocol: 'implementation',
      projectRoot: '/tmp/spawn-doc-budget',
      tier: 0,
      docAttachments: docs,
    });
    const unbudgeted = docs.reduce((n, d) => n + (d.textContent?.length ?? 0), 0);
    expect(unbudgeted).toBeGreaterThan(100_000);
    // Only the documents that fit are inlined.
    const inlined = docs.filter(
      (d) => d.textContent !== undefined && prompt.includes(d.textContent),
    );
    expect(inlined.reduce((n, d) => n + (d.textContent?.length ?? 0), 0)).toBeLessThanOrEqual(
      DEFAULT_SPAWN_DOC_BUDGET_CHARS,
    );
    expect(prompt.length).toBeLessThan(unbudgeted);
    // Every left-out document is named with its exact sha and fetch command.
    const dropped = docs.filter((d) => !inlined.includes(d));
    expect(dropped.length).toBe(6);
    expect(prompt).toContain(
      `6 documents were left out to keep this prompt within ${DEFAULT_SPAWN_DOC_BUDGET_CHARS}`,
    );
    for (const d of dropped) {
      expect(prompt).toContain(
        `- ${d.name} — sha256 \`${d.sha256}\` — \`cleo docs fetch ${d.sha256.slice(0, 8)}\``,
      );
    }
  });

  it('a configured budget is honoured, and small attachments are all inlined', () => {
    const tight = buildSpawnPrompt({
      task: TASK,
      protocol: 'implementation',
      projectRoot: '/tmp/spawn-doc-budget',
      tier: 0,
      docAttachments: docs,
      docBudgetChars: 0,
    }).prompt;
    expect(tight).toContain('7 documents were left out to keep this prompt within 0 characters');
    const small = [review(8, 200), review(9, 300)];
    const roomy = buildSpawnPrompt({
      task: TASK,
      protocol: 'implementation',
      projectRoot: '/tmp/spawn-doc-budget',
      tier: 0,
      docAttachments: small,
    }).prompt;
    for (const d of small) expect(roomy).toContain(d.textContent ?? '');
    expect(roomy).not.toContain('left out to keep this prompt');
  });
});

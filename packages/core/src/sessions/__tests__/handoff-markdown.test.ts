/**
 * Tests for the derived markdown handoff renderer.
 *
 * @task T1593
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HandoffData } from '../handoff.js';
import { emitHandoffMarkdown, renderHandoffMarkdown } from '../handoff-markdown.js';

const sample: HandoffData = {
  lastTask: 'T100',
  tasksCompleted: ['T100', 'T101'],
  tasksCreated: ['T200'],
  decisionsRecorded: 3,
  nextSuggested: ['T300'],
  openBlockers: [],
  openBugs: ['T400'],
  note: 'Big day. Shipped foundation.',
  nextAction: 'Run cleo briefing in next session.',
};

let cleanup: string[] = [];

afterEach(async () => {
  for (const p of cleanup) {
    await fs.rm(p, { force: true }).catch(() => {});
  }
  cleanup = [];
});

describe('renderHandoffMarkdown — derived view (T1593)', () => {
  it('includes the canonical "NOT a source of truth" disclaimer', () => {
    const md = renderHandoffMarkdown(sample);
    expect(md).toContain('NOT a source of truth');
    expect(md).toContain('cleo briefing');
  });

  it('renders all handoff fields as labeled sections', () => {
    const md = renderHandoffMarkdown(sample, {
      sessionId: 'session-abc',
      scope: 'global',
    });
    expect(md).toContain('# Session Handoff (derived view)');
    expect(md).toContain('Last Task');
    expect(md).toContain('T100');
    expect(md).toContain('Tasks Completed (2)');
    expect(md).toContain('Tasks Created (1)');
    expect(md).toContain('Open Bugs (1)');
    expect(md).toContain('T400');
    expect(md).toContain('Big day. Shipped foundation.');
    expect(md).toContain('Run cleo briefing in next session.');
    expect(md).toContain('session-abc');
    expect(md).toContain('global');
  });

  it('handles empty handoff data with "(none)" placeholders', () => {
    const empty: HandoffData = {
      lastTask: null,
      tasksCompleted: [],
      tasksCreated: [],
      decisionsRecorded: 0,
      nextSuggested: [],
      openBlockers: [],
      openBugs: [],
    };
    const md = renderHandoffMarkdown(empty);
    expect(md).toContain('Last Task');
    expect(md).toMatch(/Tasks Completed \(0\)\s*\n\s*\n- \(none\)/);
  });
});

describe('emitHandoffMarkdown — atomic write (T1593)', () => {
  it('writes the markdown view to disk and creates parent dirs', async () => {
    const dir = join(tmpdir(), `cleo-t1593-${Date.now()}`);
    const out = join(dir, 'nested', 'HANDOFF-VIEW.md');
    cleanup.push(dir);

    await emitHandoffMarkdown(out, sample, { sessionId: 'session-xyz' });

    const written = await fs.readFile(out, 'utf8');
    expect(written).toContain('# Session Handoff (derived view)');
    expect(written).toContain('session-xyz');
    expect(written).toContain('NOT a source of truth');
  });
});

/**
 * Parse-time thin-agent enforcement tests (T931).
 *
 * Covers the CANT parser-side guard that strips `Agent` and `Task` tools from
 * worker-role tool allowlists. The complementary runtime-side guard
 * (`enforceThinAgent` in `@cleocode/core/orchestration`) has its own test
 * file under `packages/core/src/orchestration/__tests__/thin-agent.test.ts`.
 *
 * @task T931 Thin-agent runtime enforcer
 */

import { describe, expect, it } from 'vitest';
import {
  filterToolsForRole,
  stripSpawnToolsForWorker,
  THIN_AGENT_TOOLS_STRIPPED,
  WORKER_FORBIDDEN_SPAWN_TOOLS,
} from '../src/hierarchy.js';

describe('WORKER_FORBIDDEN_SPAWN_TOOLS', () => {
  it('exactly contains Agent and Task', () => {
    expect(WORKER_FORBIDDEN_SPAWN_TOOLS).toEqual(['Agent', 'Task']);
    expect(WORKER_FORBIDDEN_SPAWN_TOOLS).toHaveLength(2);
  });
});

describe('stripSpawnToolsForWorker', () => {
  it('strips Agent from worker tools and surfaces a warning', () => {
    const result = stripSpawnToolsForWorker(['Agent', 'Read']);
    expect(result.tools).toEqual(['Read']);
    expect(result.warning).not.toBeNull();
    expect(result.warning?.code).toBe(THIN_AGENT_TOOLS_STRIPPED);
    expect(result.warning?.removed).toEqual(['Agent']);
    expect(result.warning?.message).toContain('Agent');
  });

  it('strips Task from worker tools and surfaces a warning', () => {
    const result = stripSpawnToolsForWorker(['Task', 'Edit']);
    expect(result.tools).toEqual(['Edit']);
    expect(result.warning?.removed).toEqual(['Task']);
  });

  it('strips both Agent and Task, preserving other tools in order', () => {
    const result = stripSpawnToolsForWorker(['Read', 'Agent', 'Edit', 'Task', 'Grep']);
    expect(result.tools).toEqual(['Read', 'Edit', 'Grep']);
    expect(result.warning?.removed).toEqual(['Agent', 'Task']);
  });

  it('returns tools unchanged when no spawn-capable tools are present', () => {
    const result = stripSpawnToolsForWorker(['Read', 'Edit', 'Grep']);
    expect(result.tools).toEqual(['Read', 'Edit', 'Grep']);
    expect(result.warning).toBeNull();
  });

  it('returns an empty result for an empty input', () => {
    const result = stripSpawnToolsForWorker([]);
    expect(result.tools).toEqual([]);
    expect(result.warning).toBeNull();
  });

  it('reports the exact number of removed tools in the warning message', () => {
    const result = stripSpawnToolsForWorker(['Agent', 'Task']);
    expect(result.tools).toEqual([]);
    expect(result.warning?.removed).toEqual(['Agent', 'Task']);
    expect(result.warning?.message).toContain('2');
  });
});

describe('filterToolsForRole — thin-agent enforcement for worker role', () => {
  it('strips Agent and Task from worker role', () => {
    const filtered = filterToolsForRole(['Agent', 'Task', 'Read', 'Edit'], 'worker');
    expect(filtered).toEqual(['Read', 'Edit']);
    expect(filtered).not.toContain('Agent');
    expect(filtered).not.toContain('Task');
  });

  it('keeps Agent and Task on lead role (leads may spawn workers)', () => {
    const filtered = filterToolsForRole(['Agent', 'Task', 'Read'], 'lead');
    expect(filtered).toContain('Agent');
    expect(filtered).toContain('Task');
    // Edit/Write/Bash are still stripped per LEAD-001.
    expect(filtered).toContain('Read');
  });

  it('keeps Agent and Task on orchestrator role (orchestrators dispatch leads)', () => {
    const filtered = filterToolsForRole(['Agent', 'Task', 'Read', 'Edit'], 'orchestrator');
    expect(filtered).toContain('Agent');
    expect(filtered).toContain('Task');
    expect(filtered).not.toContain('Edit');
  });

  it('worker loses Agent/Task even when only Agent is requested', () => {
    const filtered = filterToolsForRole(['Agent'], 'worker');
    expect(filtered).toEqual([]);
  });

  it('worker retains all non-spawn tools unchanged', () => {
    const filtered = filterToolsForRole(['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'], 'worker');
    expect(filtered).toEqual(['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep']);
  });
});

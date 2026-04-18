/**
 * Runtime thin-agent enforcer tests (T931).
 *
 * Covers the dispatch-boundary guard `enforceThinAgent`. The complementary
 * parse-time guard (`stripSpawnToolsForWorker` in `@cleocode/cant/hierarchy`)
 * has its own test file under `packages/cant/tests/thin-agent.test.ts`. An
 * integration test that exercises {@link composeSpawnPayload} end-to-end
 * with a worker carrying `Agent` tools lives in `spawn.test.ts`.
 *
 * @task T931 Thin-agent runtime enforcer
 */

import { describe, expect, it } from 'vitest';
import { E_THIN_AGENT_VIOLATION, enforceThinAgent, THIN_AGENT_SPAWN_TOOLS } from '../thin-agent.js';

describe('THIN_AGENT_SPAWN_TOOLS', () => {
  it('exactly contains Agent and Task', () => {
    expect(THIN_AGENT_SPAWN_TOOLS).toEqual(['Agent', 'Task']);
  });
});

describe('enforceThinAgent — strict mode (default)', () => {
  it('rejects worker carrying Agent with E_THIN_AGENT_VIOLATION', () => {
    const result = enforceThinAgent('worker', ['Agent']);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.code).toBe(E_THIN_AGENT_VIOLATION);
    expect(result.role).toBe('worker');
    expect(result.violatingTools).toEqual(['Agent']);
    expect(result.message).toContain('E_THIN_AGENT_VIOLATION');
    expect(result.message).toContain('Agent');
  });

  it('rejects worker carrying Task with E_THIN_AGENT_VIOLATION', () => {
    const result = enforceThinAgent('worker', ['Task', 'Read']);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.violatingTools).toEqual(['Task']);
  });

  it('rejects worker carrying both Agent and Task', () => {
    const result = enforceThinAgent('worker', ['Agent', 'Task', 'Read']);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.violatingTools).toEqual(['Agent', 'Task']);
  });

  it('allows worker with only safe tools', () => {
    const result = enforceThinAgent('worker', ['Read', 'Edit']);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.tools).toEqual(['Read', 'Edit']);
    expect(result.stripped).toEqual([]);
    expect(result.bypassed).toBe(false);
  });

  it('allows worker with empty tool list', () => {
    const result = enforceThinAgent('worker', []);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.tools).toEqual([]);
  });

  it('allows worker with undefined tools (treated as empty)', () => {
    const result = enforceThinAgent('worker', undefined);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.tools).toEqual([]);
  });

  it('allows lead carrying Agent (leads may spawn workers)', () => {
    const result = enforceThinAgent('lead', ['Agent', 'Read']);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.tools).toEqual(['Agent', 'Read']);
    expect(result.stripped).toEqual([]);
  });

  it('allows lead carrying Task', () => {
    const result = enforceThinAgent('lead', ['Task']);
    expect(result.ok).toBe(true);
  });

  it('allows orchestrator carrying Agent and Task', () => {
    const result = enforceThinAgent('orchestrator', ['Agent', 'Task', 'Read']);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.tools).toEqual(['Agent', 'Task', 'Read']);
  });
});

describe('enforceThinAgent — strip mode', () => {
  it('removes Agent from worker tools and continues', () => {
    const result = enforceThinAgent('worker', ['Agent', 'Read', 'Edit'], 'strip');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.tools).toEqual(['Read', 'Edit']);
    expect(result.stripped).toEqual(['Agent']);
    expect(result.bypassed).toBe(false);
  });

  it('removes both Agent and Task in strip mode', () => {
    const result = enforceThinAgent('worker', ['Agent', 'Task', 'Read'], 'strip');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.tools).toEqual(['Read']);
    expect(result.stripped).toEqual(['Agent', 'Task']);
  });

  it('strip mode is a no-op for non-worker roles', () => {
    const result = enforceThinAgent('lead', ['Agent', 'Task'], 'strip');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.tools).toEqual(['Agent', 'Task']);
    expect(result.stripped).toEqual([]);
  });
});

describe('enforceThinAgent — off mode (escape hatch)', () => {
  it('bypasses the check for worker carrying Agent', () => {
    const result = enforceThinAgent('worker', ['Agent', 'Task'], 'off');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.tools).toEqual(['Agent', 'Task']);
    expect(result.bypassed).toBe(true);
    expect(result.stripped).toEqual([]);
  });

  it('off mode still works for non-worker roles', () => {
    const result = enforceThinAgent('orchestrator', ['Agent'], 'off');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.bypassed).toBe(true);
  });
});

describe('enforceThinAgent — input safety', () => {
  it('non-array tools value is coerced to empty', () => {
    // Simulate a misconfigured caller: cast through readonly to bypass TS
    // so we validate the runtime Array.isArray guard.
    const bogus = null as unknown as readonly string[];
    const result = enforceThinAgent('worker', bogus);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.tools).toEqual([]);
  });
});

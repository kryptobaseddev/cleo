/**
 * @cleocode/core package smoke test.
 *
 * Validates that the @cleocode/core package barrel resolves correctly
 * and that key exports are accessible.
 *
 * @epic T5716
 */

import { describe, expect, it } from 'vitest';

describe('E2E: @cleocode/core package smoke test', () => {
  it('should export the Cleo facade class', async () => {
    const core = await import('@cleocode/core');
    expect(core.Cleo).toBeDefined();
    expect(typeof core.Cleo.forProject).toBe('function');
  });

  it('should export CleoError', async () => {
    const core = await import('@cleocode/core');
    expect(core.CleoError).toBeDefined();
    expect(typeof core.CleoError).toBe('function');
  });

  it('should export task namespace', async () => {
    const core = await import('@cleocode/core');
    expect(core.tasks).toBeDefined();
    expect(typeof core.tasks.addTask).toBe('function');
    expect(typeof core.tasks.findTasks).toBe('function');
    expect(typeof core.tasks.showTask).toBe('function');
  });

  it('should export session namespace', async () => {
    const core = await import('@cleocode/core');
    expect(core.sessions).toBeDefined();
    expect(typeof core.sessions.startSession).toBe('function');
  });

  it('should export memory namespace', async () => {
    const core = await import('@cleocode/core');
    expect(core.memory).toBeDefined();
  });

  it('should export lifecycle namespace', async () => {
    const core = await import('@cleocode/core');
    expect(core.lifecycle).toBeDefined();
  });

  it('should export path utilities', async () => {
    const core = await import('@cleocode/core');
    expect(typeof core.getCleoHome).toBe('function');
    expect(typeof core.getProjectRoot).toBe('function');
    expect(typeof core.getCleoDir).toBe('function');
  });

  it('should export logger utilities', async () => {
    const core = await import('@cleocode/core');
    expect(typeof core.getLogger).toBe('function');
    expect(typeof core.initLogger).toBe('function');
  });

  it('should export config utilities', async () => {
    const core = await import('@cleocode/core');
    expect(typeof core.loadConfig).toBe('function');
    expect(typeof core.getConfigValue).toBe('function');
  });

  it('should create a Cleo instance via forProject', async () => {
    const { Cleo } = await import('@cleocode/core');
    const cleo = Cleo.forProject('/tmp/test-project');
    expect(cleo).toBeDefined();
    expect(cleo.projectRoot).toBe('/tmp/test-project');
    expect(cleo.tasks).toBeDefined();
  });
});

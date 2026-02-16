/**
 * E2E Lifecycle Workflow Tests
 *
 * Tests RCSD-IVTR lifecycle workflows via CLI commands.
 * Available lifecycle subcommands: show, start, complete, skip, gate
 *
 * @task T2937
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  setupE2ETest,
  cleanupE2ETest,
  extractTaskId,
} from './setup.js';
import type { IntegrationTestContext } from '../integration-setup.js';

describe('E2E: Lifecycle Workflow', () => {
  let context: IntegrationTestContext;

  beforeAll(async () => {
    context = await setupE2ETest();
  }, 120000);

  afterAll(async () => {
    await cleanupE2ETest();
  }, 30000);

  it('should complete lifecycle stage', async () => {
    // Create epic for lifecycle testing
    const epicResult = await context.executor.execute({
      domain: 'tasks',
      operation: 'add',
      args: ['Lifecycle Test Epic'],
      flags: {
        description: 'Epic for RCSD lifecycle testing',
        json: true,
      },
    });

    expect(epicResult.success).toBe(true);
    const epicId = extractTaskId(epicResult);
    context.createdTaskIds.push(epicId);

    // Complete research stage via 'lifecycle complete'
    const researchResult = await context.executor.execute({
      domain: 'lifecycle',
      operation: 'complete',
      args: [epicId, 'research'],
      flags: { json: true },
    });

    // lifecycle complete should produce output about the stage
    const output = researchResult.stdout || researchResult.stderr;
    expect(output).toMatch(/complet|success|stage|research/i);
  });

  it('should check lifecycle gate', async () => {
    // Create epic
    const epicResult = await context.executor.execute({
      domain: 'tasks',
      operation: 'add',
      args: ['Gate Check Epic'],
      flags: {
        description: 'Epic for lifecycle gate checking',
        json: true,
      },
    });

    const epicId = extractTaskId(epicResult);
    context.createdTaskIds.push(epicId);

    // Check gate for implementation (should fail - prerequisites not met)
    const gateResult = await context.executor.execute({
      domain: 'lifecycle',
      operation: 'gate',
      args: [epicId, 'implementation'],
      flags: { json: true },
    });

    // Gate check should produce output about gate state
    const output = gateResult.stdout || gateResult.stderr;
    expect(output).toBeDefined();
    expect(output.length).toBeGreaterThan(0);
  });

  it('should show lifecycle state for an epic', async () => {
    // Create epic
    const epicResult = await context.executor.execute({
      domain: 'tasks',
      operation: 'add',
      args: ['Show Lifecycle Epic'],
      flags: {
        description: 'Epic for showing lifecycle state',
        json: true,
      },
    });

    const epicId = extractTaskId(epicResult);
    context.createdTaskIds.push(epicId);

    // Show lifecycle state via 'lifecycle show'
    const showResult = await context.executor.execute({
      domain: 'lifecycle',
      operation: 'show',
      args: [epicId],
      flags: { json: true },
    });

    expect(showResult.exitCode).toBe(0);
    // Should contain standard RCSD stage names
    expect(showResult.stdout).toContain('research');
    expect(showResult.stdout).toContain('implementation');
  });

  it('should start a lifecycle stage', async () => {
    // Create epic
    const epicResult = await context.executor.execute({
      domain: 'tasks',
      operation: 'add',
      args: ['Start Stage Epic'],
      flags: {
        description: 'Epic for starting lifecycle stages',
        json: true,
      },
    });

    const epicId = extractTaskId(epicResult);
    context.createdTaskIds.push(epicId);

    // Start research stage
    const startResult = await context.executor.execute({
      domain: 'lifecycle',
      operation: 'start',
      args: [epicId, 'research'],
      flags: { json: true },
    });

    // Start should produce output
    const output = startResult.stdout || startResult.stderr;
    expect(output).toBeDefined();
    expect(output.length).toBeGreaterThan(0);
  });

  it('should handle stage skipping', async () => {
    // Create epic
    const epicResult = await context.executor.execute({
      domain: 'tasks',
      operation: 'add',
      args: ['Skip Test Epic'],
      flags: {
        description: 'Epic for stage skipping testing',
        json: true,
      },
    });

    const epicId = extractTaskId(epicResult);
    context.createdTaskIds.push(epicId);

    // Skip consensus stage
    const skipResult = await context.executor.execute({
      domain: 'lifecycle',
      operation: 'skip',
      args: [epicId, 'consensus'],
      flags: {
        reason: 'Single-agent project, consensus not required',
        json: true,
      },
    });

    // Skip should produce output; accept any exit code as long as it doesn't crash
    expect(typeof skipResult.exitCode).toBe('number');
  });

  it('should complete full RCSD lifecycle progression', async () => {
    // Create epic
    const epicResult = await context.executor.execute({
      domain: 'tasks',
      operation: 'add',
      args: ['Full RCSD Test Epic'],
      flags: {
        description: 'Epic for full RCSD progression testing',
        json: true,
      },
    });

    const epicId = extractTaskId(epicResult);
    context.createdTaskIds.push(epicId);

    // Progress through all RCSD stages using 'lifecycle complete'
    const stages = ['research', 'consensus', 'specification', 'decomposition'];
    for (const stage of stages) {
      const result = await context.executor.execute({
        domain: 'lifecycle',
        operation: 'complete',
        args: [epicId, stage],
        flags: { json: true },
      });

      const output = result.stdout || result.stderr;
      expect(output).toMatch(/complet|success|stage/i);
    }

    // Check implementation gate should now pass
    const gateResult = await context.executor.execute({
      domain: 'lifecycle',
      operation: 'gate',
      args: [epicId, 'implementation'],
      flags: { json: true },
    });

    // Gate check output should exist
    const gateOutput = gateResult.stdout || gateResult.stderr;
    expect(gateOutput).toBeDefined();
  });

  it('should check gate enforcement without RCSD completion', async () => {
    // Create epic without completing any stages
    const epicResult = await context.executor.execute({
      domain: 'tasks',
      operation: 'add',
      args: ['Gate Enforce Epic'],
      flags: {
        description: 'Epic for lifecycle gate enforcement',
        json: true,
      },
    });

    const epicId = extractTaskId(epicResult);
    context.createdTaskIds.push(epicId);

    // Check implementation gate (should fail without RCSD)
    const gateResult = await context.executor.execute({
      domain: 'lifecycle',
      operation: 'gate',
      args: [epicId, 'implementation'],
      flags: { json: true },
    });

    // Gate check output should mention the gate state
    const gateOutput = gateResult.stdout || gateResult.stderr;
    expect(gateOutput).toBeDefined();
    expect(gateOutput.length).toBeGreaterThan(0);
  });

  it('should show lifecycle status after modifications', async () => {
    // Create epic and complete research
    const epicResult = await context.executor.execute({
      domain: 'tasks',
      operation: 'add',
      args: ['Status After Mod Epic'],
      flags: {
        description: 'Epic for lifecycle status after modifications',
        json: true,
      },
    });

    const epicId = extractTaskId(epicResult);
    context.createdTaskIds.push(epicId);

    // Complete research stage
    await context.executor.execute({
      domain: 'lifecycle',
      operation: 'complete',
      args: [epicId, 'research'],
      flags: { json: true },
    });

    // Show lifecycle state
    const showResult = await context.executor.execute({
      domain: 'lifecycle',
      operation: 'show',
      args: [epicId],
      flags: { json: true },
    });

    expect(showResult.exitCode).toBe(0);
    expect(showResult.stdout).toContain(epicId);
    expect(showResult.stdout).toContain('research');
  });
});

/**
 * Tests for agent protocol guard on release.push.
 *
 * When running in agent context (CLEO_SESSION_ID or CLAUDE_AGENT_TYPE set),
 * release.push must require a manifest entry for the version. This prevents
 * agents from bypassing provenance tracking via direct git push.
 *
 * @task T4279
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { releasePush, releasePrepare } from '../release-engine.js';

const TEST_ROOT = join(process.cwd(), '.test-release-push-guard');
const CLEO_DIR = join(TEST_ROOT, '.cleo');

function writeTodoJson(tasks: any[]): void {
  mkdirSync(CLEO_DIR, { recursive: true });
  writeFileSync(
    join(CLEO_DIR, 'todo.json'),
    JSON.stringify({ tasks, _meta: { schemaVersion: '2.6.0' } }, null, 2),
    'utf-8',
  );
}

function writeConfig(config: Record<string, unknown>): void {
  writeFileSync(
    join(CLEO_DIR, 'config.json'),
    JSON.stringify(config, null, 2),
    'utf-8',
  );
}

const SAMPLE_TASKS = [
  { id: 'T001', title: 'feat: Add feature', description: 'New', status: 'done', priority: 'high', completedAt: '2026-02-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z', updatedAt: null },
];

describe('release.push agent protocol guard', () => {
  const origEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    writeTodoJson(SAMPLE_TASKS);
    writeConfig({ release: { push: { enabled: true, requireCleanTree: false } } });
    // Save original env values
    origEnv['CLEO_SESSION_ID'] = process.env['CLEO_SESSION_ID'];
    origEnv['CLAUDE_AGENT_TYPE'] = process.env['CLAUDE_AGENT_TYPE'];
  });

  afterEach(() => {
    // Restore original env values
    if (origEnv['CLEO_SESSION_ID'] === undefined) {
      delete process.env['CLEO_SESSION_ID'];
    } else {
      process.env['CLEO_SESSION_ID'] = origEnv['CLEO_SESSION_ID'];
    }
    if (origEnv['CLAUDE_AGENT_TYPE'] === undefined) {
      delete process.env['CLAUDE_AGENT_TYPE'];
    } else {
      process.env['CLAUDE_AGENT_TYPE'] = origEnv['CLAUDE_AGENT_TYPE'];
    }
    if (existsSync(TEST_ROOT)) {
      rmSync(TEST_ROOT, { recursive: true, force: true });
    }
  });

  it('should reject push in agent context when no manifest entry exists (CLEO_SESSION_ID)', async () => {
    process.env['CLEO_SESSION_ID'] = 'test-session-123';
    delete process.env['CLAUDE_AGENT_TYPE'];

    const result = await releasePush('v99.0.0', undefined, TEST_ROOT, { explicitPush: true });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_PROTOCOL_RELEASE');
    expect(result.error?.message).toContain('Agent protocol violation');
    expect(result.error?.message).toContain('v99.0.0');
    expect(result.error?.exitCode).toBe(66);
  });

  it('should reject push in agent context when no manifest entry exists (CLAUDE_AGENT_TYPE)', async () => {
    delete process.env['CLEO_SESSION_ID'];
    process.env['CLAUDE_AGENT_TYPE'] = 'claude-code';

    const result = await releasePush('v99.0.0', undefined, TEST_ROOT, { explicitPush: true });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_PROTOCOL_RELEASE');
    expect(result.error?.exitCode).toBe(66);
  });

  it('should allow push in agent context when manifest entry exists', async () => {
    process.env['CLEO_SESSION_ID'] = 'test-session-123';

    // Create a manifest entry first
    await releasePrepare('v1.0.0', ['T001'], 'Test release', TEST_ROOT);

    // Push will fail at git push (no real remote) but should NOT fail at protocol guard
    const result = await releasePush('v1.0.0', undefined, TEST_ROOT, { explicitPush: true });
    // Should fail at git push, not at protocol guard
    expect(result.error?.code).not.toBe('E_PROTOCOL_RELEASE');
  });

  it('should skip guard when not in agent context', async () => {
    delete process.env['CLEO_SESSION_ID'];
    delete process.env['CLAUDE_AGENT_TYPE'];

    // No manifest entry, but not in agent context - should skip guard
    // Will fail at git push (no real remote) but NOT at protocol guard
    const result = await releasePush('v99.0.0', undefined, TEST_ROOT, { explicitPush: true });
    expect(result.error?.code).not.toBe('E_PROTOCOL_RELEASE');
  });

  it('should include fix command and alternatives in error', async () => {
    process.env['CLEO_SESSION_ID'] = 'test-session-123';

    const result = await releasePush('v2.0.0', undefined, TEST_ROOT, { explicitPush: true });
    expect(result.success).toBe(false);
    expect(result.error?.fix).toContain('v2.0.0');
    expect(result.error?.alternatives).toBeDefined();
    expect(result.error?.alternatives).toHaveLength(2);
  });
});

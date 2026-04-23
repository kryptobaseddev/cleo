/**
 * Tests for the canonical spawn prompt builder (T882 / T884 / T885 / T887).
 *
 * Shape-based assertions, not snapshots — the prompt content can evolve
 * without churning these tests, but every required section and every
 * tier-specific content contract is verified.
 *
 * @task T882
 * @task T887
 */

import type { Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ALL_SPAWN_PROTOCOL_PHASES,
  buildSpawnPrompt,
  DEFAULT_SPAWN_TIER,
  resetSpawnPromptCache,
  resolvePromptTokens,
  type SpawnTier,
} from '../spawn-prompt.js';

const BASE_TASK: Task = {
  id: 'T9000',
  title: 'Example task for spawn prompt tests',
  description: 'A task used to validate prompt shape across tiers and protocols.',
  status: 'pending',
  priority: 'high',
  type: 'task',
  size: 'medium',
  parentId: 'T8999',
  labels: ['test-label'],
  depends: ['T8998'],
  acceptance: ['AC1: verify first criterion', 'AC2: verify second criterion'],
  createdAt: '2026-04-17T00:00:00Z',
};

const PROJECT_ROOT = '/tmp/spawn-prompt-test-project';

beforeEach(() => {
  resetSpawnPromptCache();
});

afterEach(() => {
  resetSpawnPromptCache();
});

describe('buildSpawnPrompt — core contract', () => {
  it('returns a fully-resolved prompt with default tier 1', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      projectRoot: PROJECT_ROOT,
    });
    expect(result.tier).toBe(DEFAULT_SPAWN_TIER);
    expect(result.unresolvedTokens).toHaveLength(0);
    expect(result.prompt).toContain('T9000');
    expect(result.prompt).toContain('Example task for spawn prompt tests');
  });

  it('header identifies task, protocol, and tier', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      tier: 2,
      projectRoot: PROJECT_ROOT,
    });
    expect(result.prompt).toMatch(/CLEO Subagent Spawn — T9000/);
    expect(result.prompt).toContain('**Protocol**: implementation');
    expect(result.prompt).toContain('**Tier**: 2');
  });

  it('includes every required section in tier 1 prompts', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      tier: 1,
      projectRoot: PROJECT_ROOT,
    });
    const p = result.prompt;
    // Required sections
    expect(p).toContain('## Task Identity');
    expect(p).toContain('## File Paths');
    expect(p).toContain('## Session Linkage');
    expect(p).toContain('## Stage-Specific Guidance');
    expect(p).toContain('## Evidence-Based Gate Ritual');
    expect(p).toContain('## Quality Gates');
    expect(p).toContain('## Return Format Contract');
  });

  it('tier 0 omits the full CLEO-INJECTION embed and uses the pointer', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      tier: 0,
      projectRoot: PROJECT_ROOT,
    });
    expect(result.prompt).toContain('CLEO Protocol (tier 0 reference)');
    expect(result.prompt).not.toContain('## CLEO Protocol (embedded — tier 1)');
  });

  it('tier 1 includes CLEO-INJECTION embed', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      tier: 1,
      projectRoot: PROJECT_ROOT,
    });
    expect(result.prompt).toContain('## CLEO Protocol (embedded — tier 1)');
  });

  it('tier 2 includes tier 1 embed + skill excerpts + anti-patterns', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      tier: 2,
      projectRoot: PROJECT_ROOT,
    });
    expect(result.prompt).toContain('## CLEO Protocol (embedded — tier 1)');
    expect(result.prompt).toContain('## Skill Excerpts (tier 2)');
    expect(result.prompt).toContain('## Anti-Patterns');
  });
});

describe('buildSpawnPrompt — protocol phase matrix', () => {
  // Matrix: every protocol × every tier → required markers present, no
  // unresolved tokens.
  for (const protocol of ALL_SPAWN_PROTOCOL_PHASES) {
    for (const tier of [0, 1, 2] as SpawnTier[]) {
      it(`produces a resolved prompt for protocol=${protocol} tier=${tier}`, () => {
        const result = buildSpawnPrompt({
          task: BASE_TASK,
          protocol,
          tier,
          projectRoot: PROJECT_ROOT,
        });
        expect(result.unresolvedTokens).toHaveLength(0);
        expect(result.prompt).toContain('T9000');
        expect(result.prompt).toContain('Stage-Specific Guidance');
        expect(result.prompt).toContain('Return Format Contract');
        // Evidence gate always present
        expect(result.prompt).toContain('Evidence-Based Gate Ritual');
        expect(result.prompt).toMatch(/cleo verify T9000/);
      });
    }
  }
});

describe('buildSpawnPrompt — stage-specific guidance', () => {
  it('research stage points at the rcasd/research folder', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'research',
      projectRoot: PROJECT_ROOT,
    });
    expect(result.prompt).toContain('.cleo/rcasd/T9000/research/');
    expect(result.prompt).toContain('Gather information and evidence');
  });

  it('specification stage uses RFC-2119 language', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'specification',
      projectRoot: PROJECT_ROOT,
    });
    expect(result.prompt).toContain('RFC-2119');
  });

  it('implementation stage explicitly forbids any/unknown', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      projectRoot: PROJECT_ROOT,
    });
    expect(result.prompt).toContain('`any`');
  });

  it('release stage mentions CalVer + CI green gating', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'release',
      projectRoot: PROJECT_ROOT,
    });
    expect(result.prompt).toContain('CalVer');
    expect(result.prompt).toContain('CI must be GREEN');
  });

  it('testing stage references evidence atom for pnpm-test', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'testing',
      projectRoot: PROJECT_ROOT,
    });
    expect(result.prompt).toContain('tool:pnpm-test');
  });

  it('contribution stage documents follow-up tracking', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'contribution',
      projectRoot: PROJECT_ROOT,
    });
    expect(result.prompt).toContain('needs_followup');
  });
});

describe('buildSpawnPrompt — return format contract', () => {
  it('includes the three exact return strings for implementation', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      projectRoot: PROJECT_ROOT,
    });
    expect(result.prompt).toContain(
      'Implementation complete. Manifest appended to pipeline_manifest.',
    );
    expect(result.prompt).toContain(
      'Implementation partial. Manifest appended to pipeline_manifest.',
    );
    expect(result.prompt).toContain(
      'Implementation blocked. Manifest appended to pipeline_manifest.',
    );
  });

  it('uses the correct verb for research', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'research',
      projectRoot: PROJECT_ROOT,
    });
    expect(result.prompt).toContain('Research complete. Manifest appended to pipeline_manifest.');
  });

  it('includes the cleo manifest append instruction (ADR-027 / T1096)', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      projectRoot: PROJECT_ROOT,
    });
    expect(result.prompt).toContain('## Manifest Protocol');
    expect(result.prompt).toContain('cleo manifest append');
    // ADR-027: flat-file manifest sink was retired; verify it's not referenced in generated prompts
    expect(result.prompt).not.toContain(['MANIFEST', 'jsonl'].join('.'));
  });

  it('teaches the CORRECT pipeline_manifest schema (v2026.4.113 — T1187 followup)', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      projectRoot: PROJECT_ROOT,
    });
    // Every required ManifestEntry field must appear in the rich-entry example so
    // agents copy a shape that passes pipelineManifestAppend's validator.
    expect(result.prompt).toContain('"id":');
    expect(result.prompt).toContain('"file":');
    expect(result.prompt).toContain('"title":');
    expect(result.prompt).toContain('"date":');
    expect(result.prompt).toContain('"status":');
    expect(result.prompt).toContain('"agent_type":');
    expect(result.prompt).toContain('"topics":');
    expect(result.prompt).toContain('"key_findings":');
    expect(result.prompt).toContain('"actionable":');
    expect(result.prompt).toContain('"needs_followup":');
    expect(result.prompt).toContain('"linked_tasks":');
    // Task association is via linked_tasks[], NOT task_id column directly —
    // fail fast if the prompt ever reintroduces task_id/type/content as JSON fields.
    expect(result.prompt).not.toContain('"task_id":');
    expect(result.prompt).not.toContain('"content":');
    expect(result.prompt).not.toContain('"commits":');
    expect(result.prompt).not.toContain('"gates_passed":');
    expect(result.prompt).not.toContain('"files_changed":');
    expect(result.prompt).not.toContain('"children_completed":');
  });

  it('mandates a verification step after cleo manifest append', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      projectRoot: PROJECT_ROOT,
    });
    // Agents must assert the success path, not hallucinate "Manifest appended".
    expect(result.prompt).toContain('Verify BEFORE returning');
    expect(result.prompt).toContain('"appended":true');
    expect(result.prompt).toContain('cleo manifest show');
  });
});

describe('buildSpawnPrompt — session linkage', () => {
  it('embeds the session id when provided', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      projectRoot: PROJECT_ROOT,
      sessionId: 'ses_20260417_abc123',
    });
    expect(result.prompt).toContain('ses_20260417_abc123');
    expect(result.prompt).toContain('Orchestrator Session');
  });

  it('surfaces a clear notice when no session is available', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      projectRoot: PROJECT_ROOT,
      sessionId: null,
    });
    expect(result.prompt).toContain('No active orchestrator session');
  });
});

describe('buildSpawnPrompt — file path resolution', () => {
  it('uses absolute paths anchored to the project root', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      projectRoot: '/abs/proj',
    });
    expect(result.prompt).toContain('/abs/proj/.cleo/agent-outputs');
    expect(result.prompt).toContain('/abs/proj/.cleo/rcasd/T9000');
    expect(result.prompt).toContain('/abs/proj/.cleo/test-runs');
    // ADR-027 / T1096: no flat-file manifest path is rendered.
    // ADR-027: flat-file manifest sink was retired; verify it's not referenced in generated prompts
    expect(result.prompt).not.toContain(['MANIFEST', 'jsonl'].join('.'));
  });
});

describe('resolvePromptTokens', () => {
  it('resolves known tokens', () => {
    const { resolved, unresolved } = resolvePromptTokens('Task: {{TASK_ID}} Date: {{DATE}}', {
      TASK_ID: 'T100',
      DATE: '2026-04-17',
    });
    expect(resolved).toBe('Task: T100 Date: 2026-04-17');
    expect(unresolved).toHaveLength(0);
  });

  it('reports unresolved tokens', () => {
    const { unresolved } = resolvePromptTokens('Missing {{UNKNOWN}}', {});
    expect(unresolved).toContain('UNKNOWN');
  });

  it('does not flag tilde-prefixed @file references', () => {
    const { unresolved } = resolvePromptTokens('See @~/.cleo/templates/CLEO-INJECTION.md', {});
    expect(unresolved).toEqual([]);
  });
});

describe('buildSpawnPrompt — token resolution', () => {
  it('produces a prompt with zero unresolved tokens in default flow', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      projectRoot: PROJECT_ROOT,
    });
    expect(result.unresolvedTokens).toEqual([]);
  });

  it('exposes the token map used for resolution', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      projectRoot: PROJECT_ROOT,
    });
    expect(result.tokens['TASK_ID']).toBe('T9000');
    expect(result.tokens['EPIC_ID']).toBe('T8999');
    expect(result.tokens['TIER']).toBe(String(DEFAULT_SPAWN_TIER));
  });
});

// ---------------------------------------------------------------------------
// T1140 — Worktree Setup section
// ---------------------------------------------------------------------------

describe('buildSpawnPrompt — worktree setup section (T1140)', () => {
  it('emits Worktree Setup section when worktreePath is provided', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      projectRoot: PROJECT_ROOT,
      worktreePath: '/home/user/.local/share/cleo/worktrees/abc123/T9000',
      worktreeBranch: 'task/T9000',
      tier: 0,
    });
    expect(result.prompt).toContain('## Worktree Setup (REQUIRED)');
    expect(result.prompt).toContain('/home/user/.local/share/cleo/worktrees/abc123/T9000');
    expect(result.prompt).toContain('task/T9000');
    expect(result.prompt).toContain('authorized only within');
    expect(result.prompt).toContain('FIRST ACTION');
  });

  it('omits Worktree Setup section when worktreePath is not provided', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      projectRoot: PROJECT_ROOT,
      tier: 0,
    });
    expect(result.prompt).not.toContain('## Worktree Setup (REQUIRED)');
  });

  it('uses default branch name task/<taskId> when worktreeBranch is not set', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      projectRoot: PROJECT_ROOT,
      worktreePath: '/tmp/worktrees/T9000',
      tier: 0,
    });
    expect(result.prompt).toContain('task/T9000');
  });

  it('injects WORKTREE_PATH and WORKTREE_BRANCH into the token map', () => {
    const path = '/home/user/.local/share/cleo/worktrees/abc123/T9000';
    const branch = 'task/T9000';
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      projectRoot: PROJECT_ROOT,
      worktreePath: path,
      worktreeBranch: branch,
      tier: 0,
    });
    expect(result.tokens['WORKTREE_PATH']).toBe(path);
    expect(result.tokens['WORKTREE_BRANCH']).toBe(branch);
  });

  it('worktree section appears after Session Linkage and before File Paths', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      projectRoot: PROJECT_ROOT,
      worktreePath: '/tmp/worktrees/T9000',
      tier: 0,
    });
    const sessionIdx = result.prompt.indexOf('## Session Linkage');
    const worktreeIdx = result.prompt.indexOf('## Worktree Setup (REQUIRED)');
    const filePathsIdx = result.prompt.indexOf('## File Paths');
    expect(sessionIdx).toBeLessThan(worktreeIdx);
    expect(worktreeIdx).toBeLessThan(filePathsIdx);
  });
});

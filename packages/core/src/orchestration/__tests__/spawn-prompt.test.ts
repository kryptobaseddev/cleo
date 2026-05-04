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
import { ISOLATION_ENV_KEYS, provisionIsolatedShell } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ALL_SPAWN_PROTOCOL_PHASES,
  buildSpawnPrompt,
  DEFAULT_SPAWN_TIER,
  INLINE_TEXT_SIZE_LIMIT_BYTES,
  resetSpawnPromptCache,
  resolvePromptTokens,
  type SpawnTier,
  type TaskDocAttachment,
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
    expect(result.prompt).toContain('Authorized only within');
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

// ---------------------------------------------------------------------------
// T1758 — Hardened worktree setup: cwd-reset warning + provisionIsolatedShell preamble
// ---------------------------------------------------------------------------

describe('buildSpawnPrompt — worktree setup hardening (T1758)', () => {
  const WORKTREE = '/home/user/.local/share/cleo/worktrees/abc123/T9000';
  const BRANCH = 'task/T9000';

  it('warns that cwd does not persist between Bash calls', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      projectRoot: PROJECT_ROOT,
      worktreePath: WORKTREE,
      worktreeBranch: BRANCH,
      tier: 0,
    });
    expect(result.prompt).toContain('cwd does NOT persist between Bash calls');
    expect(result.prompt).toContain('new shell');
  });

  it('embeds the cd-guard snippet with worktree path', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      projectRoot: PROJECT_ROOT,
      worktreePath: WORKTREE,
      worktreeBranch: BRANCH,
      tier: 0,
    });
    // The ready-to-use snippet must contain the cd-guard pattern
    expect(result.prompt).toContain(`WORKTREE=${WORKTREE}`);
    expect(result.prompt).toContain(`cd "$WORKTREE" || exit 1`);
    expect(result.prompt).toContain(`pwd | grep -q "$WORKTREE" || exit 1`);
  });

  it('embeds provisionIsolatedShell preamble with export block (single source of truth)', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      projectRoot: PROJECT_ROOT,
      worktreePath: WORKTREE,
      worktreeBranch: BRANCH,
      tier: 0,
    });
    // The preamble from provisionIsolatedShell exports isolation env keys
    expect(result.prompt).toContain('export CLEO_WORKTREE_ROOT=');
    expect(result.prompt).toContain('export CLEO_AGENT_ROLE=');
    expect(result.prompt).toContain('export CLEO_WORKTREE_BRANCH=');
    expect(result.prompt).toContain('export CLEO_PROJECT_HASH=');
  });

  it('lists ISOLATION_ENV_KEYS in the prompt — drift detection', () => {
    // This test will fail if ISOLATION_ENV_KEYS shape changes without prompt update.
    // The prompt must mention each canonical env key from the utility.
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      projectRoot: PROJECT_ROOT,
      worktreePath: WORKTREE,
      worktreeBranch: BRANCH,
      tier: 0,
    });
    const expectedKeys = [
      'CLEO_WORKTREE_ROOT',
      'CLEO_AGENT_ROLE',
      'CLEO_WORKTREE_BRANCH',
      'CLEO_PROJECT_HASH',
    ];
    for (const key of expectedKeys) {
      expect(result.prompt, `prompt must reference env key ${key}`).toContain(key);
    }
  });

  it('includes CRITICAL WORKTREE ISOLATION section header', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      projectRoot: PROJECT_ROOT,
      worktreePath: WORKTREE,
      worktreeBranch: BRANCH,
      tier: 0,
    });
    expect(result.prompt).toContain('CRITICAL — WORKTREE ISOLATION');
  });
});

// ---------------------------------------------------------------------------
// T1760 — Export block verbatim snapshot + ISOLATION_ENV_KEYS drift detection
// ---------------------------------------------------------------------------

describe('buildSpawnPrompt — export block snapshot and drift detection (T1760)', () => {
  const WORKTREE = '/home/user/.local/share/cleo/worktrees/abc123/T9000';
  const BRANCH = 'task/T9000';
  const PROJECT_HASH = 'abc123'; // second-to-last segment of the worktree path

  it('export block in rendered prompt matches provisionIsolatedShell preamble verbatim', () => {
    // Compute the expected export block directly from the utility (single source of truth).
    const isolation = provisionIsolatedShell({
      worktreePath: WORKTREE,
      branch: BRANCH,
      role: 'worker',
      projectHash: PROJECT_HASH,
    });

    // Extract the export lines from the preamble (the canonical output).
    const expectedExportLines = ISOLATION_ENV_KEYS.map((k) => `export ${k}="${isolation.env[k]}"`);

    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      projectRoot: PROJECT_ROOT,
      worktreePath: WORKTREE,
      worktreeBranch: BRANCH,
      tier: 0,
    });

    // Every export line from the utility MUST appear verbatim in the rendered prompt.
    for (const line of expectedExportLines) {
      expect(result.prompt, `rendered prompt must contain verbatim export line: ${line}`).toContain(
        line,
      );
    }
  });

  it('ISOLATION_ENV_KEYS drift: prompt references every key in the canonical list', () => {
    // This test imports ISOLATION_ENV_KEYS dynamically from @cleocode/contracts.
    // If a new key is added to the canonical list without updating the spawn-prompt
    // render path, this assertion will fail — ensuring no silent drift.
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      projectRoot: PROJECT_ROOT,
      worktreePath: WORKTREE,
      worktreeBranch: BRANCH,
      tier: 0,
    });

    for (const key of ISOLATION_ENV_KEYS) {
      expect(result.prompt, `prompt must reference canonical env key ${key}`).toContain(key);
    }
  });
});

// ---------------------------------------------------------------------------
// T1614 — Task Documents section (spawn auto-attaches docs)
// ---------------------------------------------------------------------------

describe('buildSpawnPrompt — task documents section (T1614)', () => {
  const TEXT_ATTACHMENT: TaskDocAttachment = {
    name: 'spec.md',
    sha256: 'a'.repeat(64),
    sizeBytes: 200,
    mimeType: 'text/markdown',
    textContent: '# Spec\n\nThis is the spec content.',
  };

  const BINARY_ATTACHMENT: TaskDocAttachment = {
    name: 'diagram.png',
    sha256: 'b'.repeat(64),
    sizeBytes: 4096,
    mimeType: 'image/png',
    // no textContent — binary blob
  };

  const LARGE_TEXT_ATTACHMENT: TaskDocAttachment = {
    name: 'big-notes.txt',
    sha256: 'c'.repeat(64),
    sizeBytes: INLINE_TEXT_SIZE_LIMIT_BYTES + 1,
    mimeType: 'text/plain',
    // no textContent — oversized, not inlined by composeSpawnPayload
  };

  it('omits ## Task Documents section when docAttachments is undefined', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      projectRoot: PROJECT_ROOT,
    });
    expect(result.prompt).not.toContain('## Task Documents');
  });

  it('omits ## Task Documents section when docAttachments is empty', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      projectRoot: PROJECT_ROOT,
      docAttachments: [],
    });
    expect(result.prompt).not.toContain('## Task Documents');
  });

  it('emits ## Task Documents section when attachments are provided', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      projectRoot: PROJECT_ROOT,
      docAttachments: [TEXT_ATTACHMENT],
    });
    expect(result.prompt).toContain('## Task Documents');
  });

  it('inlines text attachment content between fenced code blocks', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      projectRoot: PROJECT_ROOT,
      docAttachments: [TEXT_ATTACHMENT],
    });
    expect(result.prompt).toContain('spec.md');
    expect(result.prompt).toContain('# Spec');
    expect(result.prompt).toContain('This is the spec content.');
  });

  it('renders binary attachment with sha256 and cleo docs fetch pointer (no inline content)', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      projectRoot: PROJECT_ROOT,
      docAttachments: [BINARY_ATTACHMENT],
    });
    expect(result.prompt).toContain('diagram.png');
    expect(result.prompt).toContain('SHA-256');
    // Should contain the first 8 chars of sha256 in the fetch command
    expect(result.prompt).toContain(`cleo docs fetch ${BINARY_ATTACHMENT.sha256.slice(0, 8)}`);
    // Must NOT inline binary content (there is none)
    expect(result.prompt).not.toContain('data:image');
  });

  it('renders oversized text attachment as list-only (no inline content)', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      projectRoot: PROJECT_ROOT,
      docAttachments: [LARGE_TEXT_ATTACHMENT],
    });
    expect(result.prompt).toContain('big-notes.txt');
    expect(result.prompt).toContain(`cleo docs fetch ${LARGE_TEXT_ATTACHMENT.sha256.slice(0, 8)}`);
  });

  it('renders mixed attachments: inlined text + binary listing', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      projectRoot: PROJECT_ROOT,
      docAttachments: [TEXT_ATTACHMENT, BINARY_ATTACHMENT],
    });
    // Both should appear
    expect(result.prompt).toContain('spec.md');
    expect(result.prompt).toContain('diagram.png');
    // Text content inlined
    expect(result.prompt).toContain('# Spec');
    // Binary fetch pointer
    expect(result.prompt).toContain(`cleo docs fetch ${BINARY_ATTACHMENT.sha256.slice(0, 8)}`);
  });

  it('shows attachment count in the section header', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      projectRoot: PROJECT_ROOT,
      docAttachments: [TEXT_ATTACHMENT, BINARY_ATTACHMENT],
    });
    expect(result.prompt).toContain('2 attachments');
  });

  it('shows singular "attachment" for a single doc', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      projectRoot: PROJECT_ROOT,
      docAttachments: [TEXT_ATTACHMENT],
    });
    expect(result.prompt).toContain('1 attachment');
    expect(result.prompt).not.toContain('1 attachments');
  });

  it('docs section appears after File Paths and before Stage Guidance', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      projectRoot: PROJECT_ROOT,
      docAttachments: [TEXT_ATTACHMENT],
    });
    const filePathsIdx = result.prompt.indexOf('## File Paths');
    const docsIdx = result.prompt.indexOf('## Task Documents');
    const stageIdx = result.prompt.indexOf('## Stage-Specific Guidance');
    expect(filePathsIdx).toBeGreaterThan(-1);
    expect(docsIdx).toBeGreaterThan(-1);
    expect(stageIdx).toBeGreaterThan(-1);
    expect(filePathsIdx).toBeLessThan(docsIdx);
    expect(docsIdx).toBeLessThan(stageIdx);
  });

  it('includes cleo docs list CLI command in the header', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      projectRoot: PROJECT_ROOT,
      docAttachments: [TEXT_ATTACHMENT],
    });
    expect(result.prompt).toContain(`cleo docs list --task ${BASE_TASK.id}`);
  });

  it('INLINE_TEXT_SIZE_LIMIT_BYTES is exported and equals 32 KB', () => {
    expect(INLINE_TEXT_SIZE_LIMIT_BYTES).toBe(32 * 1024);
  });

  it('produces zero unresolved tokens when docAttachments provided', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      projectRoot: PROJECT_ROOT,
      docAttachments: [TEXT_ATTACHMENT, BINARY_ATTACHMENT],
    });
    expect(result.unresolvedTokens).toHaveLength(0);
  });
});

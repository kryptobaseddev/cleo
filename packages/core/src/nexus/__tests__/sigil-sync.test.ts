/**
 * Unit tests for the canonical sigil sync (T1386).
 *
 * Each test gets its own fresh nexus.db via CLEO_HOME redirection +
 * resetNexusDbState().  No real user data is touched.  Tests rely on the
 * bundled `@cleocode/agents` package being resolvable from the workspace
 * (the same code path that powers `cleo init --install-seed-agents`).
 *
 * @task T1386
 * @epic T1148
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getNexusDb, resetNexusDbState } from '../../store/nexus-sqlite.js';
import { nexusInit } from '../registry.js';
import { listSigils } from '../sigil.js';
import {
  parseSigilFromCant,
  resolveCanonicalCantFiles,
  syncCanonicalSigils,
} from '../sigil-sync.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'nexus-sigil-sync-test-'));
  await mkdir(join(testDir, '.cleo'), { recursive: true });

  // Point CLEO_HOME to isolated temp directory so nexus.db is isolated.
  process.env['CLEO_HOME'] = testDir;

  // Reset the nexus DB singleton so each test gets a fresh database.
  resetNexusDbState();

  // Initialise the nexus registry (creates nexus.db + applies migrations).
  await nexusInit();
});

afterEach(async () => {
  delete process.env['CLEO_HOME'];
  resetNexusDbState();
  await rm(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// resolveCanonicalCantFiles
// ---------------------------------------------------------------------------

describe('resolveCanonicalCantFiles', () => {
  it('locates the bundled @cleocode/agents canonical .cant files', async () => {
    const resolved = await resolveCanonicalCantFiles();

    expect(resolved.seedAgentsDir).not.toBeNull();
    expect(resolved.cleoSubagentFile).not.toBeNull();
    expect(resolved.metaDir).not.toBeNull();

    // 1 cleo-subagent + 5 seeds + 2 meta = 8 canonical files.
    expect(resolved.files.length).toBe(8);
  });

  it('includes every canonical peer (cleo-subagent + 5 seeds + 2 meta)', async () => {
    const resolved = await resolveCanonicalCantFiles();

    const filenames = resolved.files.map((p) => p.split('/').pop());
    expect(filenames).toContain('cleo-subagent.cant');
    expect(filenames).toContain('orchestrator.cant');
    expect(filenames).toContain('dev-lead.cant');
    expect(filenames).toContain('code-worker.cant');
    expect(filenames).toContain('docs-worker.cant');
    expect(filenames).toContain('security-worker.cant');
    expect(filenames).toContain('agent-architect.cant');
    expect(filenames).toContain('playbook-architect.cant');
  });
});

// ---------------------------------------------------------------------------
// parseSigilFromCant
// ---------------------------------------------------------------------------

describe('parseSigilFromCant', () => {
  it('extracts peerId, role, and description from cleo-subagent.cant', async () => {
    const resolved = await resolveCanonicalCantFiles();
    expect(resolved.cleoSubagentFile).not.toBeNull();

    const parsed = parseSigilFromCant(resolved.cleoSubagentFile as string);
    expect(parsed).not.toBeNull();
    expect(parsed?.peerId).toBe('cleo-subagent');
    expect(parsed?.role).toBe('subagent');
    expect(parsed?.parent).toBe('orchestrator');
    expect(parsed?.tier).toBe('0');
    expect(parsed?.systemPromptFragment).toBeTruthy();
    expect(parsed?.systemPromptFragment).toContain('CLEO subagent');
  });

  it('extracts the orchestrator from seed-agents/orchestrator.cant', async () => {
    const resolved = await resolveCanonicalCantFiles();
    const orchestratorFile = resolved.files.find((f) => f.endsWith('orchestrator.cant'));
    expect(orchestratorFile).toBeDefined();

    const parsed = parseSigilFromCant(orchestratorFile as string);
    expect(parsed?.peerId).toBe('project-orchestrator');
    expect(parsed?.role).toBe('orchestrator');
    expect(parsed?.tier).toBe('high');
  });

  it('falls back to description when no prompt block is present', async () => {
    const resolved = await resolveCanonicalCantFiles();
    const codeWorkerFile = resolved.files.find((f) => f.endsWith('code-worker.cant'));
    expect(codeWorkerFile).toBeDefined();

    const parsed = parseSigilFromCant(codeWorkerFile as string);
    expect(parsed?.peerId).toBe('project-code-worker');
    expect(parsed?.role).toBe('worker');
    expect(parsed?.systemPromptFragment).toBeTruthy();
    // Description-derived fallback for templates without explicit `prompt:`.
    expect(parsed?.systemPromptFragment).toBe(parsed?.description);
  });

  it('parses the multi-line prompt: | pipe block on agent-architect', async () => {
    const resolved = await resolveCanonicalCantFiles();
    const agentArchitectFile = resolved.files.find((f) => f.endsWith('agent-architect.cant'));
    expect(agentArchitectFile).toBeDefined();

    const parsed = parseSigilFromCant(agentArchitectFile as string);
    expect(parsed?.peerId).toBe('agent-architect');
    expect(parsed?.role).toBe('specialist');
    expect(parsed?.model).toBe('opus');
    expect(parsed?.systemPromptFragment).toBeTruthy();
    expect(parsed?.systemPromptFragment).toContain('agent-architect');
    // Multi-line content carries newlines from the pipe block.
    expect(parsed?.systemPromptFragment?.includes('\n')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// syncCanonicalSigils — end-to-end
// ---------------------------------------------------------------------------

describe('syncCanonicalSigils', () => {
  it('upserts a sigil for every canonical CANT agent (8 total)', async () => {
    const result = await syncCanonicalSigils();

    expect(result.count).toBe(8);
    expect(result.warnings).toEqual([]);
    expect(result.peerIds).toEqual([
      'agent-architect',
      'cleo-subagent',
      'playbook-architect',
      'project-code-worker',
      'project-dev-lead',
      'project-docs-worker',
      'project-orchestrator',
      'project-security-worker',
    ]);
  });

  it('persists every sigil in the nexus.db sigils table', async () => {
    await syncCanonicalSigils();

    const db = await getNexusDb();
    const sigils = await listSigils(db);

    expect(sigils.length).toBe(8);

    // Every sigil carries a non-empty role + systemPromptFragment + cantFile.
    for (const sigil of sigils) {
      expect(sigil.role.length).toBeGreaterThan(0);
      expect(sigil.systemPromptFragment).not.toBeNull();
      expect(sigil.systemPromptFragment?.length ?? 0).toBeGreaterThan(0);
      expect(sigil.cantFile).not.toBeNull();
      expect(sigil.cantFile?.endsWith('.cant')).toBe(true);
    }
  });

  it('encodes capability flags as JSON {tier, parent, model, persist}', async () => {
    await syncCanonicalSigils();

    const db = await getNexusDb();
    const sigils = await listSigils(db);
    const subagent = sigils.find((s) => s.peerId === 'cleo-subagent');
    expect(subagent).toBeDefined();
    expect(subagent?.capabilityFlags).not.toBeNull();

    const flags = JSON.parse(subagent?.capabilityFlags as string);
    expect(flags).toMatchObject({
      tier: '0',
      parent: 'orchestrator',
      model: 'sonnet',
      persist: 'session',
    });
  });

  it('is idempotent — running twice produces the same row count', async () => {
    const first = await syncCanonicalSigils();
    const second = await syncCanonicalSigils();

    expect(second.count).toBe(first.count);
    expect(second.peerIds).toEqual(first.peerIds);

    const db = await getNexusDb();
    const sigils = await listSigils(db);
    expect(sigils.length).toBe(first.count);
  });

  it('updates rows in place when the canonical .cant content changes (last-writer-wins)', async () => {
    await syncCanonicalSigils();
    const db = await getNexusDb();
    const beforeSigils = await listSigils(db);
    const beforeOrchestrator = beforeSigils.find((s) => s.peerId === 'project-orchestrator');
    expect(beforeOrchestrator).toBeDefined();
    const originalCreatedAt = beforeOrchestrator!.createdAt;

    // Re-run.  upsertSigil preserves createdAt and bumps updatedAt.
    await syncCanonicalSigils();

    const afterSigils = await listSigils(db);
    const afterOrchestrator = afterSigils.find((s) => s.peerId === 'project-orchestrator');
    expect(afterOrchestrator).toBeDefined();
    expect(afterOrchestrator!.createdAt).toBe(originalCreatedAt);
  });

  it('returns sigils sorted by displayName ascending', async () => {
    const result = await syncCanonicalSigils();
    const sorted = [...result.peerIds].sort((a, b) => a.localeCompare(b));
    expect(result.peerIds).toEqual(sorted);
  });
});

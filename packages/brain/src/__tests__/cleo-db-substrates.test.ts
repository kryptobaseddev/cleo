/**
 * getAllSubstrates() reads the consolidated project and global `cleo.db`
 * (prefixed tables), not the legacy per-domain files (T14583).
 *
 * Both stores are created through the core chokepoint, so their schema is the
 * real migrated one; the test seeds rows and asserts each substrate's nodes and
 * edges come back.
 *
 * @task T14583
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _resetDualScopeDbCache,
  getDualScopeNativeDb,
  openDualScopeDbAtPath,
} from '@cleocode/core/store/dual-scope-db.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getAllSubstrates } from '../adapters/index.js';
import type { ProjectContext } from '../project-context.js';
import type { BrainGraph } from '../types.js';

let dir: string;
let graph: BrainGraph;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-brain-t14583-'));
  const home = join(dir, 'home');
  const projectRoot = join(dir, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
  vi.stubEnv('CLEO_HOME', home);
  vi.stubEnv('XDG_STATE_HOME', join(dir, 'state'));

  const projectStore = join(projectRoot, '.cleo', 'cleo.db');
  const project = getDualScopeNativeDb(await openDualScopeDbAtPath('project', projectStore));
  project.exec(`
    INSERT INTO tasks_tasks (id, title, status, priority, type) VALUES
      ('T1', 'Epic one', 'active', 'high', 'epic'),
      ('T2', 'Child two', 'pending', 'medium', 'task'),
      ('T3', 'Sibling three', 'pending', 'low', 'task');
    UPDATE tasks_tasks SET parent_id = 'T1' WHERE id = 'T2';
    INSERT INTO tasks_task_dependencies (task_id, depends_on) VALUES ('T2', 'T1');
    INSERT INTO tasks_task_relations (task_id, related_to, relation_type) VALUES ('T2', 'T3', 'related');
    INSERT INTO tasks_sessions (id, name, status) VALUES ('ses_seed_00000001', 'seed', 'active');
    INSERT INTO brain_observations (id, type, title) VALUES ('O-1', 'discovery', 'Seeded observation');
    INSERT INTO brain_decisions (id, type, decision, rationale, confidence, context_task_id)
      VALUES ('D-1', 'architecture', 'Seeded decision', 'because', 'high', 'T1');
    INSERT INTO conduit_conversations (id, participants) VALUES ('C-1', '["a1","a2"]');
    INSERT INTO conduit_messages (id, conversation_id, from_agent_id, to_agent_id, content)
      VALUES ('M-1', 'C-1', 'a1', 'a2', 'hello');
    INSERT INTO nexus_nodes (id, kind, label, name) VALUES
      ('src/a.ts', 'file', 'a.ts', 'a.ts'),
      ('src/a.ts::run', 'function', 'run', 'run');
    INSERT INTO nexus_relations (id, source_id, target_id, type, confidence)
      VALUES ('R-1', 'src/a.ts', 'src/a.ts::run', 'contains', 1);
  `);

  const global = getDualScopeNativeDb(await openDualScopeDbAtPath('global', join(home, 'cleo.db')));
  global.exec(`
    INSERT INTO agent_registry_agents (id, agent_id, name, status, created_at, updated_at)
      VALUES ('ag-1', 'a1', 'Agent One', 'online', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z');
  `);
  _resetDualScopeDbCache();

  const projectCtx: ProjectContext = {
    projectPath: projectRoot,
    brainDbPath: projectStore,
    tasksDbPath: projectStore,
  };
  graph = getAllSubstrates({ limit: 500, projectCtx });
});

afterAll(() => {
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('getAllSubstrates() over the consolidated cleo.db (T14583)', () => {
  it('returns a node from every substrate', () => {
    const ids = new Set(graph.nodes.map((n) => n.id));
    for (const id of [
      'tasks:T1',
      'tasks:T2',
      'tasks:T3',
      'tasks:ses_seed_00000001',
      'brain:O-1',
      'brain:D-1',
      'conduit:M-1',
      'nexus:src/a.ts',
      'nexus:src/a.ts::run',
      'agent-registry:a1',
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
    expect(graph.counts.nodes['agent-registry']).toBe(1);
  });

  it('returns the edges the prefixed tables describe', () => {
    const edges = new Set(graph.edges.map((e) => `${e.source}|${e.type}|${e.target}`));
    for (const edge of [
      'tasks:T1|parent_of|tasks:T2',
      'tasks:T2|depends_on|tasks:T1',
      'tasks:T2|related|tasks:T3',
      'brain:D-1|applies_to|tasks:T1',
      'nexus:src/a.ts|contains|nexus:src/a.ts::run',
      'agent-registry:a1|messages|agent-registry:a2',
    ]) {
      expect(edges.has(edge), edge).toBe(true);
    }
  });

  it('normalises timestamps to ISO-8601', () => {
    const agent = graph.nodes.find((n) => n.id === 'agent-registry:a1');
    expect(agent?.createdAt).toBe('2026-11-01T00:00:00');
    const message = graph.nodes.find((n) => n.id === 'conduit:M-1');
    expect(message?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });
});

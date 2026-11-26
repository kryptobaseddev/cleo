/**
 * getAllSubstrates() reads the consolidated project and global `cleo.db`
 * (prefixed tables), not the legacy per-domain files (T14583).
 *
 * Both stores are created through the core chokepoint, so their schema is the
 * real migrated one; the test seeds rows and asserts each substrate's nodes and
 * edges come back. A second store with a dropped table proves a failed adapter
 * read is reported in `graph.errors`, never returned as a silently empty
 * substrate (T14647). Further stores prove each query fails on its own, and
 * that a failed nexus stub read and an unopenable store are reported (T14656).
 *
 * @task T14583
 * @task T14647
 * @task T14656
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
let brokenGraph: BrainGraph;
let partialGraph: BrainGraph;
let tasksKindGraph: BrainGraph;
let unopenableGraph: BrainGraph;
let unopenableGlobalGraph: BrainGraph;

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
    INSERT INTO brain_patterns (id, type, pattern, context) VALUES ('P-1', 'workflow', 'Seeded pattern', 'ctx');
    INSERT INTO brain_learnings (id, insight, source, confidence) VALUES ('L-1', 'Seeded learning', 'test', 0.9);
    INSERT INTO brain_page_edges (from_id, to_id, edge_type, weight) VALUES
      ('learning:L-1', 'observation:O-1', 'derived_from', 0.9),
      ('decision:D-1', 'pattern:P-1', 'informed_by', 0.8),
      ('observation:O-1', 'task:T2', 'applies_to', 0.7),
      ('observation:O-1', 'src/a.ts::run', 'code_reference', 0.6);
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

  // A store whose nexus_relations table is gone: the nexus read fails after
  // its nodes query, which must surface as an error, not a quiet short graph.
  const brokenRoot = join(dir, 'broken');
  mkdirSync(join(brokenRoot, '.cleo'), { recursive: true });
  const brokenStore = join(brokenRoot, '.cleo', 'cleo.db');
  const broken = getDualScopeNativeDb(await openDualScopeDbAtPath('project', brokenStore));
  broken.exec('DROP TABLE nexus_relations;');
  _resetDualScopeDbCache();
  brokenGraph = getAllSubstrates({
    limit: 500,
    projectCtx: { projectPath: brokenRoot, brainDbPath: brokenStore, tasksDbPath: brokenStore },
  });

  // A store missing brain_decisions and nexus_nodes: the other brain queries
  // still return, and the nexus stub read for the code_reference edge fails.
  const partialRoot = join(dir, 'partial');
  mkdirSync(join(partialRoot, '.cleo'), { recursive: true });
  const partialStore = join(partialRoot, '.cleo', 'cleo.db');
  const partial = getDualScopeNativeDb(await openDualScopeDbAtPath('project', partialStore));
  partial.exec(`
    INSERT INTO brain_observations (id, type, title) VALUES ('O-1', 'discovery', 'Seeded observation');
    INSERT INTO brain_patterns (id, type, pattern, context) VALUES ('P-1', 'workflow', 'Seeded pattern', 'ctx');
    INSERT INTO brain_learnings (id, insight, source, confidence) VALUES ('L-1', 'Seeded learning', 'test', 0.9);
    INSERT INTO brain_page_edges (from_id, to_id, edge_type, weight) VALUES
      ('learning:L-1', 'observation:O-1', 'derived_from', 0.9),
      ('observation:O-1', 'src/a.ts::run', 'code_reference', 0.6),
      ('decision:D-1', 'pattern:P-1', 'informed_by', 0.8),
      ('learning:L-1', 'decision:D-1', 'supersedes', 0.5),
      ('learning:L-1', 'observation:O-9', 'related', 0.5),
      ('observation:O-1', 'task:T9', 'applies_to', 0.7);
    DROP TABLE brain_decisions;
    DROP TABLE tasks_sessions;
    DROP TABLE nexus_nodes;
  `);
  _resetDualScopeDbCache();
  partialGraph = getAllSubstrates({
    limit: 500,
    projectCtx: { projectPath: partialRoot, brainDbPath: partialStore, tasksDbPath: partialStore },
  });

  // A store whose tasks_tasks query fails while tasks_sessions loads: an edge
  // to an unloaded task is dropped, the healthy session kind still loads.
  const tasksKindRoot = join(dir, 'tasks-kind');
  mkdirSync(join(tasksKindRoot, '.cleo'), { recursive: true });
  const tasksKindStore = join(tasksKindRoot, '.cleo', 'cleo.db');
  const tasksKind = getDualScopeNativeDb(await openDualScopeDbAtPath('project', tasksKindStore));
  tasksKind.exec(`
    INSERT INTO tasks_sessions (id, name, status) VALUES ('ses_seed_00000001', 'seed', 'active');
    INSERT INTO brain_observations (id, type, title) VALUES ('O-1', 'discovery', 'Seeded observation');
    INSERT INTO brain_page_edges (from_id, to_id, edge_type, weight) VALUES
      ('observation:O-1', 'task:T9', 'applies_to', 0.7);
    DROP TABLE tasks_tasks;
  `);
  _resetDualScopeDbCache();
  tasksKindGraph = getAllSubstrates({
    limit: 500,
    projectCtx: {
      projectPath: tasksKindRoot,
      brainDbPath: tasksKindStore,
      tasksDbPath: tasksKindStore,
    },
  });

  // A project store that exists but is not a database.
  const unopenableRoot = join(dir, 'unopenable');
  mkdirSync(join(unopenableRoot, '.cleo'), { recursive: true });
  const unopenableStore = join(unopenableRoot, '.cleo', 'cleo.db');
  writeFileSync(unopenableStore, 'not a sqlite database, just text '.repeat(200));
  unopenableGraph = getAllSubstrates({
    limit: 500,
    projectCtx: {
      projectPath: unopenableRoot,
      brainDbPath: unopenableStore,
      tasksDbPath: unopenableStore,
    },
  });

  // A global store that exists but is not a database, beside the healthy
  // project store: conduit's a1 → a2 edge points at agents that never loaded.
  const badHome = join(dir, 'bad-home');
  mkdirSync(badHome, { recursive: true });
  writeFileSync(join(badHome, 'cleo.db'), 'not a sqlite database, just text '.repeat(200));
  vi.stubEnv('CLEO_HOME', badHome);
  unopenableGlobalGraph = getAllSubstrates({ limit: 500, projectCtx });
  vi.stubEnv('CLEO_HOME', home);
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
      'brain:P-1',
      'brain:L-1',
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
      'brain:L-1|derived_from|brain:O-1',
      'brain:D-1|informed_by|brain:P-1',
      'brain:O-1|applies_to|tasks:T2',
      'brain:O-1|code_reference|nexus:src/a.ts::run',
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

  it('reports no substrate errors for a healthy store', () => {
    expect(graph.errors).toBeUndefined();
    const kinds = new Map(graph.nodes.map((n) => [n.id, n.kind]));
    expect(kinds.get('brain:P-1')).toBe('pattern');
    expect(kinds.get('brain:L-1')).toBe('learning');
  });

  it('reports a failed adapter read instead of a silently empty substrate (T14647)', () => {
    expect(brokenGraph.errors?.nexus).toMatch(/no such table/i);
    expect(Object.keys(brokenGraph.errors ?? {})).toEqual(['nexus']);
  });

  it('keeps the other queries of an adapter when one query fails (T14656)', () => {
    const ids = new Set(partialGraph.nodes.map((n) => n.id));
    for (const id of ['brain:O-1', 'brain:P-1', 'brain:L-1']) {
      expect(ids.has(id), id).toBe(true);
    }
    const edges = new Set(partialGraph.edges.map((e) => `${e.source}|${e.type}|${e.target}`));
    expect(edges.has('brain:L-1|derived_from|brain:O-1')).toBe(true);
    expect(partialGraph.errors?.brain).toMatch(/^brain_decisions: .*no such table/i);
    expect(partialGraph.errors?.brain).not.toMatch(/brain_patterns|brain_learnings/);
  });

  it('drops and counts edges whose endpoint failed to load, with no fake stub (T14658)', () => {
    const edges = partialGraph.edges.map((e) => `${e.source}|${e.type}|${e.target}`);
    expect(edges.some((e) => e.includes('brain:D-1'))).toBe(false);
    expect(partialGraph.nodes.some((n) => n.id === 'brain:D-1')).toBe(false);
    expect(partialGraph.errors?.brain).toMatch(
      /dropped 2 edge\(s\) whose decision endpoint did not load because its node query failed/,
    );
  });

  it('keeps edges to absent targets of a healthy kind beside a failed kind (T14659)', () => {
    const edges = partialGraph.edges.map((e) => `${e.source}|${e.type}|${e.target}`);
    // brain: decisions failed, observations loaded; O-9 is simply absent.
    expect(edges).toContain('brain:L-1|related|brain:O-9');
    expect(partialGraph.nodes.find((n) => n.id === 'brain:O-9')?.meta?.isStub).toBe(true);
    // tasks: sessions failed, tasks loaded; T9 is simply absent.
    expect(edges).toContain('brain:O-1|applies_to|tasks:T9');
    expect(partialGraph.nodes.find((n) => n.id === 'tasks:T9')?.meta?.isStub).toBe(true);
    expect(partialGraph.errors?.tasks).toMatch(/^tasks_sessions: .*no such table/i);
    expect(partialGraph.errors?.tasks).not.toMatch(/dropped/);
  });

  it('drops an edge to an unloaded target of a failed kind beside a healthy kind (T14659)', () => {
    const edges = tasksKindGraph.edges.map((e) => `${e.source}|${e.type}|${e.target}`);
    expect(edges).not.toContain('brain:O-1|applies_to|tasks:T9');
    expect(tasksKindGraph.nodes.some((n) => n.id === 'tasks:T9')).toBe(false);
    expect(tasksKindGraph.nodes.some((n) => n.id === 'tasks:ses_seed_00000001')).toBe(true);
    expect(tasksKindGraph.errors?.tasks).toMatch(
      /^tasks_tasks: .*; dropped 1 edge\(s\) whose task target did not load because its node query failed$/,
    );
    expect(tasksKindGraph.counts.edges.cross).toBe(0);
  });

  it('drops edges into a substrate whose store cannot be opened, with no fake stub (T14659)', () => {
    const edges = unopenableGlobalGraph.edges.map((e) => `${e.source}|${e.type}|${e.target}`);
    expect(edges).not.toContain('agent-registry:a1|messages|agent-registry:a2');
    expect(unopenableGlobalGraph.nodes.some((n) => n.substrate === 'agent-registry')).toBe(false);
    expect(unopenableGlobalGraph.errors?.['agent-registry']).toMatch(
      /^store cannot be opened: .*; dropped 1 edge\(s\) whose agent target did not load because its node query failed$/,
    );
    expect(unopenableGlobalGraph.counts.edges.cross).toBe(graph.counts.edges.cross - 1);
  });

  it('reports a failed nexus stub read (T14656)', () => {
    expect(partialGraph.errors?.nexus).toMatch(/nexus_nodes \(stubs\): .*no such table/i);
  });

  it('reports an unopenable store for every project substrate (T14656)', () => {
    for (const substrate of ['brain', 'tasks', 'conduit', 'nexus'] as const) {
      expect(unopenableGraph.errors?.[substrate], substrate).toMatch(/^store cannot be opened: /);
    }
    expect(unopenableGraph.errors?.['agent-registry']).toBeUndefined();
    expect(unopenableGraph.nodes.every((n) => n.substrate === 'agent-registry')).toBe(true);
  });
});

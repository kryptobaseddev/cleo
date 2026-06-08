/**
 * Tests for the agent-facing tool registry (T1739 · epic T11456).
 *
 * Covers the 8 acceptance criteria:
 *   AC1 register + dispatch · AC2 bounded discovery · AC3 OpenAI schema shape ·
 *   AC4 toolset grouping · AC5 availability checks · AC6 thread-safe / frozen +
 *   single-flight double-init · AC7 explicit init (built-ins, not at import) ·
 *   AC8 (this file).
 *
 * @task T1739
 * @epic T11456
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AGENT_TOOL_REGISTER_FN,
  AgentToolRegistry,
  ALWAYS_AVAILABLE,
  createAgentToolRegistry,
} from '../agent-registry.js';
import { createToolGuard } from '../guard.js';
import { zodSchemaToOpenAITool } from '../schema-gen.js';

/** A minimal custom tool descriptor for register/dispatch tests. */
function echoTool(name = 'echo') {
  return {
    name,
    class: 'fs' as const,
    description: 'Echo back its message.',
    toolset: 'agent' as const,
    stateless: true,
    available: ALWAYS_AVAILABLE,
    parameters: z.object({ message: z.string() }),
    execute: async (args: Readonly<Record<string, unknown>>) => ({ echoed: args.message }),
  };
}

describe('AgentToolRegistry — register + dispatch (AC1)', () => {
  it('registers a tool, looks it up, and dispatches its executable', async () => {
    const r = new AgentToolRegistry();
    r.register(echoTool());
    expect(r.size).toBe(1);
    expect(r.get('echo')?.description).toBe('Echo back its message.');

    const exec = r.getExecutable('echo');
    expect(exec).toBeTypeOf('function');
    const guard = createToolGuard();
    const out = await exec?.({ message: 'hi' }, guard);
    expect(out).toEqual({ echoed: 'hi' });
  });

  it('rejects duplicate tool names', () => {
    const r = new AgentToolRegistry();
    r.register(echoTool());
    expect(() => r.register(echoTool())).toThrow(/duplicate/);
  });

  it('returns undefined for unknown tools', () => {
    const r = new AgentToolRegistry();
    expect(r.get('nope')).toBeUndefined();
    expect(r.getExecutable('nope')).toBeUndefined();
  });
});

describe('AgentToolRegistry — built-in atomic primitives (AC7 + wiring)', () => {
  it('init() registers the built-in fs/shell tools so the registry is non-empty', async () => {
    const r = await createAgentToolRegistry();
    expect(r.initialised).toBe(true);
    expect(r.size).toBeGreaterThanOrEqual(5);
    for (const name of ['read_file', 'write_file', 'path_exists', 'run_command', 'run_git']) {
      expect(r.get(name), `built-in ${name} should be registered`).toBeDefined();
    }
  });

  it('a built-in tool routes its side effect through the guarded surface', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleo-agtool-'));
    try {
      const r = await createAgentToolRegistry();
      const guard = createToolGuard({ allowedRoots: [root], mode: 'enforce' });
      const write = r.getExecutable('write_file');
      if (write === undefined) throw new Error('write_file built-in missing');
      const res = (await write({ path: join(root, 'x.txt'), content: 'yo' }, guard)) as {
        bytesWritten: number;
      };
      expect(res.bytesWritten).toBe(2);

      const read = r.getExecutable('read_file');
      if (read === undefined) throw new Error('read_file built-in missing');
      const got = (await read({ path: join(root, 'x.txt') }, guard)) as { content: string };
      expect(got.content).toBe('yo');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('skipBuiltins leaves the registry empty', async () => {
    const r = await createAgentToolRegistry({ skipBuiltins: true });
    expect(r.size).toBe(0);
  });
});

describe('AgentToolRegistry — OpenAI schema generation (AC3)', () => {
  it('emits TransportTool shape with a JSON-Schema inputSchema', async () => {
    const r = await createAgentToolRegistry();
    const tools = r.toOpenAITools();
    expect(tools.length).toBe(r.size);
    const readFile = tools.find((t) => t.name === 'read_file');
    expect(readFile).toBeDefined();
    expect(readFile?.description).toContain('Read a file');
    // JSON-Schema object form (Zod v4 z.toJSONSchema)
    expect(readFile?.inputSchema).toMatchObject({ type: 'object' });
    const props = (readFile?.inputSchema as { properties?: Record<string, unknown> }).properties;
    expect(props).toHaveProperty('path');
  });

  it('the registry and the shared generator produce identical schemas (DRY)', async () => {
    const r = await createAgentToolRegistry();
    const tool = r.get('write_file');
    if (tool === undefined) throw new Error('write_file built-in missing');
    const viaRegistry = r.toOpenAITools().find((t) => t.name === 'write_file');
    const viaGenerator = zodSchemaToOpenAITool({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    });
    expect(viaRegistry).toEqual(viaGenerator);
  });

  it('only AVAILABLE tools are emitted when a context is passed', async () => {
    const r = await createAgentToolRegistry();
    // run_git requires `git` on PATH; deny it.
    const tools = r.toOpenAITools({ availableBinaries: [] });
    expect(tools.find((t) => t.name === 'run_git')).toBeUndefined();
    expect(tools.find((t) => t.name === 'read_file')).toBeDefined();
  });
});

describe('AgentToolRegistry — toolset grouping (AC4)', () => {
  it('byToolset() buckets every tool and always returns all 5 keys', async () => {
    const r = await createAgentToolRegistry();
    const grouped = r.byToolset();
    expect(Object.keys(grouped).sort()).toEqual(
      ['agent', 'file', 'media', 'terminal', 'web'].sort(),
    );
    // The thin built-ins (T1739) PLUS the richer T1741 families share the file
    // and terminal toolsets — assert the built-ins are present (superset check)
    // rather than an exact list, so adding families doesn't break this test.
    const fileNames = grouped.file.map((t) => t.name);
    expect(fileNames).toEqual(expect.arrayContaining(['path_exists', 'read_file', 'write_file']));
    const terminalNames = grouped.terminal.map((t) => t.name);
    expect(terminalNames).toEqual(expect.arrayContaining(['run_command', 'run_git']));
    // No net/notebook primitives implemented yet — empty but present.
    expect(grouped.web).toEqual([]);
    expect(grouped.media).toEqual([]);
  });

  it('byToolset(toolset) filters to a single group', async () => {
    const r = await createAgentToolRegistry();
    expect(r.byToolset('file').every((t) => t.toolset === 'file')).toBe(true);
    expect(r.byToolset('web')).toEqual([]);
  });
});

describe('AgentToolRegistry — availability checks (AC5)', () => {
  it('available() filters out tools whose predicate is false', async () => {
    const r = await createAgentToolRegistry();
    const withoutGit = r.available({ availableBinaries: [] });
    expect(withoutGit.find((t) => t.name === 'run_git')).toBeUndefined();
    const withGit = r.available({ availableBinaries: ['git'] });
    expect(withGit.find((t) => t.name === 'run_git')).toBeDefined();
  });

  it('a tool with no predicate is always available', async () => {
    const r = new AgentToolRegistry();
    r.register({ ...echoTool(), available: undefined });
    await r.init({ skipBuiltins: true });
    expect(r.available({}).map((t) => t.name)).toContain('echo');
  });
});

describe('AgentToolRegistry — frozen-after-init + single-flight (AC6)', () => {
  it('register() after init() throws (immutable)', async () => {
    const r = await createAgentToolRegistry({ skipBuiltins: true });
    expect(() => r.register(echoTool())).toThrow(/frozen/);
  });

  it('discover() after init() throws (immutable)', async () => {
    const r = await createAgentToolRegistry({ skipBuiltins: true });
    await expect(r.discover([])).rejects.toThrow(/frozen/);
  });

  it('double init() is idempotent (no duplicate registration)', async () => {
    const r = new AgentToolRegistry();
    await r.init();
    const sizeAfterFirst = r.size;
    await r.init();
    expect(r.size).toBe(sizeAfterFirst);
    expect(r.initialised).toBe(true);
  });

  it('concurrent init() calls coalesce into one (single-flight)', async () => {
    // Control: a single init() establishes the canonical built-in count.
    const control = new AgentToolRegistry();
    await control.init();
    const r = new AgentToolRegistry();
    await Promise.all([r.init(), r.init(), r.init()]);
    // Built-ins registered exactly once despite 3 concurrent inits — same count
    // as a single init (no duplicate registration race).
    expect(r.size).toBe(control.size);
  });

  it('list() returns a defensive copy (mutating it does not affect the registry)', async () => {
    const r = await createAgentToolRegistry();
    const before = r.size;
    const copy = r.list() as unknown[];
    copy.push({});
    expect(r.size).toBe(before);
  });
});

describe('AgentToolRegistry — bounded discovery (AC2)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cleo-agtool-discover-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('discovers + imports a *.agent-tool.js module that self-registers', async () => {
    // A self-registering tool module using the marker export. ESM .js with a
    // zod-free schema to avoid resolving deps in the temp dir.
    const moduleSrc = `
export function ${AGENT_TOOL_REGISTER_FN}(registry) {
  registry.register({
    name: 'discovered_tool',
    class: 'fs',
    description: 'A tool found by directory scan.',
    toolset: 'agent',
    stateless: true,
    available: () => true,
    parameters: { _zod: { def: { type: 'object' } }, type: 'object' },
    execute: async () => ({ ok: true }),
  });
}
`;
    writeFileSync(join(dir, 'sample.agent-tool.js'), moduleSrc, 'utf8');
    // A decoy non-tool file in the same dir — must NOT be imported.
    writeFileSync(join(dir, 'ignore-me.js'), 'export const x = 1;', 'utf8');

    const r = new AgentToolRegistry();
    await r.init({ scanDirs: [dir], skipBuiltins: true });
    expect(r.get('discovered_tool')).toBeDefined();
    expect(r.size).toBe(1);
  });

  it('skips files lacking the register marker', async () => {
    writeFileSync(join(dir, 'no-marker.agent-tool.js'), 'export const notRegister = 1;', 'utf8');
    const r = new AgentToolRegistry();
    await r.init({ scanDirs: [dir], skipBuiltins: true });
    expect(r.size).toBe(0);
  });

  it('tolerates an unreadable scan dir without throwing', async () => {
    const r = new AgentToolRegistry();
    await expect(
      r.init({ scanDirs: [join(dir, 'does-not-exist')], skipBuiltins: true }),
    ).resolves.toBeUndefined();
    expect(r.initialised).toBe(true);
  });
});

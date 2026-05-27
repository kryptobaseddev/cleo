/**
 * Unit tests for POST /api/setup/section/:name (T9427 · E3 §5.3 T-E3-8).
 *
 * Covers:
 *   - Validates the section id against the closed wizard-section list.
 *   - Validates the JSON body shape (rejects non-objects).
 *   - Dispatches to the matching `WizardSectionRunner` from
 *     `createBuiltinSections()` and forwards `nonInteractive`,
 *     `strictness`, etc. to the runner.
 *   - Returns the section's `changed` + `summary` verbatim.
 *   - Reports `success: false` when the runner surfaces `io.error()`.
 *   - Returns 500 when the runner throws (e.g. a section asks an
 *     interactive prompt on the HTTP surface).
 *
 * The `@cleocode/core/setup/index.js` module is mocked so the suite
 * never touches the real credential pool / config layer.
 *
 * @task T9427
 * @epic E-CONFIG-AUTH-UNIFY (E3 §5.3 T-E3-8)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// -----------------------------------------------------------------------------
// Shared mock state — set per test before importing the handler.
// -----------------------------------------------------------------------------

interface RecordedRun {
  section: string;
  optionsKeys: string[];
  options: Record<string, unknown>;
}

let recordedRuns: RecordedRun[] = [];

interface SectionScript {
  changed: boolean;
  summary: string;
  /** Emit `io.error(message)` calls during the run. */
  errors?: string[];
  /** Throw an error mid-section. */
  throws?: string;
}

let sectionScripts: Record<string, SectionScript> = {};

vi.mock('@cleocode/core/setup/index.js', () => {
  interface WizardIOLike {
    error: (msg: string) => void;
    info: (msg: string) => void;
    warn: (msg: string) => void;
  }

  interface RunnerLike {
    section: string;
    title: string;
    optional: boolean;
    run: (
      io: WizardIOLike,
      options: Record<string, unknown>,
    ) => Promise<{
      changed: boolean;
      summary: string;
    }>;
  }

  const makeRunner = (name: string): RunnerLike => ({
    section: name,
    title: `Mock ${name}`,
    optional: false,
    async run(io: WizardIOLike, options: Record<string, unknown>) {
      const script = sectionScripts[name] ?? {
        changed: false,
        summary: 'no script registered',
      };
      recordedRuns.push({
        section: name,
        optionsKeys: Object.keys(options),
        options: { ...options },
      });
      for (const message of script.errors ?? []) {
        io.error(message);
      }
      if (script.throws) {
        throw new Error(script.throws);
      }
      return { changed: script.changed, summary: script.summary };
    },
  });

  class MockWizardRunner {
    constructor(private readonly sections: readonly RunnerLike[]) {}
    async runSection(
      name: string,
      io: WizardIOLike,
      options: Record<string, unknown>,
    ): Promise<{ changed: boolean; summary: string }> {
      const found = this.sections.find((s) => s.section === name);
      if (!found) throw new Error(`runSection: unknown section ${name}`);
      return found.run(io, options);
    }
  }

  return {
    createBuiltinSections: () => [
      makeRunner('llm'),
      makeRunner('identity'),
      makeRunner('sentient'),
      makeRunner('project-conventions'),
      makeRunner('harness'),
      makeRunner('brain'),
    ],
    WizardRunner: MockWizardRunner,
  };
});

// -----------------------------------------------------------------------------
// Lazy-imported handler (after mocks above)
// -----------------------------------------------------------------------------

async function importHandler(): Promise<typeof import('../section/[name]/+server.js').POST> {
  const mod = await import('../section/[name]/+server.js');
  return mod.POST;
}

function makeEvent(args: {
  name: string;
  body?: unknown;
  raw?: string;
}): Parameters<typeof import('../section/[name]/+server.js').POST>[0] {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  };
  if (args.raw !== undefined) {
    init.body = args.raw;
  } else if (args.body !== undefined) {
    init.body = JSON.stringify(args.body);
  } else {
    init.body = '{}';
  }
  return {
    request: new Request(`http://x/api/setup/section/${args.name}`, init),
    params: { name: args.name },
  } as unknown as Parameters<typeof import('../section/[name]/+server.js').POST>[0];
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

beforeEach(() => {
  recordedRuns = [];
  sectionScripts = {};
});

describe('POST /api/setup/section/:name — validation', () => {
  it('rejects unknown section ids with E_VALIDATION', async () => {
    const POST = await importHandler();
    const res = await POST(makeEvent({ name: 'not-a-section' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('E_VALIDATION');
    expect(body.error.message).toContain("Unknown wizard section 'not-a-section'");
  });

  it('rejects non-object bodies with E_VALIDATION', async () => {
    const POST = await importHandler();
    const res = await POST(makeEvent({ name: 'llm', raw: '"a-string"' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('E_VALIDATION');
  });

  it('rejects invalid JSON bodies with E_VALIDATION', async () => {
    const POST = await importHandler();
    const res = await POST(makeEvent({ name: 'llm', raw: '{ not json' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('E_VALIDATION');
  });
});

describe('POST /api/setup/section/:name — dispatch', () => {
  it('runs the named section runner and returns its changed/summary', async () => {
    sectionScripts['project-conventions'] = {
      changed: true,
      summary: "applied 'strict' preset (4 keys to project config)",
    };
    const POST = await importHandler();
    const res = await POST(
      makeEvent({
        name: 'project-conventions',
        body: { strictness: 'strict' },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { section: string; success: boolean; changes: boolean; summary: string };
    };
    expect(body.success).toBe(true);
    expect(body.data.section).toBe('project-conventions');
    expect(body.data.success).toBe(true);
    expect(body.data.changes).toBe(true);
    expect(body.data.summary).toBe("applied 'strict' preset (4 keys to project config)");

    expect(recordedRuns).toHaveLength(1);
    expect(recordedRuns[0]?.section).toBe('project-conventions');
    expect(recordedRuns[0]?.options['strictness']).toBe('strict');
    // The handler defaults to non-interactive mode for the HTTP surface.
    expect(recordedRuns[0]?.options['nonInteractive']).toBe(true);
  });

  it('forwards the LLM credential fields to the section runner', async () => {
    sectionScripts['llm'] = {
      changed: true,
      summary: 'added anthropic:work to pool',
    };
    const POST = await importHandler();
    const res = await POST(
      makeEvent({
        name: 'llm',
        body: { provider: 'anthropic', apiKey: 'sk-ant-NOPE', label: 'work' },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { section: string; changes: boolean };
    };
    expect(body.data.section).toBe('llm');
    expect(body.data.changes).toBe(true);

    const run = recordedRuns[0];
    expect(run?.options['provider']).toBe('anthropic');
    expect(run?.options['apiKey']).toBe('sk-ant-NOPE');
    expect(run?.options['label']).toBe('work');

    // The response wire MUST NOT include the apiKey value.
    const wire = JSON.stringify(body);
    expect(wire).not.toContain('sk-ant-NOPE');
  });

  it('marks success=false when the section runner emits io.error()', async () => {
    sectionScripts['identity'] = {
      changed: false,
      summary: 'failed: bad input',
      errors: ['name is empty'],
    };
    const POST = await importHandler();
    const res = await POST(makeEvent({ name: 'identity', body: { agentName: '' } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { success: boolean; summary: string } };
    expect(body.data.success).toBe(false);
    expect(body.data.summary).toBe('failed: bad input');
  });

  it('returns 500 with E_SECTION_FAILED when the runner throws', async () => {
    sectionScripts['llm'] = {
      changed: false,
      summary: '',
      throws: 'simulated boom',
    };
    const POST = await importHandler();
    const res = await POST(
      makeEvent({ name: 'llm', body: { provider: 'anthropic', apiKey: 'k' } }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('E_SECTION_FAILED');
    expect(body.error.message).toContain('simulated boom');
  });

  it('preserves nonInteractive=false when explicitly opted out', async () => {
    sectionScripts['identity'] = { changed: false, summary: 'noop' };
    const POST = await importHandler();
    await POST(
      makeEvent({
        name: 'identity',
        body: { nonInteractive: false, agentName: 'atlas' },
      }),
    );
    expect(recordedRuns[0]?.options['nonInteractive']).toBe(false);
    expect(recordedRuns[0]?.options['agentName']).toBe('atlas');
  });

  it('ignores unknown strictness / harness / brainBridgeMode values', async () => {
    sectionScripts['project-conventions'] = { changed: false, summary: 'noop' };
    const POST = await importHandler();
    await POST(
      makeEvent({
        name: 'project-conventions',
        body: { strictness: 'bogus', harness: 'wat', brainBridgeMode: 'no' },
      }),
    );
    const opts = recordedRuns[0]?.options ?? {};
    expect(opts['strictness']).toBeUndefined();
    expect(opts['harness']).toBeUndefined();
    expect(opts['brainBridgeMode']).toBeUndefined();
  });
});

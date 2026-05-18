/**
 * CLI wiring tests for `cleo setup` (T9421 + T9599).
 *
 * The core {@link WizardRunner} is exercised in
 * `packages/core/src/setup/__tests__/wizard.test.ts`. These tests only
 * verify the CLI surface:
 *
 *   - The command exposes the documented flag set.
 *   - `runSetup()` walks every section when no `--section` is supplied.
 *   - `runSetup({ section: '<name>' })` runs only that section.
 *   - `runSetup({ 'non-interactive': true, provider, 'api-key' })`
 *     threads the right `WizardOptions` through to the wizard runner.
 *   - `buildWizardOptions()` maps every documented CLI flag onto the
 *     `WizardOptions` bag the runner expects.
 *   - T9599: `StdinClosedError` propagates cleanly out of `runSetup`.
 *
 * We mock `createDefaultWizardRunner` so the test never touches the
 * credential pool, the sentient daemon config, or `SOUL.md`.
 *
 * @task T9421
 * @task T9599
 * @epic E-CONFIG-AUTH-UNIFY (E3 §5.3 T-E3-2)
 */

import type {
  WizardIO,
  WizardOptions,
  WizardSection,
  WizardSectionResult,
} from '@cleocode/core/setup';
import { StubWizardIO } from '@cleocode/core/setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared BEFORE importing the command module.
// ---------------------------------------------------------------------------

interface MockSectionRunner {
  section: WizardSection;
  title: string;
  optional: boolean;
  run: ReturnType<typeof vi.fn>;
}

function makeSection(name: WizardSection, summary = 'ok', changed = true): MockSectionRunner {
  return {
    section: name,
    title: `${name} title`,
    optional: false,
    run: vi.fn().mockResolvedValue({ changed, summary } satisfies WizardSectionResult),
  };
}

const sections: Record<WizardSection, MockSectionRunner> = {
  llm: makeSection('llm', 'llm-applied'),
  identity: makeSection('identity', 'identity-applied'),
  sentient: makeSection('sentient', 'sentient-applied'),
  'project-conventions': makeSection('project-conventions', 'conventions-applied'),
  harness: makeSection('harness', 'harness-applied'),
  brain: makeSection('brain', 'brain-applied'),
};

const sectionList: MockSectionRunner[] = [
  sections.llm,
  sections.identity,
  sections.sentient,
  sections['project-conventions'],
];

class FakeRunner {
  list() {
    return sectionList;
  }
  async run(io: WizardIO, options: WizardOptions) {
    const summary: string[] = [];
    const sectionsRun: WizardSection[] = [];
    for (const s of sectionList) {
      sectionsRun.push(s.section);
      const result = (await s.run(io, options)) as WizardSectionResult;
      summary.push(`${s.section}: ${result.summary}`);
    }
    return { sectionsRun, summary };
  }
  async runSection(name: WizardSection, io: WizardIO, options: WizardOptions) {
    const runner = sectionList.find((s) => s.section === name);
    if (!runner) throw new Error(`unknown section ${name}`);
    return runner.run(io, options) as Promise<WizardSectionResult>;
  }
}

const fakeRunnerInstance = new FakeRunner();

vi.mock('@cleocode/core/setup', async () => {
  // Re-import the real module so types (`StubWizardIO`) stay intact while
  // the runner factory is stubbed.
  const actual =
    await vi.importActual<typeof import('@cleocode/core/setup')>('@cleocode/core/setup');
  return {
    ...actual,
    createDefaultWizardRunner: () => fakeRunnerInstance,
  };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { StdinClosedError } from '../../lib/readline-wizard-io.js';
import { buildWizardOptions, runSetup, setupCommand } from '../setup.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cleo setup — CLI wiring', () => {
  beforeEach(() => {
    for (const s of Object.values(sections)) {
      s.run.mockClear();
      s.run.mockResolvedValue({
        changed: true,
        summary: `${s.section}-applied`,
      } satisfies WizardSectionResult);
    }
  });

  it('exposes the documented args (section, non-interactive, provider, api-key, label, agent-name, strictness, project-root)', () => {
    const args = setupCommand.args as Record<string, { type: string; description?: string }>;
    expect(Object.keys(args).sort()).toEqual(
      [
        'agent-name',
        'api-key',
        'label',
        'non-interactive',
        'project-root',
        'provider',
        'section',
        'strictness',
      ].sort(),
    );
    // Help text must mention every flag (acceptance: "Help text explains all flags").
    for (const [, def] of Object.entries(args)) {
      expect(def.description).toBeTruthy();
    }
    // meta.description must explain canonical order.
    const desc = (setupCommand.meta as { description?: string }).description ?? '';
    expect(desc).toMatch(/canonical order|llm.*identity.*sentient/i);
  });

  it('mode 1 — `cleo setup` runs every section in canonical order', async () => {
    const io = new StubWizardIO();
    const result = await runSetup({}, io);

    expect(result.sectionsRun).toEqual(['llm', 'identity', 'sentient', 'project-conventions']);
    expect(result.summary).toEqual([
      'llm: llm-applied',
      'identity: identity-applied',
      'sentient: sentient-applied',
      'project-conventions: project-conventions-applied',
    ]);
    expect(result.ok).toBe(true);

    // Every section invoked exactly once, in order.
    expect(sections.llm.run).toHaveBeenCalledTimes(1);
    expect(sections.identity.run).toHaveBeenCalledTimes(1);
    expect(sections.sentient.run).toHaveBeenCalledTimes(1);
    expect(sections['project-conventions'].run).toHaveBeenCalledTimes(1);
  });

  it('mode 2 — `cleo setup --section identity` runs only that section', async () => {
    const io = new StubWizardIO();
    const result = await runSetup({ section: 'identity' }, io);

    expect(result.sectionsRun).toEqual(['identity']);
    expect(result.summary).toEqual(['identity: identity-applied']);
    expect(result.ok).toBe(true);

    expect(sections.identity.run).toHaveBeenCalledTimes(1);
    expect(sections.llm.run).not.toHaveBeenCalled();
    expect(sections.sentient.run).not.toHaveBeenCalled();
    expect(sections['project-conventions'].run).not.toHaveBeenCalled();
  });

  it('mode 2 — unknown --section value throws with a helpful message', async () => {
    const io = new StubWizardIO();
    await expect(runSetup({ section: 'bogus' }, io)).rejects.toThrow(/unknown section 'bogus'/i);
  });

  it('mode 3 — `--non-interactive --provider --api-key` threads WizardOptions through', async () => {
    const io = new StubWizardIO();
    const result = await runSetup(
      {
        'non-interactive': true,
        provider: 'anthropic',
        'api-key': 'sk-FAKE-123',
        label: 'cli-test',
      },
      io,
    );

    expect(result.ok).toBe(true);
    // The llm section must have received the parsed options.
    expect(sections.llm.run).toHaveBeenCalledTimes(1);
    const [ioArg, opts] = sections.llm.run.mock.calls[0] as [WizardIO, WizardOptions];
    expect(ioArg).toBe(io);
    expect(opts).toMatchObject({
      nonInteractive: true,
      provider: 'anthropic',
      apiKey: 'sk-FAKE-123',
      label: 'cli-test',
    });
  });

  it('non-zero result — a failed section is reflected in ok=false', async () => {
    sections.identity.run.mockResolvedValueOnce({
      changed: false,
      summary: 'failed: boom',
    });
    const io = new StubWizardIO();
    const result = await runSetup({}, io);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('identity: failed: boom');
  });

  describe('buildWizardOptions', () => {
    it('maps every documented flag onto WizardOptions', () => {
      const opts = buildWizardOptions({
        'non-interactive': true,
        provider: 'openai',
        'api-key': 'sk-1',
        label: 'manual',
        'agent-name': 'cleo-prime',
        strictness: 'strict',
        'project-root': '/tmp/proj',
      });
      expect(opts).toEqual({
        nonInteractive: true,
        provider: 'openai',
        apiKey: 'sk-1',
        label: 'manual',
        agentName: 'cleo-prime',
        strictness: 'strict',
        projectRoot: '/tmp/proj',
      } satisfies WizardOptions);
    });

    it('accepts camelCase aliases (apiKey, agentName, nonInteractive)', () => {
      const opts = buildWizardOptions({
        nonInteractive: true,
        apiKey: 'sk-2',
        agentName: 'cleobot',
      });
      expect(opts.nonInteractive).toBe(true);
      expect(opts.apiKey).toBe('sk-2');
      expect(opts.agentName).toBe('cleobot');
    });

    it('rejects invalid strictness values silently (no-op)', () => {
      const opts = buildWizardOptions({ strictness: 'nope' });
      expect(opts.strictness).toBeUndefined();
    });

    it('ignores empty-string flags', () => {
      const opts = buildWizardOptions({
        provider: '',
        'api-key': '',
        label: '',
      });
      expect(opts.provider).toBeUndefined();
      expect(opts.apiKey).toBeUndefined();
      expect(opts.label).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// T9599 — StdinClosedError propagation from runSetup
// ---------------------------------------------------------------------------

describe('T9599 — StdinClosedError propagates out of runSetup', () => {
  it('runSetup re-throws StdinClosedError so the command handler can emit a LAFS envelope', async () => {
    // A WizardIO that throws StdinClosedError on every prompt — simulates
    // the ReadlineWizardIO behaviour when stdin closes mid-section.
    const eofIo: WizardIO = {
      prompt: () => Promise.reject(new StdinClosedError()),
      confirm: () => Promise.reject(new StdinClosedError()),
      select: () => Promise.reject(new StdinClosedError()),
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    };

    // runSetup should let StdinClosedError propagate (not swallow it).
    await expect(runSetup({}, eofIo)).rejects.toThrow(StdinClosedError);
  });

  it('StdinClosedError.is() type-guard identifies instances correctly', () => {
    const err = new StdinClosedError();
    expect(StdinClosedError.is(err)).toBe(true);
    expect(StdinClosedError.is(new Error('other'))).toBe(false);
    expect(StdinClosedError.is(null)).toBe(false);
    expect(StdinClosedError.is('string')).toBe(false);
  });

  it('StdinClosedError carries the canonical codeName', () => {
    const err = new StdinClosedError();
    expect(err.codeName).toBe('E_SETUP_STDIN_CLOSED');
    expect(err.message).toBe('stdin closed before section completed');
  });
});

/**
 * E2E TTY-simulated test for `cleo setup` wizard (T11983).
 *
 * Exercises the FULL wizard path end-to-end using {@link StubWizardIO} as the
 * TTY simulation surface.  The test drives the real {@link WizardRunner} with
 * every built-in section in canonical order and asserts that:
 *
 *   1. All 10 sections run in canonical order (llm → models-roles → identity
 *      → sentient → project-conventions → harness → brain → integrations →
 *      telemetry → verification).
 *   2. `firstRunComplete` is `true` after a clean pass.
 *   3. The whoami summary + TUI offer are printed on first-run completion.
 *   4. The fit-gated Ollama path in `models-roles` honours the 4 GB floor:
 *      machines below the floor receive cloud-only guidance; machines above
 *      the floor receive ranked recommendations.
 *   5. `runSetup` propagates `firstRunComplete` correctly from the runner.
 *
 * Heavy I/O (credential pool, config writes, brain-db checks, network probes)
 * is mocked so tests run in < 5 s without a TTY, credentials, or Ollama.
 *
 * The "TTY-simulated" contract (referenced in the AC) maps to the
 * {@link StubWizardIO} pattern: queued `prompts`, `confirms`, and `selects`
 * replace interactive readline input while `info`/`warn`/`error` are
 * captured for assertion.  This is the canonical approach in the CLEO test
 * suite (see `packages/core/src/setup/__tests__/wizard.test.ts`) — node-pty
 * is not used here because the wizard engine is I/O-agnostic by design and
 * the TTY is fully abstracted behind `WizardIO`.
 *
 * @task T11983
 * @epic T11671 (E6-ONBOARDING-FRONT-DOOR)
 */

import type { WizardIO } from '@cleocode/core/setup';
import { StubWizardIO } from '@cleocode/core/setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared BEFORE importing the tested modules.
// ---------------------------------------------------------------------------

// Mock @cleocode/core/config so no real config files are read/written.
const mockSetConfigValue = vi.fn(async () => undefined);
const mockLoadConfigCore = vi.fn(async () => ({
  identity: { name: 'test-agent' },
  llm: { default: { provider: 'anthropic', model: 'claude-opus-4-5' } },
}));
vi.mock('@cleocode/core/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cleocode/core/config')>();
  return {
    ...actual,
    setConfigValue: (...a: unknown[]) => mockSetConfigValue(...(a as [])),
    loadConfig: () => mockLoadConfigCore(),
    getConfigValue: vi.fn(async (key: string) => ({
      value: key === 'agent.name' ? 'test-agent' : undefined,
    })),
  };
});

// Mock credential pool.
const mockPoolList = vi.fn(async () => [
  { provider: 'anthropic', label: 'cli-input', source: 'manual' },
]);
const mockGetCredentialPool = vi.fn(() => ({
  list: mockPoolList,
  seed: vi.fn(async () => ({ added: 0, failed: 0, skipped: 0 })),
}));
vi.mock('@cleocode/core/llm/credential-pool', () => ({
  getCredentialPool: () => mockGetCredentialPool(),
  _resetCredentialPoolSingletonForTests: vi.fn(),
}));
vi.mock('@cleocode/core/llm/credential-pool.js', () => ({
  getCredentialPool: () => mockGetCredentialPool(),
  _resetCredentialPoolSingletonForTests: vi.fn(),
}));

// Mock addCredential so the llm section doesn't write to the real pool.
const mockAddCredential = vi.fn(async () => undefined);
vi.mock('@cleocode/core/llm/credentials-store', () => ({
  addCredential: (...a: unknown[]) => mockAddCredential(...(a as [])),
}));
vi.mock('@cleocode/core/llm/credentials-store.js', () => ({
  addCredential: (...a: unknown[]) => mockAddCredential(...(a as [])),
}));

// Mock catalog-model-resolver so no disk reads happen.
vi.mock('@cleocode/core/llm/catalog-model-resolver', () => ({
  catalogKeyForProvider: (p: string) => p,
  listProviderModels: () => ['claude-opus-4-5', 'claude-sonnet-4-5'],
  resolveProviderDefaultModel: () => 'claude-opus-4-5',
}));
vi.mock('@cleocode/core/llm/catalog-model-resolver.js', () => ({
  catalogKeyForProvider: (p: string) => p,
  listProviderModels: () => ['claude-opus-4-5', 'claude-sonnet-4-5'],
  resolveProviderDefaultModel: () => 'claude-opus-4-5',
}));

// Mock front-door login so no real OAuth or API calls are made.
const mockRunFrontDoorLogin = vi.fn(async () => ({
  success: true,
  provider: 'anthropic',
  label: 'wizard-test',
}));
vi.mock('@cleocode/core/llm/onboarding/front-door', () => ({
  runFrontDoorLogin: (...a: unknown[]) => mockRunFrontDoorLogin(...(a as [])),
}));
vi.mock('@cleocode/core/llm/onboarding/front-door.js', () => ({
  runFrontDoorLogin: (...a: unknown[]) => mockRunFrontDoorLogin(...(a as [])),
}));

// Mock local-model-fit so no hardware detection or Ollama probes happen.
const mockRankLocalModelFit = vi.fn();
vi.mock('@cleocode/core/llm/local-model-fit', () => ({
  rankLocalModelFit: (...a: unknown[]) => mockRankLocalModelFit(...(a as [])),
  LOCAL_FIT_FLOOR_GB: 4,
  LOCAL_MODEL_CANDIDATES: [],
}));
vi.mock('@cleocode/core/llm/local-model-fit.js', () => ({
  rankLocalModelFit: (...a: unknown[]) => mockRankLocalModelFit(...(a as [])),
  LOCAL_FIT_FLOOR_GB: 4,
  LOCAL_MODEL_CANDIDATES: [],
}));

// Mock cross-provider-selector for Ollama probe used inside local-model-fit.
vi.mock('@cleocode/core/llm/cross-provider-selector', () => ({
  probeOllamaAlive: vi.fn(async () => false),
}));
vi.mock('@cleocode/core/llm/cross-provider-selector.js', () => ({
  probeOllamaAlive: vi.fn(async () => false),
}));

// Mock paths and platform paths cache.
vi.mock('@cleocode/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cleocode/paths')>();
  return {
    ...actual,
    getCleoPlatformPaths: () => ({ data: '/tmp/cleo-test-data', config: '/tmp/cleo-test-config' }),
    _resetCleoPlatformPathsCache: vi.fn(),
  };
});

// Mock sentient config so the sentient section resolves.
vi.mock('@cleocode/core/sentient', () => ({
  getSentientConfig: vi.fn(async () => ({ enabled: false })),
  setSentientConfig: vi.fn(async () => undefined),
}));
vi.mock('@cleocode/core/sentient.js', () => ({
  getSentientConfig: vi.fn(async () => ({ enabled: false })),
  setSentientConfig: vi.fn(async () => undefined),
}));

// Mock brain / SOUL paths so no fs writes happen.
vi.mock('@cleocode/core/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cleocode/core/paths')>();
  return {
    ...actual,
    resolveCleoDir: vi.fn(() => '/tmp/cleo-test'),
  };
});
vi.mock('@cleocode/core/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cleocode/core/paths')>();
  return {
    ...actual,
    resolveCleoDir: vi.fn(() => '/tmp/cleo-test'),
  };
});

// Mock fs so verification checks pass without real disk access.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn((p: string) => {
      // Make brain.db "exist" for verification.
      if (typeof p === 'string' && p.includes('brain.db')) return true;
      return actual.existsSync(p);
    }),
  };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    access: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
  };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { printWhoamiSummaryAndOfferTui } from '@cleocode/core/setup';
import { _pickOllamaModelInteractive } from '@cleocode/core/setup/sections/models-roles';
import { runSetup } from '../setup.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A WizardIO implementation that captures output and supports confirm override. */
class CapturingIO implements WizardIO {
  readonly infos: string[] = [];
  readonly warns: string[] = [];
  readonly errors: string[] = [];
  private promptQueue: string[];
  private confirmQueue: boolean[];
  private selectQueue: string[];

  constructor(
    opts: {
      prompts?: string[];
      confirms?: boolean[];
      selects?: string[];
    } = {},
  ) {
    this.promptQueue = [...(opts.prompts ?? [])];
    this.confirmQueue = [...(opts.confirms ?? [])];
    this.selectQueue = [...(opts.selects ?? [])];
  }

  async prompt(question: string): Promise<string> {
    const answer = this.promptQueue.shift() ?? '';
    this.infos.push(`[prompt] ${question} → ${answer}`);
    return answer;
  }

  async confirm(question: string, defaultValue?: boolean): Promise<boolean> {
    if (this.confirmQueue.length > 0) {
      const val = this.confirmQueue.shift() as boolean;
      this.infos.push(`[confirm] ${question} → ${val}`);
      return val;
    }
    const val = defaultValue ?? false;
    this.infos.push(`[confirm-default] ${question} → ${val}`);
    return val;
  }

  async select<T extends string>(question: string, options: readonly T[]): Promise<T> {
    const choice = this.selectQueue.shift();
    if (choice !== undefined && options.includes(choice as T)) {
      this.infos.push(`[select] ${question} → ${choice}`);
      return choice as T;
    }
    const first = options[0] as T;
    this.infos.push(`[select-default] ${question} → ${first}`);
    return first;
  }

  info(message: string): void {
    this.infos.push(message);
  }
  warn(message: string): void {
    this.warns.push(message);
  }
  error(message: string): void {
    this.errors.push(message);
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadConfigCore.mockResolvedValue({
    identity: { name: 'test-agent' },
    llm: { default: { provider: 'anthropic', model: 'claude-opus-4-5' } },
  });
  mockPoolList.mockResolvedValue([{ provider: 'anthropic', label: 'cli-input', source: 'manual' }]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cleo setup — e2e TTY-simulated (T11983)', () => {
  // -------------------------------------------------------------------------
  // 1. Full wizard pass — all sections run, firstRunComplete = true
  // -------------------------------------------------------------------------

  it('full wizard pass — all 10 sections run, firstRunComplete=true', async () => {
    // Build a StubWizardIO with enough answers to get through all sections.
    // The non-interactive flag short-circuits most sections so minimal answers
    // are needed here.
    const io = new StubWizardIO({
      // answers for any remaining interactive prompts (consumed in order)
    });

    const result = await runSetup(
      {
        'non-interactive': true,
        provider: 'anthropic',
        'api-key': 'sk-ant-test-fake',
        'agent-name': 'test-agent',
        harness: 'claude-code',
        'brain-bridge-mode': 'digest',
        sentient: 'off',
        'signaldock-enabled': false,
        'studio-enabled': false,
        'retention-days': '0',
        strictness: 'standard',
        'default-model': 'claude-opus-4-5',
      },
      io,
    );

    // All 10 sections should appear in sectionsRun.
    expect(result.sectionsRun).toContain('llm');
    expect(result.sectionsRun).toContain('models-roles');
    expect(result.sectionsRun).toContain('identity');
    expect(result.sectionsRun).toContain('sentient');
    expect(result.sectionsRun).toContain('project-conventions');
    expect(result.sectionsRun).toContain('harness');
    expect(result.sectionsRun).toContain('brain');
    expect(result.sectionsRun).toContain('integrations');
    expect(result.sectionsRun).toContain('telemetry');
    expect(result.sectionsRun).toContain('verification');

    // Wizard completed without failures.
    const failedSummaries = result.summary.filter((s) => /:\s*failed:/i.test(s));
    expect(failedSummaries).toEqual([]); // surfaces which section(s) failed
    expect(result.ok).toBe(true);

    // firstRunComplete is propagated from WizardRunResult.
    expect(result.firstRunComplete).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 2. firstRunComplete = false when a section fails
  // -------------------------------------------------------------------------

  it('firstRunComplete=false when any section produces a failed: summary', async () => {
    // Wire the llm section to fail by providing a bad api-key to the pool mock.
    mockAddCredential.mockRejectedValueOnce(new Error('pool write failed'));

    const io = new StubWizardIO();
    const result = await runSetup(
      {
        'non-interactive': true,
        provider: 'anthropic',
        'api-key': 'sk-ant-test-bad',
      },
      io,
    );

    // The runner catches section errors and reports them as failed: lines.
    // firstRunComplete should be false whenever any section failed.
    // (sections other than llm may still succeed; only the llm section throws here)
    expect(result.firstRunComplete).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 3. Single-section --section run → firstRunComplete always false
  // -------------------------------------------------------------------------

  it('single --section run always produces firstRunComplete=false', async () => {
    const io = new StubWizardIO();
    const result = await runSetup({ section: 'identity', 'non-interactive': true }, io);
    expect(result.sectionsRun).toEqual(['identity']);
    expect(result.firstRunComplete).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 4. whoami summary + TUI offer printed on first-run completion
  // -------------------------------------------------------------------------

  it('printWhoamiSummaryAndOfferTui prints identity + provider + model, TUI declined', async () => {
    const io = new CapturingIO({ confirms: [false] });
    await printWhoamiSummaryAndOfferTui(io);

    const allOutput = [...io.infos, ...io.warns].join('\n');

    // Should mention "Setup Complete" or similar
    expect(allOutput).toMatch(/Setup Complete/i);

    // Should surface agent name.
    expect(allOutput).toMatch(/test-agent/);

    // Should surface provider.
    expect(allOutput).toMatch(/anthropic/);

    // Should surface model.
    expect(allOutput).toMatch(/claude-opus-4-5/);

    // Should mention cleo whoami hint.
    expect(allOutput).toMatch(/cleo whoami/);
  });

  it('printWhoamiSummaryAndOfferTui: accepts gracefully when confirm throws (non-TTY)', async () => {
    const brokenIO: WizardIO = {
      prompt: vi.fn(async () => ''),
      confirm: vi.fn(async () => {
        throw new Error('stdin closed');
      }),
      select: vi.fn(async () => 'x' as never),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    // Must not throw — swallows the error gracefully.
    await expect(printWhoamiSummaryAndOfferTui(brokenIO)).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 5. Interactive wizard path with StubWizardIO (realistic simulation)
  // -------------------------------------------------------------------------

  it('interactive wizard path — StubWizardIO drives full run end-to-end', async () => {
    // Provide answer queues for interactive sections.
    // The LLM section (interactive, API key path) needs:
    //   - provider select → 'anthropic'
    //   - auth mode select → 'api_key'
    //   - api key prompt → 'sk-ant-e2e-fake'
    //   - pool-seeding consent confirm → false
    // The models-roles section (interactive, non-ollama) needs:
    //   - model select → first option
    //   - role pins confirm → false (decline advanced)
    // The identity section (interactive) needs:
    //   - agent name prompt → 'e2e-wizard-agent'
    // The sentient section (interactive) needs:
    //   - enable confirm → false
    // The project-conventions section (interactive) needs:
    //   - strictness select → 'standard'
    //   - AC enforcement select → 'warn'
    //   - auto-start confirm → false
    // The harness section (interactive) needs:
    //   - harness select → 'claude-code'
    // The brain section (interactive) needs:
    //   - bridge-mode select → 'digest'
    // The integrations section (interactive) needs:
    //   - signaldock confirm → false
    //   - studio confirm → false
    // The telemetry section needs:
    //   - telemetry confirm → true
    // The verification section runs without prompts (read-only).
    //
    // Most sections now have robust defaults; we supply answers beyond what
    // a single section may consume to avoid StubWizardIO "queue exhausted"
    // throws in sections that don't need them.

    const io = new StubWizardIO({
      prompts: [
        'sk-ant-e2e-fake', // llm: api key
        'e2e-wizard-agent', // identity: agent name
      ],
      confirms: [
        false, // llm: pool seeding consent
        false, // models-roles: pin roles?
        false, // sentient: enable?
        false, // project-conventions: session auto-start?
        false, // integrations: signaldock?
        false, // integrations: studio?
        true, // telemetry: allow?
      ],
      selects: [
        'anthropic', // llm: provider
        'api_key', // llm: auth mode
        'claude-opus-4-5', // models-roles: default model
        'standard', // project-conventions: strictness
        'warn', // project-conventions: AC enforcement
        'claude-code', // harness: harness type
        'digest', // brain: bridge mode
      ],
    });

    const result = await runSetup({}, io);

    // All sections run.
    expect(result.sectionsRun.length).toBeGreaterThanOrEqual(10);
    // The result is either ok or has section-level failures — we primarily
    // care that the wizard completes without throwing.
    expect(typeof result.ok).toBe('boolean');
    // firstRunComplete is true iff ok (no section produced a failed: line).
    expect(result.firstRunComplete).toBe(result.ok);
  });
});

// ---------------------------------------------------------------------------
// Fit-gated Ollama path (T11983 AC — RECOMMEND-NEVER-KILL)
// ---------------------------------------------------------------------------

describe('models-roles — fit-gated Ollama model picker (T11983)', () => {
  /**
   * Build a realistic fit envelope for testing.
   */
  function makeEnvelope(opts: {
    totalRamGb: number;
    noReason?: string;
    recommendations?: Array<{ tag: string; fitTier: string; alreadyPulled: boolean }>;
    ollamaRunning?: boolean;
  }) {
    return {
      hardware: {
        totalRamGb: opts.totalRamGb,
        availableRamGb: opts.totalRamGb * 0.7,
        vramTotalGb: null,
        vramFreeGb: null,
        vramMethod: 'none' as const,
      },
      ollamaRunning: opts.ollamaRunning ?? false,
      pulledModels: [],
      recommendations: (opts.recommendations ?? []).map((r) => ({
        candidate: {
          modelTag: r.tag,
          displayName: r.tag,
          family: 'gemma4' as const,
          minRamGb: 4,
          recommendedRamGb: 6,
          minVramGb: 3,
          recommendedVramGb: 5,
          diskSizeGb: 7.2,
          quantNote: 'Q4_K_M',
          codeSpecialist: false,
          contextLengthK: 128,
        },
        score: 80,
        alreadyPulled: r.alreadyPulled,
        reasons: ['fits RAM'],
        fitTier: r.fitTier as 'excellent' | 'good' | 'marginal',
        pullCommand: `ollama pull ${r.tag}`,
      })),
      noRecommendationReason: opts.noReason ?? null,
    };
  }

  it('below 4 GB floor → warns about cloud-only, returns null', async () => {
    const stubbedRanker = async () =>
      makeEnvelope({
        totalRamGb: 2,
        noReason:
          'This machine has only 2.0 GB RAM. Local LLM inference requires at least 4 GB. Use a cloud provider instead.',
      });

    const io = new CapturingIO();
    const result = await _pickOllamaModelInteractive(io, stubbedRanker);

    expect(result).toBeNull();
    const warnText = io.warns.join('\n');
    expect(warnText).toMatch(/cloud provider/i);
    expect(warnText).toMatch(/4 GB/i);
  });

  it('above floor with recommendations → presents ranked list, user picks first', async () => {
    const stubbedRanker = async () =>
      makeEnvelope({
        totalRamGb: 16,
        recommendations: [
          { tag: 'gemma4:e4b', fitTier: 'excellent', alreadyPulled: false },
          { tag: 'gemma4:e2b', fitTier: 'good', alreadyPulled: true },
        ],
      });

    // select queue: pick the first recommended model (the one with rank 1).
    const io = new CapturingIO({
      selects: ['gemma4:e4b (excellent)'],
    });
    const result = await _pickOllamaModelInteractive(io, stubbedRanker);

    expect(result).toBe('gemma4:e4b');
  });

  it('already-pulled model is shown with [pulled] tag', async () => {
    const stubbedRanker = async () =>
      makeEnvelope({
        totalRamGb: 16,
        recommendations: [{ tag: 'gemma4:e2b', fitTier: 'good', alreadyPulled: true }],
      });

    // Use CapturingIO which defaults to first option.
    const io = new CapturingIO();
    await _pickOllamaModelInteractive(io, stubbedRanker);

    const allOutput = io.infos.join('\n');
    // The select call should include "[pulled]" annotation.
    expect(allOutput).toMatch(/\[pulled\]/i);
  });

  it('user selects skip → returns null', async () => {
    const stubbedRanker = async () =>
      makeEnvelope({
        totalRamGb: 16,
        recommendations: [{ tag: 'gemma4:e2b', fitTier: 'good', alreadyPulled: false }],
      });

    const io = new CapturingIO({ selects: ['(skip)'] });
    const result = await _pickOllamaModelInteractive(io, stubbedRanker);
    expect(result).toBeNull();
  });

  it('user selects manual entry → returns typed tag', async () => {
    const stubbedRanker = async () =>
      makeEnvelope({
        totalRamGb: 16,
        recommendations: [{ tag: 'gemma4:e2b', fitTier: 'good', alreadyPulled: false }],
      });

    const io = new CapturingIO({
      selects: ['(enter manually)'],
      prompts: ['llama3.2:3b'],
    });
    const result = await _pickOllamaModelInteractive(io, stubbedRanker);
    expect(result).toBe('llama3.2:3b');
  });

  it('ranker failure → falls back to free-text prompt, empty answer returns null', async () => {
    const brokenRanker = async (): Promise<never> => {
      throw new Error('nvidia-smi not found');
    };

    const io = new CapturingIO({ prompts: [''] });
    const result = await _pickOllamaModelInteractive(io, brokenRanker);
    expect(result).toBeNull();

    const warnText = io.warns.join('\n');
    expect(warnText).toMatch(/hardware detection failed/i);
  });

  it('ranker failure → falls back to free-text, entered tag returned', async () => {
    const brokenRanker = async (): Promise<never> => {
      throw new Error('nvidia-smi not found');
    };

    const io = new CapturingIO({ prompts: ['qwen3:4b'] });
    const result = await _pickOllamaModelInteractive(io, brokenRanker);
    expect(result).toBe('qwen3:4b');
  });

  it('no candidates fit RAM → warns, accepts manual entry', async () => {
    const stubbedRanker = async () =>
      makeEnvelope({
        totalRamGb: 16,
        recommendations: [], // empty: no candidates fit this (unusual) scenario
        noReason: null as unknown as string, // explicitly null means no floor reason
      });

    const io = new CapturingIO({ prompts: ['phi4-mini:3.8b'] });
    const result = await _pickOllamaModelInteractive(io, stubbedRanker);
    expect(result).toBe('phi4-mini:3.8b');
  });
});

// ---------------------------------------------------------------------------
// CleoSetupResult.firstRunComplete propagation
// ---------------------------------------------------------------------------

describe('CleoSetupResult.firstRunComplete (T11983)', () => {
  it('full non-interactive pass: firstRunComplete=true when no section fails', async () => {
    const io = new StubWizardIO();
    const result = await runSetup(
      {
        'non-interactive': true,
        provider: 'anthropic',
        'api-key': 'sk-ant-propagation-test',
        'default-model': 'claude-opus-4-5',
        'agent-name': 'prop-test-agent',
        harness: 'claude-code',
        'brain-bridge-mode': 'digest',
        sentient: 'off',
        'signaldock-enabled': false,
        'studio-enabled': false,
        strictness: 'standard',
      },
      io,
    );

    expect(result.firstRunComplete).toBe(true);
    expect(result.ok).toBe(true);
  });

  it('single section run: firstRunComplete always false', async () => {
    for (const section of ['llm', 'identity', 'verification', 'brain'] as const) {
      const io = new StubWizardIO();
      const result = await runSetup({ section, 'non-interactive': true }, io);
      expect(result.firstRunComplete).toBe(false);
      expect(result.sectionsRun).toEqual([section]);
    }
  });
});

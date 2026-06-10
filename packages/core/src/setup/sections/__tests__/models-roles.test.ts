/**
 * Unit tests for the `models-roles` wizard section (T11726 · M3).
 *
 * Drives the section with a {@link StubWizardIO} across both the interactive
 * and `--config-json` (non-interactive) paths (AC5), and asserts the
 * idempotency guard (AC4) and the short-circuit-when-empty contract (AC3).
 *
 * The config writer + catalog reader are mocked so the test never touches the
 * real global config file or the models.dev disk cache.
 *
 * @task T11726
 * @epic T11671
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared BEFORE importing the section.
// ---------------------------------------------------------------------------

const mockSetConfigValue = vi.fn(async () => undefined);
const mockLoadConfig = vi.fn(async () => ({ llm: undefined }) as { llm?: unknown });

vi.mock('../../../config.js', () => ({
  setConfigValue: (...a: unknown[]) => mockSetConfigValue(...(a as [])),
  loadConfig: () => mockLoadConfig(),
}));

const mockListProviderModels = vi.fn(() => ['m-newest', 'm-older']);
const mockResolveDefault = vi.fn(() => 'm-newest');

vi.mock('../../../llm/catalog-model-resolver.js', () => ({
  catalogKeyForProvider: (p: string) => p,
  listProviderModels: (...a: unknown[]) => mockListProviderModels(...(a as [])),
  resolveProviderDefaultModel: (...a: unknown[]) => mockResolveDefault(...(a as [])),
}));

import { StubWizardIO } from '../../wizard.js';
import { createModelsRolesSection } from '../models-roles.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('models-roles wizard section (T11726)', () => {
  beforeEach(() => {
    mockSetConfigValue.mockClear();
    mockLoadConfig.mockReset();
    mockLoadConfig.mockResolvedValue({ llm: undefined });
    mockListProviderModels.mockClear();
    mockListProviderModels.mockReturnValue(['m-newest', 'm-older']);
    mockResolveDefault.mockClear();
  });

  it('exports a section with id "models-roles"', () => {
    expect(createModelsRolesSection().section).toBe('models-roles');
  });

  it('AC4 — isConfigured() is true when a default model already exists', async () => {
    mockLoadConfig.mockResolvedValue({ llm: { default: { provider: 'anthropic', model: 'x' } } });
    const section = createModelsRolesSection();
    expect(await section.isConfigured?.({})).toBe(true);
  });

  it('AC4 — isConfigured() is true when any role binding already exists', async () => {
    mockLoadConfig.mockResolvedValue({ llm: { roles: { extraction: { provider: 'anthropic' } } } });
    const section = createModelsRolesSection();
    expect(await section.isConfigured?.({})).toBe(true);
  });

  it('AC4 — isConfigured() is false on a fresh config', async () => {
    const section = createModelsRolesSection();
    expect(await section.isConfigured?.({})).toBe(false);
  });

  it('AC3 — --config-json (non-interactive) writes default model + role bindings', async () => {
    const section = createModelsRolesSection();
    const io = new StubWizardIO();
    const result = await section.run(io, {
      nonInteractive: true,
      provider: 'anthropic',
      defaultModel: 'm-newest',
      roleBindings: {
        extraction: { provider: 'anthropic', model: 'm-older' },
        // Unknown role is ignored, not an error.
        bogus: { provider: 'anthropic' },
      },
    });

    expect(result.changed).toBe(true);
    // default model + default provider written
    expect(mockSetConfigValue).toHaveBeenCalledWith('llm.default.model', 'm-newest', undefined, {
      global: true,
    });
    // role binding written for the valid role only
    expect(mockSetConfigValue).toHaveBeenCalledWith(
      'llm.roles.extraction.provider',
      'anthropic',
      undefined,
      { global: true },
    );
    expect(mockSetConfigValue).toHaveBeenCalledWith(
      'llm.roles.extraction.model',
      'm-older',
      undefined,
      { global: true },
    );
    // bogus role never written
    expect(mockSetConfigValue).not.toHaveBeenCalledWith(
      'llm.roles.bogus.provider',
      expect.anything(),
      undefined,
      expect.anything(),
    );
  });

  it('T11725 review: provider-only role binding is completed with the catalog default model', async () => {
    // The role resolver requires BOTH provider AND model (tier 2) — a
    // provider-only binding would be dead config the resolver silently skips,
    // while isConfigured() starts hiding the section. The section must write a
    // COMPLETE binding using the provider's catalog default.
    mockResolveDefault.mockReturnValue('m-newest');
    const section = createModelsRolesSection();
    const io = new StubWizardIO();
    const result = await section.run(io, {
      nonInteractive: true,
      provider: 'anthropic',
      roleBindings: { extraction: { provider: 'anthropic' } },
    });

    expect(result.changed).toBe(true);
    expect(mockSetConfigValue).toHaveBeenCalledWith(
      'llm.roles.extraction.model',
      'm-newest',
      undefined,
      { global: true },
    );
    expect(result.summary).toContain('extraction → anthropic/m-newest');
  });

  it('T11725 review: provider-only binding with NO catalog default is skipped with a warning (never half-written)', async () => {
    mockResolveDefault.mockReturnValue(null as never);
    const section = createModelsRolesSection();
    const io = new StubWizardIO();
    const result = await section.run(io, {
      nonInteractive: true,
      provider: 'anthropic',
      roleBindings: { extraction: { provider: 'mystery-provider' } },
    });

    expect(result.changed).toBe(false);
    expect(mockSetConfigValue).not.toHaveBeenCalledWith(
      'llm.roles.extraction.provider',
      expect.anything(),
      undefined,
      expect.anything(),
    );
  });

  it('AC3 — non-interactive short-circuits cleanly when no inputs supplied', async () => {
    const section = createModelsRolesSection();
    const io = new StubWizardIO();
    const result = await section.run(io, { nonInteractive: true, provider: 'anthropic' });
    expect(result.changed).toBe(false);
    expect(result.summary).toMatch(/skipped/);
    expect(mockSetConfigValue).not.toHaveBeenCalled();
  });

  it('AC2/AC5 — interactive path picks a default model + skips role pinning', async () => {
    const section = createModelsRolesSection();
    // Provider comes from options; pick the first model, decline per-role pinning.
    const io = new StubWizardIO({ selects: ['m-newest'], confirms: [false] });
    const result = await section.run(io, { provider: 'anthropic' });

    expect(result.changed).toBe(true);
    expect(mockSetConfigValue).toHaveBeenCalledWith('llm.default.model', 'm-newest', undefined, {
      global: true,
    });
  });

  it('AC2 — interactive path pins per-role profiles when confirmed', async () => {
    const section = createModelsRolesSection();
    // default model select, confirm pinning, then one select per role (5 roles).
    const io = new StubWizardIO({
      selects: ['m-newest', 'm-newest', 'm-older', 'm-newest', 'm-older', 'm-newest'],
      confirms: [true],
    });
    const result = await section.run(io, { provider: 'anthropic' });

    expect(result.changed).toBe(true);
    // At least one role binding written.
    expect(mockSetConfigValue).toHaveBeenCalledWith(
      'llm.roles.extraction.provider',
      'anthropic',
      undefined,
      { global: true },
    );
  });

  it('short-circuits interactively when no provider is configured', async () => {
    const section = createModelsRolesSection();
    const io = new StubWizardIO();
    const result = await section.run(io, {});
    expect(result.changed).toBe(false);
    expect(result.summary).toMatch(/no provider/);
  });
});

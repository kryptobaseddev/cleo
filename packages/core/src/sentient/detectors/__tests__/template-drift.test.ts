/**
 * Tests for the template-drift detector (T9895).
 *
 * Coverage:
 *   - detectTemplateDrift: drift detected on overwrite-on-bump entry → 1 P3 proposal
 *   - detectTemplateDrift: manifest-merge drift also detected
 *   - detectTemplateDrift: immutable entries always skipped (even when drifted)
 *   - detectTemplateDrift: diff-prompt entries skipped (interactive flow owns reconcile)
 *   - detectTemplateDrift: uninstalled entries skipped (no proposal)
 *   - detectTemplateDrift: empty manifest → empty array
 *   - detectTemplateDrift: in-sync content → empty array
 *   - detectTemplateDrift: registry throws → empty array (best-effort, no rethrow)
 *   - safeRunTemplateDriftScan: kill-switch blocks generation
 *   - safeRunTemplateDriftScan: tier2Enabled=false marks outcome 'disabled'
 *   - safeRunTemplateDriftScan: detector throwing surfaces 'error' outcome
 *   - safeRunTemplateDriftScan: no-drift outcome when detector returns empty
 *
 * Tests mock `../../../templates/registry.js` so the detector can be
 * exercised without a real monorepo checkout on disk.
 *
 * @task T9895
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../templates/registry.js', () => ({
  getTemplateManifest: vi.fn(),
  getInstalledStatus: vi.fn(),
  resolveSourcePathAbsolute: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

import { existsSync, readFileSync } from 'node:fs';
import type { TemplateManifestEntry, UpdateStrategy } from '@cleocode/contracts';
import {
  getInstalledStatus,
  getTemplateManifest,
  resolveSourcePathAbsolute,
} from '../../../templates/registry.js';
import {
  detectTemplateDrift,
  safeRunTemplateDriftScan,
  TEMPLATE_REFRESH_KIND,
} from '../template-drift.js';

const mockGetTemplateManifest = getTemplateManifest as unknown as ReturnType<typeof vi.fn>;
const mockGetInstalledStatus = getInstalledStatus as unknown as ReturnType<typeof vi.fn>;
const mockResolveSourcePathAbsolute = resolveSourcePathAbsolute as unknown as ReturnType<
  typeof vi.fn
>;
const mockExistsSync = existsSync as unknown as ReturnType<typeof vi.fn>;
const mockReadFileSync = readFileSync as unknown as ReturnType<typeof vi.fn>;

const PROJECT_ROOT = '/tmp/cleo-test-project-root';
const STATE_PATH = '/tmp/cleo-test-sentient-state.json';

/**
 * Build a minimal TemplateManifestEntry sufficient for the detector.
 * `kind` and `substitution` use safe defaults — they do not influence
 * drift detection logic.
 */
function makeEntry(id: string, updateStrategy: UpdateStrategy): TemplateManifestEntry {
  return {
    id,
    kind: 'workflow',
    sourcePath: `packages/core/templates/${id}.tmpl`,
    installPath: `.github/${id}`,
    substitution: 'static',
    placeholders: [],
    updateStrategy,
  };
}

/**
 * Configure registry mocks for a per-entry installed/source-content scenario.
 *
 * Each scenario entry declares whether the file is installed and what the
 * source vs installed content looks like. Drift is detected when both
 * strings are non-equal AND `installed === true`.
 */
function arrangeFiles(
  scenarios: Array<{
    entry: TemplateManifestEntry;
    installed: boolean;
    source: string;
    installedContent: string;
    sourceExists?: boolean;
  }>,
): void {
  mockGetTemplateManifest.mockReturnValue(scenarios.map((s) => s.entry));

  mockGetInstalledStatus.mockImplementation((id: string, _root: string) => {
    const found = scenarios.find((s) => s.entry.id === id);
    if (!found) throw new Error(`unknown id ${id}`);
    return { installed: found.installed, path: `${PROJECT_ROOT}/${found.entry.installPath}` };
  });

  mockResolveSourcePathAbsolute.mockImplementation((entry: TemplateManifestEntry) => {
    const found = scenarios.find((s) => s.entry.id === entry.id);
    if (!found) throw new Error(`unknown id ${entry.id}`);
    return `/abs/${found.entry.sourcePath}`;
  });

  mockExistsSync.mockImplementation((path: unknown) => {
    if (typeof path !== 'string') return false;
    if (path.startsWith('/abs/')) {
      const found = scenarios.find((s) => path === `/abs/${s.entry.sourcePath}`);
      return found ? (found.sourceExists ?? true) : false;
    }
    return false;
  });

  mockReadFileSync.mockImplementation((path: unknown) => {
    if (typeof path !== 'string') throw new Error('non-string path');
    if (path.startsWith('/abs/')) {
      const found = scenarios.find((s) => path === `/abs/${s.entry.sourcePath}`);
      if (!found) throw new Error(`no source for ${path}`);
      return found.source;
    }
    const found = scenarios.find((s) => path === `${PROJECT_ROOT}/${s.entry.installPath}`);
    if (!found) throw new Error(`no installed for ${path}`);
    return found.installedContent;
  });
}

beforeEach(() => {
  mockGetTemplateManifest.mockReset();
  mockGetInstalledStatus.mockReset();
  mockResolveSourcePathAbsolute.mockReset();
  mockExistsSync.mockReset();
  mockReadFileSync.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('detectTemplateDrift', () => {
  it('returns one P3 proposal per drifted overwrite-on-bump entry', async () => {
    arrangeFiles([
      {
        entry: makeEntry('ci.yml', 'overwrite-on-bump'),
        installed: true,
        source: 'name: CI\n',
        installedContent: 'name: CI-OLD\n',
      },
    ]);

    const proposals = await detectTemplateDrift(PROJECT_ROOT);

    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.kind).toBe(TEMPLATE_REFRESH_KIND);
    expect(proposals[0]?.severity).toBe('P3');
    expect(proposals[0]?.id).toBe('prop-template-drift-ci.yml');
    expect(proposals[0]?.title).toContain('ci.yml');
    expect(proposals[0]?.fixAction).toBe('cleo templates upgrade ci.yml');
    expect(proposals[0]?.reason).toContain('overwrite-on-bump');
    expect(proposals[0]?.reason).toContain('.github/ci.yml');
  });

  it('detects drift on manifest-merge entries as well', async () => {
    arrangeFiles([
      {
        entry: makeEntry('tsconfig.json', 'manifest-merge'),
        installed: true,
        source: '{"strict":true}',
        installedContent: '{"strict":false}',
      },
    ]);

    const proposals = await detectTemplateDrift(PROJECT_ROOT);

    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.id).toBe('prop-template-drift-tsconfig.json');
    expect(proposals[0]?.reason).toContain('manifest-merge');
  });

  it('skips immutable entries even when content has drifted', async () => {
    arrangeFiles([
      {
        entry: makeEntry('locked.yml', 'immutable'),
        installed: true,
        source: 'A',
        installedContent: 'B',
      },
    ]);

    const proposals = await detectTemplateDrift(PROJECT_ROOT);

    expect(proposals).toEqual([]);
  });

  it('skips diff-prompt entries even when drifted (interactive owns reconcile)', async () => {
    arrangeFiles([
      {
        entry: makeEntry('prompted.yml', 'diff-prompt'),
        installed: true,
        source: 'A',
        installedContent: 'B',
      },
    ]);

    const proposals = await detectTemplateDrift(PROJECT_ROOT);

    expect(proposals).toEqual([]);
  });

  it('skips uninstalled entries (no proposal — installation is a separate event)', async () => {
    arrangeFiles([
      {
        entry: makeEntry('not-installed.yml', 'overwrite-on-bump'),
        installed: false,
        source: 'A',
        installedContent: 'B',
      },
    ]);

    const proposals = await detectTemplateDrift(PROJECT_ROOT);

    expect(proposals).toEqual([]);
  });

  it('returns empty array when the manifest is empty', async () => {
    mockGetTemplateManifest.mockReturnValue([]);

    const proposals = await detectTemplateDrift(PROJECT_ROOT);

    expect(proposals).toEqual([]);
  });

  it('returns empty array when installed content matches source byte-for-byte', async () => {
    arrangeFiles([
      {
        entry: makeEntry('ci.yml', 'overwrite-on-bump'),
        installed: true,
        source: 'identical-content\n',
        installedContent: 'identical-content\n',
      },
    ]);

    const proposals = await detectTemplateDrift(PROJECT_ROOT);

    expect(proposals).toEqual([]);
  });

  it('returns empty array when the registry throws (best-effort — never rethrows)', async () => {
    mockGetTemplateManifest.mockImplementation(() => {
      throw new Error('registry blew up');
    });

    await expect(detectTemplateDrift(PROJECT_ROOT)).resolves.toEqual([]);
  });

  it('processes a mixed manifest: 1 drifted refreshable + 1 in-sync + 1 immutable-drifted + 1 uninstalled', async () => {
    arrangeFiles([
      {
        entry: makeEntry('a-drifted.yml', 'overwrite-on-bump'),
        installed: true,
        source: 'A1',
        installedContent: 'A2',
      },
      {
        entry: makeEntry('b-insync.yml', 'overwrite-on-bump'),
        installed: true,
        source: 'B',
        installedContent: 'B',
      },
      {
        entry: makeEntry('c-locked.yml', 'immutable'),
        installed: true,
        source: 'C1',
        installedContent: 'C2',
      },
      {
        entry: makeEntry('d-uninstalled.yml', 'manifest-merge'),
        installed: false,
        source: 'D1',
        installedContent: 'D2',
      },
    ]);

    const proposals = await detectTemplateDrift(PROJECT_ROOT);

    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.id).toBe('prop-template-drift-a-drifted.yml');
  });
});

describe('safeRunTemplateDriftScan', () => {
  it('returns outcome=killed and generates no proposal when killSwitch is active', async () => {
    const outcome = await safeRunTemplateDriftScan({
      projectRoot: PROJECT_ROOT,
      statePath: STATE_PATH,
      isKilled: async () => true,
      isTier2Enabled: async () => true,
      detect: async () => {
        throw new Error('detector should not run when killed');
      },
    });

    expect(outcome.kind).toBe('killed');
    expect(outcome.proposals).toEqual([]);
  });

  it('returns outcome=disabled (with proposal payload) when tier2Enabled=false', async () => {
    const outcome = await safeRunTemplateDriftScan({
      projectRoot: PROJECT_ROOT,
      statePath: STATE_PATH,
      isKilled: async () => false,
      isTier2Enabled: async () => false,
      detect: async () => [
        {
          id: 'prop-template-drift-x.yml',
          kind: TEMPLATE_REFRESH_KIND,
          title: 'x',
          severity: 'P3',
          fixAction: 'cleo templates upgrade x.yml',
          reason: 'x drifted',
        },
      ],
    });

    expect(outcome.kind).toBe('disabled');
    expect(outcome.proposals).toHaveLength(1);
    expect(outcome.proposals[0]?.severity).toBe('P3');
  });

  it('returns outcome=drifted when proposals exist and tier2 is enabled', async () => {
    const outcome = await safeRunTemplateDriftScan({
      projectRoot: PROJECT_ROOT,
      statePath: STATE_PATH,
      isKilled: async () => false,
      isTier2Enabled: async () => true,
      detect: async () => [
        {
          id: 'prop-template-drift-a.yml',
          kind: TEMPLATE_REFRESH_KIND,
          title: 'a',
          severity: 'P3',
          fixAction: 'cleo templates upgrade a.yml',
          reason: 'a drifted',
        },
        {
          id: 'prop-template-drift-b.yml',
          kind: TEMPLATE_REFRESH_KIND,
          title: 'b',
          severity: 'P3',
          fixAction: 'cleo templates upgrade b.yml',
          reason: 'b drifted',
        },
      ],
    });

    expect(outcome.kind).toBe('drifted');
    expect(outcome.proposals).toHaveLength(2);
    expect(outcome.detail).toContain('2');
  });

  it('returns outcome=no-drift when detector returns empty array', async () => {
    const outcome = await safeRunTemplateDriftScan({
      projectRoot: PROJECT_ROOT,
      statePath: STATE_PATH,
      isKilled: async () => false,
      isTier2Enabled: async () => true,
      detect: async () => [],
    });

    expect(outcome.kind).toBe('no-drift');
    expect(outcome.proposals).toEqual([]);
  });

  it('returns outcome=error when the detector throws (kill-switch + tier2 checks succeed)', async () => {
    const outcome = await safeRunTemplateDriftScan({
      projectRoot: PROJECT_ROOT,
      statePath: STATE_PATH,
      isKilled: async () => false,
      isTier2Enabled: async () => true,
      detect: async () => {
        throw new Error('boom');
      },
    });

    expect(outcome.kind).toBe('error');
    expect(outcome.proposals).toEqual([]);
    expect(outcome.detail).toContain('boom');
  });
});

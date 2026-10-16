/**
 * T13666 — the briefing's codebase map: the nexus map when indexed, "no code
 * index" only when the index is absent, and "code index unreadable" when it
 * exists but cannot be read.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../store/data-accessor.js', () => ({
  getAccessor: vi.fn(),
  getTaskAccessor: vi.fn(),
  createDataAccessor: vi.fn(),
}));
vi.mock('../handoff.js', () => ({ getLastHandoff: vi.fn().mockResolvedValue(null) }));
vi.mock('../../config/registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config/registry.js')>()),
  getConfigValue: vi.fn(async (key: string) => (key === 'lean.map' ? true : undefined)),
}));
const buildNexusBriefMap = vi.fn();
vi.mock('../../nexus/brief-map.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../nexus/brief-map.js')>()),
  buildNexusBriefMap,
}));

import { getAccessor, getTaskAccessor } from '../../store/data-accessor.js';
import { computeBriefing } from '../briefing.js';

function setupMockAccessor(): void {
  const meta: Record<string, unknown> = {
    focus_state: { currentTask: null, currentPhase: null },
    file_meta: { schemaVersion: '2.10.0' },
  };
  const accessor = {
    loadSessions: vi.fn().mockResolvedValue([]),
    getActiveSession: vi.fn().mockResolvedValue(null),
    resolveCurrentSession: vi.fn().mockResolvedValue(null),
    queryTasks: vi.fn().mockResolvedValue({ tasks: [], total: 0 }),
    loadSingleTask: vi.fn().mockResolvedValue(null),
    getMetaValue: vi.fn((key: string) => Promise.resolve(meta[key] ?? null)),
    setMetaValue: vi.fn().mockResolvedValue(undefined),
    loadArchive: vi.fn().mockResolvedValue(null),
    appendLog: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    engine: 'sqlite' as const,
  };
  (getAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(accessor);
  (getTaskAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(accessor);
}

describe('briefing codebase map (T13666)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMockAccessor();
  });

  it('carries the nexus map when the project is indexed', async () => {
    buildNexusBriefMap.mockResolvedValue({ text: 'Codebase map\nsrc/: App' });
    const briefing = await computeBriefing('/fake/project', { scope: 'global' });
    expect(briefing.codebaseMap).toBe('Codebase map\nsrc/: App');
  });

  it('says "no code index" only when the index is absent', async () => {
    buildNexusBriefMap.mockResolvedValue(null);
    const briefing = await computeBriefing('/fake/project', { scope: 'global' });
    expect(briefing.codebaseMap).toBe('no code index; run `cleo nexus analyze`');
  });

  it('reports a present but broken index as unreadable, with the reason', async () => {
    buildNexusBriefMap.mockRejectedValue(new Error('database disk image is malformed'));
    const briefing = await computeBriefing('/fake/project', { scope: 'global' });
    expect(briefing.codebaseMap).toBe('code index unreadable: database disk image is malformed');
  });
});

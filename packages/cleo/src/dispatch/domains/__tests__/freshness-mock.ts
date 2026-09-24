/**
 * Freshness stand-ins for handler tests that replace `@cleocode/core/internal`
 * wholesale (T12316). Graph queries now assess index freshness first; these
 * report a fresh index so each test keeps exercising only its own operation.
 */
import type { GraphIndexFreshness } from '@cleocode/contracts';
import { vi } from 'vitest';

/** A fresh, fully indexed project. */
export const FRESH_INDEX: GraphIndexFreshness = {
  indexed: true,
  status: 'fresh',
  lastIndexedAt: '2026-09-24T00:00:00.000Z',
  fileCount: 1,
  staleFileCount: 0,
  stalePaths: [],
  refreshCommand: 'cleo nexus analyze',
  refreshEstimate: 'none needed',
  checkMs: 0,
};

/** Mock implementations of the freshness exports of `@cleocode/core/internal`. */
export function freshnessMocks() {
  return {
    assessNexusFreshnessForQuery: vi.fn(async () => ({
      freshness: FRESH_INDEX,
      staleFiles: new Set<string>(),
    })),
    discloseNexusFreshness: vi.fn(),
    judgeSymbolFiles: vi.fn(
      (assessment: { freshness: GraphIndexFreshness }) => assessment.freshness,
    ),
    querySymbolFiles: vi.fn((): string[] => []),
    withNexusFreshnessMeta: vi.fn(
      (extensions: Record<string, unknown>, freshness: GraphIndexFreshness) => {
        const current = extensions['_nexus'];
        const nexusMeta = current && typeof current === 'object' ? current : {};
        return {
          ...extensions,
          _nexus: { ...nexusMeta, indexFreshness: freshness.status, freshness },
        };
      },
    ),
  };
}

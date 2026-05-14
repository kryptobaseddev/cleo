/**
 * Unit tests for `getModelContextLength` / `getModelMetadata`.
 *
 * Covers all four resolution tiers:
 *   - Tier 2: curated exact match
 *   - Tier 3: curated alias (date / version suffix stripped)
 *   - Tier 4: default fallback
 *
 * @task T9264
 * @epic T9261 (T-LLM-CRED-CENTRALIZATION Phase 3)
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTEXT_LENGTH,
  getModelContextLength,
  getModelMetadata,
} from '../model-metadata.js';

describe('getModelContextLength', () => {
  it('returns 200000 for claude-haiku-4-5-20251001 (exact curated match)', async () => {
    await expect(getModelContextLength('claude-haiku-4-5-20251001')).resolves.toBe(200_000);
  });

  it('returns 128000 for gpt-4o (exact curated match)', async () => {
    await expect(getModelContextLength('gpt-4o')).resolves.toBe(128_000);
  });

  it('returns 200000 for claude-sonnet-4-6 (exact curated match, no date suffix)', async () => {
    await expect(getModelContextLength('claude-sonnet-4-6')).resolves.toBe(200_000);
  });

  it('returns 200000 for claude-sonnet-4-6-20260101 (alias: date suffix stripped)', async () => {
    // claude-sonnet-4-6-20260101 strips to claude-sonnet-4-6 which is in the curated table
    await expect(getModelContextLength('claude-sonnet-4-6-20260101')).resolves.toBe(200_000);
  });

  it('returns DEFAULT_CONTEXT_LENGTH for an unknown model', async () => {
    await expect(getModelContextLength('unknown-model-xyz')).resolves.toBe(DEFAULT_CONTEXT_LENGTH);
  });

  it('DEFAULT_CONTEXT_LENGTH is 256000', () => {
    expect(DEFAULT_CONTEXT_LENGTH).toBe(256_000);
  });
});

describe('getModelMetadata', () => {
  it('returns source "curated" for an exact curated match', async () => {
    const meta = await getModelMetadata('claude-haiku-4-5-20251001');
    expect(meta.source).toBe('curated');
    expect(meta.contextLength).toBe(200_000);
  });

  it('returns source "curated-alias" for a date-stripped alias', async () => {
    // claude-3-5-sonnet-20300101 strips to claude-3-5-sonnet which is NOT in the table,
    // but claude-3-5-sonnet-20241022 IS — strip the date from that one.
    // Specifically: claude-3-5-sonnet-20300101 → strip -20300101 → claude-3-5-sonnet (not found)
    // So use a model whose base IS in the table: claude-3-5-sonnet-20241022 → strip -20241022 → claude-3-5-sonnet (not found either)
    // Use claude-sonnet-4-6-20300101 → strip -20300101 → claude-sonnet-4-6 (IS in table)
    const meta = await getModelMetadata('claude-sonnet-4-6-20300101');
    expect(meta.source).toBe('curated-alias');
    expect(meta.contextLength).toBe(200_000);
  });

  it('returns source "default" and DEFAULT_CONTEXT_LENGTH for unknown model', async () => {
    const meta = await getModelMetadata('unknown-model-xyz');
    expect(meta.source).toBe('default');
    expect(meta.contextLength).toBe(DEFAULT_CONTEXT_LENGTH);
  });

  it('returns livePending true for curated results (Tier 1 not yet implemented)', async () => {
    const meta = await getModelMetadata('gpt-4o');
    expect(meta.livePending).toBe(true);
  });

  it('returns livePending true for default fallback (Tier 1 not yet implemented)', async () => {
    const meta = await getModelMetadata('nonexistent-model');
    expect(meta.livePending).toBe(true);
  });
});

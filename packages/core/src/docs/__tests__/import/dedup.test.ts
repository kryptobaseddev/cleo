/**
 * dedup unit tests — T9711 (ST-MIG-1c).
 *
 * Covers:
 *   - first import of a sha returns `create`
 *   - second import of the same sha returns `noop` with reason
 *   - `--force` bypass returns `create` even when the sha exists
 *
 * @epic T9628 (Saga T9625)
 * @task T9711
 */

import { describe, expect, it } from 'vitest';
import { decideDedupAction } from '../../import/dedup.js';

describe('decideDedupAction', () => {
  it('returns create when sha is not in the existing set', () => {
    const decision = decideDedupAction({
      contentSha: 'abc123',
      existingShas: new Set(),
    });
    expect(decision).toEqual({ action: 'create', contentSha: 'abc123' });
  });

  it('returns noop with reason when the sha is already stored', () => {
    const decision = decideDedupAction({
      contentSha: 'abc123',
      existingShas: new Set(['abc123']),
    });
    expect(decision).toEqual({
      action: 'noop',
      contentSha: 'abc123',
      reason: 'sha-already-stored',
    });
  });

  it('force=true bypasses dedup and returns create even when sha exists', () => {
    const decision = decideDedupAction({
      contentSha: 'abc123',
      existingShas: new Set(['abc123']),
      force: true,
    });
    expect(decision).toEqual({ action: 'create', contentSha: 'abc123' });
  });

  it('treats identical shas as a hit (no substring matching)', () => {
    const decision = decideDedupAction({
      contentSha: 'abc',
      existingShas: new Set(['abcd']),
    });
    expect(decision.action).toBe('create');
  });
});

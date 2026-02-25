/**
 * Tests for StoreProvider abstraction layer.
 * Verifies SQLite provider creation and detectStoreEngine behavior.
 *
 * @task T4644
 * @task T4854
 * @epic T4638
 */

import { describe, it, expect } from 'vitest';
import { detectStoreEngine } from '../provider.js';

describe('detectStoreEngine', () => {
  it('always returns sqlite (ADR-006 canonical storage)', () => {
    const engine = detectStoreEngine();
    expect(engine).toBe('sqlite');
  });

  it('returns sqlite regardless of cwd argument', () => {
    const engine = detectStoreEngine('/tmp/nonexistent');
    expect(engine).toBe('sqlite');
  });
});

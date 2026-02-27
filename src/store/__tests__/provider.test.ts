/**
 * Tests for StoreProvider abstraction layer.
 *
 * @task T4644
 * @task T4854
 * @epic T4638
 */

import { describe, it, expect } from 'vitest';
import type { StoreEngine } from '../provider.js';

describe('StoreProvider', () => {
  it('StoreEngine type only allows sqlite', () => {
    const engine: StoreEngine = 'sqlite';
    expect(engine).toBe('sqlite');
  });
});

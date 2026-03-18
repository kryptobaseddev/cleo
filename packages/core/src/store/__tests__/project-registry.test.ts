/**
 * Tests for canonical project hash generation (hash.ts).
 * @task T5364
 * @epic T4540
 */

import { describe, expect, it } from 'vitest';
import { generateProjectHash } from '../../core/nexus/hash.js';

describe('generateProjectHash', () => {
  it('should generate a 12-character hex hash', () => {
    const hash = generateProjectHash('/home/user/project');
    expect(hash).toMatch(/^[a-f0-9]{12}$/);
  });

  it('should be deterministic for the same path', () => {
    const hash1 = generateProjectHash('/home/user/project');
    const hash2 = generateProjectHash('/home/user/project');
    expect(hash1).toBe(hash2);
  });

  it('should produce different hashes for different paths', () => {
    const hash1 = generateProjectHash('/home/user/project1');
    const hash2 = generateProjectHash('/home/user/project2');
    expect(hash1).not.toBe(hash2);
  });

  it('should handle empty path', () => {
    const hash = generateProjectHash('');
    expect(hash).toMatch(/^[a-f0-9]{12}$/);
  });
});

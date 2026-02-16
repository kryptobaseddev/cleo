/**
 * Tests for project registry (project-registry.ts).
 * @task T4552
 * @epic T4545
 */

import { describe, it, expect } from 'vitest';
import { generateProjectHash } from '../project-registry.js';

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

  it('should throw on empty path', () => {
    expect(() => generateProjectHash('')).toThrow('Project path required');
  });
});

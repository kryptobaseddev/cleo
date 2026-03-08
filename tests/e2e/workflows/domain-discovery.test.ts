/**
 * E2E Domain Discovery Tests (MCP Spec Section 11.5)
 *
 * Rewritten for the dispatch layer pattern.
 * Tests domain discovery via the registry functions.
 *
 * @task T5203
 * @epic T3125
 */

import { describe, expect, it } from 'vitest';
import { getActiveDomains, getByDomain } from '../../../src/dispatch/registry.js';
import type { CanonicalDomain } from '../../../src/dispatch/types.js';

describe('11.5 Domain Discovery', () => {
  // =========================================================================
  // Test 1: Expose all active domains
  // =========================================================================

  it('should expose all active domains', () => {
    const domains = getActiveDomains();

    // Verify we have the expected domains
    expect(domains).toContain('tasks');
    expect(domains).toContain('session');
    expect(domains).toContain('memory');
    expect(domains).toContain('check');
    expect(domains).toContain('pipeline');
    expect(domains).toContain('orchestrate');
    expect(domains).toContain('tools');
    expect(domains).toContain('admin');
    expect(domains).toContain('nexus');

    // Verify all returned values are valid CanonicalDomain strings
    expect(domains.length).toBeGreaterThan(0);
    domains.forEach((domain) => {
      expect(typeof domain).toBe('string');
      expect(domain.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // Test 2: Operations for each domain
  // =========================================================================

  it('should return operations for each domain', () => {
    // Test tasks domain
    const tasksOps = getByDomain('tasks');
    expect(tasksOps.length).toBeGreaterThan(0);

    // Verify operations have the expected structure
    tasksOps.forEach((op) => {
      expect(op.gateway).toBeDefined();
      expect(op.domain).toBe('tasks');
      expect(op.operation).toBeDefined();
      expect(op.description).toBeDefined();
      expect(op.tier).toBeDefined();
      expect(op.idempotent).toBeDefined();
      expect(op.sessionRequired).toBeDefined();
      expect(op.requiredParams).toBeDefined();
    });

    // Verify that operations include both query and mutate
    const tasksQueryOps = tasksOps.filter((op) => op.gateway === 'query');
    const tasksMutateOps = tasksOps.filter((op) => op.gateway === 'mutate');
    expect(tasksQueryOps.length).toBeGreaterThan(0);
    expect(tasksMutateOps.length).toBeGreaterThan(0);

    // Test session domain as well
    const sessionOps = getByDomain('session');
    expect(sessionOps.length).toBeGreaterThan(0);
    expect(sessionOps.every((op) => op.domain === 'session')).toBe(true);
  });

  // =========================================================================
  // Test 3: Unknown domain returns empty array
  // =========================================================================

  it('should return empty array for unknown domain', () => {
    const unknownOps = getByDomain('nonexistent' as CanonicalDomain);
    expect(unknownOps).toEqual([]);
    expect(unknownOps.length).toBe(0);
  });
});

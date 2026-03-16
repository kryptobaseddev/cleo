import { describe, expect, it } from 'vitest';
import {
  getOperationsByChannel,
  getPreferredChannel,
  getRoutingForDomain,
  ROUTING_TABLE,
} from '../routing-table.js';

describe('routing-table', () => {
  describe('ROUTING_TABLE structure', () => {
    it('has entries for all 10 canonical domains', () => {
      const domains = new Set(ROUTING_TABLE.map((e) => e.domain));
      expect(domains.has('memory')).toBe(true);
      expect(domains.has('tasks')).toBe(true);
      expect(domains.has('session')).toBe(true);
      expect(domains.has('admin')).toBe(true);
      expect(domains.has('tools')).toBe(true);
      expect(domains.has('check')).toBe(true);
      expect(domains.has('pipeline')).toBe(true);
      expect(domains.has('orchestrate')).toBe(true);
      expect(domains.has('nexus')).toBe(true);
      expect(domains.has('sticky')).toBe(true);
    });

    it('every entry has required fields', () => {
      for (const entry of ROUTING_TABLE) {
        expect(entry.domain).toBeTruthy();
        expect(entry.operation).toBeTruthy();
        expect(['mcp', 'cli', 'either']).toContain(entry.preferredChannel);
        expect(entry.reason).toBeTruthy();
      }
    });

    it('has no duplicate domain+operation pairs', () => {
      const keys = ROUTING_TABLE.map((e) => `${e.domain}.${e.operation}`);
      const unique = new Set(keys);
      expect(unique.size).toBe(keys.length);
    });
  });

  describe('getPreferredChannel', () => {
    it('returns mcp for memory.brain.search', () => {
      expect(getPreferredChannel('memory', 'brain.search')).toBe('mcp');
    });

    it('returns cli for pipeline.release.ship', () => {
      expect(getPreferredChannel('pipeline', 'release.ship')).toBe('cli');
    });

    it('returns either for admin.version', () => {
      expect(getPreferredChannel('admin', 'version')).toBe('either');
    });

    it('returns either for unknown operations', () => {
      expect(getPreferredChannel('nonexistent', 'op')).toBe('either');
    });
  });

  describe('getRoutingForDomain', () => {
    it('returns all memory domain entries', () => {
      const entries = getRoutingForDomain('memory');
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every((e) => e.domain === 'memory')).toBe(true);
    });

    it('returns empty array for unknown domain', () => {
      expect(getRoutingForDomain('nonexistent')).toEqual([]);
    });
  });

  describe('getOperationsByChannel', () => {
    it('returns mcp-preferred operations', () => {
      const mcpOps = getOperationsByChannel('mcp');
      expect(mcpOps.length).toBeGreaterThan(0);
      expect(mcpOps.every((e) => e.preferredChannel === 'mcp')).toBe(true);
    });

    it('returns cli-preferred operations', () => {
      const cliOps = getOperationsByChannel('cli');
      expect(cliOps.length).toBeGreaterThan(0);
      expect(cliOps.every((e) => e.preferredChannel === 'cli')).toBe(true);
    });

    it('mcp-preferred operations outnumber cli-preferred', () => {
      const mcpCount = getOperationsByChannel('mcp').length;
      const cliCount = getOperationsByChannel('cli').length;
      expect(mcpCount).toBeGreaterThan(cliCount);
    });
  });
});

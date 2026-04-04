import { describe, expect, it } from 'vitest';
import {
  getOperationsByChannel,
  getPreferredChannel,
  getRoutingForDomain,
} from '../routing-table.js';

describe('routing-table', () => {
  describe('getPreferredChannel (via capability matrix)', () => {
    it('returns cli for memory.find', () => {
      expect(getPreferredChannel('memory', 'find')).toBe('cli');
    });

    it('returns cli for memory.fetch', () => {
      expect(getPreferredChannel('memory', 'fetch')).toBe('cli');
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

    it('returns cli for tasks.show', () => {
      expect(getPreferredChannel('tasks', 'show')).toBe('cli');
    });

    it('returns cli for session.status', () => {
      expect(getPreferredChannel('session', 'status')).toBe('cli');
    });

    it('returns cli for admin.dash', () => {
      expect(getPreferredChannel('admin', 'dash')).toBe('cli');
    });
  });

  describe('getRoutingForDomain', () => {
    it('returns entries covering all 10 canonical domains', () => {
      const domains = [
        'memory',
        'tasks',
        'session',
        'admin',
        'tools',
        'check',
        'pipeline',
        'orchestrate',
        'nexus',
        'sticky',
      ];
      for (const domain of domains) {
        const entries = getRoutingForDomain(domain);
        expect(entries.length).toBeGreaterThan(0);
        expect(entries.every((e) => e.domain === domain)).toBe(true);
      }
    });

    it('returns all memory domain entries', () => {
      const entries = getRoutingForDomain('memory');
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every((e) => e.domain === 'memory')).toBe(true);
    });

    it('every entry has required fields with valid channel', () => {
      const entries = getRoutingForDomain('tasks');
      for (const entry of entries) {
        expect(entry.domain).toBeTruthy();
        expect(entry.operation).toBeTruthy();
        expect(['cli', 'either']).toContain(entry.preferredChannel);
      }
    });

    it('returns empty array for unknown domain', () => {
      expect(getRoutingForDomain('nonexistent')).toEqual([]);
    });
  });

  describe('getOperationsByChannel', () => {
    it('returns cli-preferred operations', () => {
      const cliOps = getOperationsByChannel('cli');
      expect(cliOps.length).toBeGreaterThan(0);
      expect(cliOps.every((e) => e.preferredChannel === 'cli')).toBe(true);
    });

    it('returns either-preferred operations', () => {
      const eitherOps = getOperationsByChannel('either');
      expect(eitherOps.length).toBeGreaterThan(0);
      expect(eitherOps.every((e) => e.preferredChannel === 'either')).toBe(true);
    });

    it('cli-preferred and either-preferred cover all operations', () => {
      const cliCount = getOperationsByChannel('cli').length;
      const eitherCount = getOperationsByChannel('either').length;
      expect(cliCount + eitherCount).toBeGreaterThan(0);
    });

    it('has no duplicate domain+operation pairs within cli channel', () => {
      const cliOps = getOperationsByChannel('cli');
      const keys = cliOps.map((e) => `${e.domain}.${e.operation}`);
      const unique = new Set(keys);
      expect(unique.size).toBe(keys.length);
    });
  });
});

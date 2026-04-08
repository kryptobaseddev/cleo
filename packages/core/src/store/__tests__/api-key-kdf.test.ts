/**
 * Unit tests for api-key-kdf.ts (T349).
 *
 * @task T349
 * @epic T310
 */

import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deriveApiKey, deriveLegacyProjectKey } from '../api-key-kdf.js';

describe('api-key-kdf', () => {
  const machineKey = Buffer.from(
    '0000000000000000000000000000000000000000000000000000000000000001',
    'hex',
  );
  const globalSalt = Buffer.from(
    '1111111111111111111111111111111111111111111111111111111111111111',
    'hex',
  );

  describe('deriveApiKey', () => {
    it('returns a 32-byte Buffer', () => {
      const key = deriveApiKey({ machineKey, globalSalt, agentId: 'agent-1' });
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
    });

    it('is deterministic for identical inputs', () => {
      const k1 = deriveApiKey({ machineKey, globalSalt, agentId: 'agent-1' });
      const k2 = deriveApiKey({ machineKey, globalSalt, agentId: 'agent-1' });
      expect(k2.equals(k1)).toBe(true);
    });

    it('produces different keys for different agentIds', () => {
      const k1 = deriveApiKey({ machineKey, globalSalt, agentId: 'agent-1' });
      const k2 = deriveApiKey({ machineKey, globalSalt, agentId: 'agent-2' });
      expect(k2.equals(k1)).toBe(false);
    });

    it('produces different keys for different machineKeys', () => {
      const otherMachine = randomBytes(32);
      const k1 = deriveApiKey({ machineKey, globalSalt, agentId: 'agent-1' });
      const k2 = deriveApiKey({ machineKey: otherMachine, globalSalt, agentId: 'agent-1' });
      expect(k2.equals(k1)).toBe(false);
    });

    it('produces different keys for different globalSalts', () => {
      const otherSalt = randomBytes(32);
      const k1 = deriveApiKey({ machineKey, globalSalt, agentId: 'agent-1' });
      const k2 = deriveApiKey({ machineKey, globalSalt: otherSalt, agentId: 'agent-1' });
      expect(k2.equals(k1)).toBe(false);
    });

    it('throws on empty machineKey', () => {
      expect(() =>
        deriveApiKey({ machineKey: Buffer.alloc(0), globalSalt, agentId: 'agent-1' }),
      ).toThrow(/machineKey/);
    });

    it('throws on globalSalt of wrong size', () => {
      expect(() =>
        deriveApiKey({ machineKey, globalSalt: Buffer.alloc(16), agentId: 'agent-1' }),
      ).toThrow(/globalSalt.*32/);
    });

    it('throws on empty agentId', () => {
      expect(() => deriveApiKey({ machineKey, globalSalt, agentId: '' })).toThrow(/agentId/);
    });

    it('uses HMAC-SHA256 primitive (compatibility with external crypto libs)', () => {
      const key = Buffer.concat([machineKey, globalSalt]);
      const expected = createHmac('sha256', key).update('agent-1', 'utf8').digest();
      const actual = deriveApiKey({ machineKey, globalSalt, agentId: 'agent-1' });
      expect(actual.equals(expected)).toBe(true);
    });
  });

  describe('deriveLegacyProjectKey', () => {
    it('returns a 32-byte Buffer', () => {
      const key = deriveLegacyProjectKey(machineKey, '/home/user/project');
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
    });

    it('is deterministic', () => {
      const k1 = deriveLegacyProjectKey(machineKey, '/p');
      const k2 = deriveLegacyProjectKey(machineKey, '/p');
      expect(k2.equals(k1)).toBe(true);
    });

    it('produces different keys for different project paths', () => {
      const k1 = deriveLegacyProjectKey(machineKey, '/project-a');
      const k2 = deriveLegacyProjectKey(machineKey, '/project-b');
      expect(k2.equals(k1)).toBe(false);
    });

    it('differs from new KDF for same machineKey + agentId', () => {
      const legacy = deriveLegacyProjectKey(machineKey, 'agent-1');
      const modern = deriveApiKey({ machineKey, globalSalt, agentId: 'agent-1' });
      // Would be a bug if identical — legacy has no salt
      expect(modern.equals(legacy)).toBe(false);
    });

    it('throws on empty machineKey', () => {
      expect(() => deriveLegacyProjectKey(Buffer.alloc(0), '/p')).toThrow(/machineKey/);
    });

    it('throws on empty projectPath', () => {
      expect(() => deriveLegacyProjectKey(machineKey, '')).toThrow(/projectPath/);
    });
  });
});

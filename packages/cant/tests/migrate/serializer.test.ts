import { describe, it, expect } from 'vitest';
import {
  serializeCantDocument,
  formatValue,
  propertiesToIR,
  type CantDocumentIR,
} from '../../src/migrate/serializer';

describe('serializer', () => {
  describe('serializeCantDocument', () => {
    it('should generate frontmatter with kind and version', () => {
      const doc: CantDocumentIR = {
        kind: 'agent',
        version: 1,
        block: {
          type: 'agent',
          name: 'test-agent',
          properties: [],
          permissions: [],
          children: [],
        },
      };
      const result = serializeCantDocument(doc);
      expect(result).toContain('---\nkind: agent\nversion: 1\n---');
    });

    it('should serialize agent with properties', () => {
      const doc: CantDocumentIR = {
        kind: 'agent',
        version: 1,
        block: {
          type: 'agent',
          name: 'ops-lead',
          properties: [
            { key: 'model', value: 'opus' },
            { key: 'prompt', value: 'Coordinate operations' },
          ],
          permissions: [],
          children: [],
        },
      };
      const result = serializeCantDocument(doc);
      expect(result).toContain('agent ops-lead:');
      expect(result).toContain('  model: "opus"');
      expect(result).toContain('  prompt: "Coordinate operations"');
    });

    it('should serialize array properties', () => {
      const doc: CantDocumentIR = {
        kind: 'agent',
        version: 1,
        block: {
          type: 'agent',
          name: 'test',
          properties: [
            { key: 'skills', value: ['ct-cleo', 'ct-orchestrator'] },
          ],
          permissions: [],
          children: [],
        },
      };
      const result = serializeCantDocument(doc);
      expect(result).toContain('skills: ["ct-cleo", "ct-orchestrator"]');
    });

    it('should serialize permissions block', () => {
      const doc: CantDocumentIR = {
        kind: 'agent',
        version: 1,
        block: {
          type: 'agent',
          name: 'test',
          properties: [],
          permissions: [
            { domain: 'tasks', values: ['read', 'write'] },
            { domain: 'session', values: ['read'] },
          ],
          children: [],
        },
      };
      const result = serializeCantDocument(doc);
      expect(result).toContain('  permissions:');
      expect(result).toContain('    tasks: read, write');
      expect(result).toContain('    session: read');
    });

    it('should serialize hook with body lines', () => {
      const doc: CantDocumentIR = {
        kind: 'hook',
        version: 1,
        block: {
          type: 'on',
          name: 'SessionStart',
          properties: [],
          permissions: [],
          children: [],
          bodyLines: ['/checkin @all', 'session "Review sprint"'],
        },
      };
      const result = serializeCantDocument(doc);
      expect(result).toContain('on SessionStart:');
      expect(result).toContain('  /checkin @all');
      expect(result).toContain('  session "Review sprint"');
    });

    it('should serialize nested children', () => {
      const doc: CantDocumentIR = {
        kind: 'workflow',
        version: 1,
        block: {
          type: 'workflow',
          name: 'deploy',
          properties: [],
          permissions: [],
          children: [{
            type: 'pipeline',
            name: 'build',
            properties: [],
            permissions: [],
            children: [{
              type: 'step',
              name: 'test',
              properties: [{ key: 'command', value: 'pnpm' }],
              permissions: [],
              children: [],
            }],
          }],
        },
      };
      const result = serializeCantDocument(doc);
      expect(result).toContain('workflow deploy:');
      expect(result).toContain('  pipeline build:');
      expect(result).toContain('    step test:');
      expect(result).toContain('      command: "pnpm"');
    });

    it('should end with a trailing newline', () => {
      const doc: CantDocumentIR = {
        kind: 'agent',
        version: 1,
        block: {
          type: 'agent',
          name: 'test',
          properties: [],
          permissions: [],
          children: [],
        },
      };
      const result = serializeCantDocument(doc);
      expect(result.endsWith('\n')).toBe(true);
    });
  });

  describe('formatValue', () => {
    it('should quote strings', () => {
      expect(formatValue('hello')).toBe('"hello"');
    });

    it('should not double-quote numeric strings', () => {
      expect(formatValue('42')).toBe('42');
    });

    it('should not double-quote booleans', () => {
      expect(formatValue('true')).toBe('true');
      expect(formatValue('false')).toBe('false');
    });

    it('should format arrays with quoted elements', () => {
      expect(formatValue(['a', 'b'])).toBe('["a", "b"]');
    });

    it('should format numbers', () => {
      expect(formatValue(42)).toBe('42');
    });

    it('should format booleans', () => {
      expect(formatValue(true)).toBe('true');
    });

    it('should escape quotes in strings', () => {
      expect(formatValue('say "hello"')).toBe('"say \\"hello\\""');
    });
  });

  describe('propertiesToIR', () => {
    it('should map model property', () => {
      const result = propertiesToIR([{ key: 'model', value: 'opus' }]);
      expect(result[0]?.key).toBe('model');
      expect(result[0]?.value).toBe('opus');
    });

    it('should normalize persistence to persist', () => {
      const result = propertiesToIR([{ key: 'persistence', value: 'project' }]);
      expect(result[0]?.key).toBe('persist');
    });

    it('should convert skills to array', () => {
      const result = propertiesToIR([
        { key: 'skills', value: 'ct-cleo, ct-orchestrator' },
      ]);
      expect(result[0]?.value).toEqual(['ct-cleo', 'ct-orchestrator']);
    });

    it('should pass through unknown keys', () => {
      const result = propertiesToIR([{ key: 'custom', value: 'val' }]);
      expect(result[0]?.key).toBe('custom');
    });
  });
});

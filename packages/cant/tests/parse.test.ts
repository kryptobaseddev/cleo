import { describe, it, expect, beforeAll } from 'vitest';
import { initCantParser, parseCANTMessage } from '../src/parse';

describe('CANT Parser', () => {
  beforeAll(async () => {
    // Initialize WASM if available
    await initCantParser();
  });

  describe('parseCANTMessage', () => {
    it('should parse a simple directive', () => {
      const result = parseCANTMessage('/done');
      expect(result.directive).toBe('done');
      expect(result.directive_type).toBe('actionable');
    });

    it('should parse addresses', () => {
      const result = parseCANTMessage('/action @cleo-core @signaldock-dev');
      expect(result.directive).toBe('action');
      expect(result.addresses).toContain('cleo-core');
      expect(result.addresses).toContain('signaldock-dev');
    });

    it('should parse task references', () => {
      const result = parseCANTMessage('/done T1234');
      expect(result.task_refs).toContain('T1234');
    });

    it('should parse tags', () => {
      const result = parseCANTMessage('/done #shipped #phase-0');
      expect(result.tags).toContain('shipped');
      expect(result.tags).toContain('phase-0');
    });

    it('should parse full message with all elements', () => {
      const content = '/done @all T1234 #shipped\n\nTask completed successfully';
      const result = parseCANTMessage(content);
      
      expect(result.directive).toBe('done');
      expect(result.directive_type).toBe('actionable');
      expect(result.addresses).toContain('all');
      expect(result.task_refs).toContain('T1234');
      expect(result.tags).toContain('shipped');
      expect(result.body).toContain('Task completed successfully');
    });

    it('should handle plain text without directive', () => {
      const result = parseCANTMessage('Just a status update');
      expect(result.directive).toBeUndefined();
      expect(result.directive_type).toBe('informational');
    });

    it('should classify routing directives correctly', () => {
      const action = parseCANTMessage('/action');
      expect(action.directive_type).toBe('routing');

      const review = parseCANTMessage('/review');
      expect(review.directive_type).toBe('routing');
    });

    it('should classify informational directives correctly', () => {
      const info = parseCANTMessage('/info');
      expect(info.directive_type).toBe('informational');

      const status = parseCANTMessage('/status');
      expect(status.directive_type).toBe('informational');
    });
  });
});

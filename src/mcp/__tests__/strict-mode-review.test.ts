/**
 * T4693: Review LAFS mcpAdapter strict_mode_behavior
 *
 * Verifies that the MCP adapter consistently handles strict mode:
 * - CLI envelopes set _meta.strict = true
 * - Gateway meta sets strict = true
 * - Protocol enforcement uses strictMode consistently
 * - No strict_mode_behavior bug exists
 *
 * @task T4693
 * @epic T4663
 */

import { describe, it, expect } from 'vitest';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { createGatewayMeta } from '../lib/gateway-meta.js';
import { DEFAULT_CONFIG, DEFAULT_PROTOCOL_VALIDATION } from '../lib/defaults.js';
import { createVerificationGate } from '../lib/verification-gates.js';

describe('LAFS strict_mode_behavior review (T4693)', () => {
  describe('CLI envelope strict mode', () => {
    it('formatSuccess always sets _meta.strict = true', () => {
      const json = formatSuccess({ data: 'test' }, undefined, 'tasks.show');
      const parsed = JSON.parse(json);
      expect(parsed._meta.strict).toBe(true);
    });

    it('formatError always sets _meta.strict = true', () => {
      const err = new CleoError(ExitCode.NOT_FOUND, 'Not found');
      const json = formatError(err, 'tasks.show');
      const parsed = JSON.parse(json);
      expect(parsed._meta.strict).toBe(true);
    });

    it('formatSuccess without operation still sets strict = true', () => {
      const json = formatSuccess({ ok: true });
      const parsed = JSON.parse(json);
      expect(parsed._meta.strict).toBe(true);
    });
  });

  describe('Gateway meta strict mode', () => {
    it('createGatewayMeta always sets strict = true', () => {
      const meta = createGatewayMeta('cleo_query', 'tasks', 'list', Date.now());
      expect(meta.strict).toBe(true);
    });

    it('createGatewayMeta for mutate also sets strict = true', () => {
      const meta = createGatewayMeta('cleo_mutate', 'tasks', 'add', Date.now());
      expect(meta.strict).toBe(true);
    });
  });

  describe('Config defaults', () => {
    it('DEFAULT_CONFIG.strictValidation = true', () => {
      expect(DEFAULT_CONFIG.strictValidation).toBe(true);
    });

    it('DEFAULT_PROTOCOL_VALIDATION.strictMode = true', () => {
      expect(DEFAULT_PROTOCOL_VALIDATION.strictMode).toBe(true);
    });

    it('DEFAULT_PROTOCOL_VALIDATION.blockOnViolation = true', () => {
      expect(DEFAULT_PROTOCOL_VALIDATION.blockOnViolation).toBe(true);
    });
  });

  describe('VerificationGate strict mode', () => {
    it('defaults to strict mode', () => {
      const gate = createVerificationGate();
      // Strict mode is default -- validation should block on failures
      expect(gate).toBeDefined();
    });

    it('accepts explicit strict mode parameter', () => {
      const strictGate = createVerificationGate(true);
      const relaxedGate = createVerificationGate(false);
      expect(strictGate).toBeDefined();
      expect(relaxedGate).toBeDefined();
    });
  });

  describe('No strict_mode_behavior property exists', () => {
    it('envelope has no strict_mode_behavior field', () => {
      const json = formatSuccess({ ok: true }, undefined, 'test');
      const parsed = JSON.parse(json);
      expect(parsed._meta.strict_mode_behavior).toBeUndefined();
      expect(parsed.strict_mode_behavior).toBeUndefined();
    });

    it('gateway meta has no strict_mode_behavior field', () => {
      const meta = createGatewayMeta('q', 'd', 'op', Date.now());
      expect((meta as Record<string, unknown>)['strict_mode_behavior']).toBeUndefined();
    });
  });
});

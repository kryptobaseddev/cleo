/**
 * Tests for MCP priority validation fix - T4572
 * Verifies the gate validator accepts both string and numeric priorities.
 * @task T4572
 */

import { describe, it, expect } from 'vitest';
import {
  validateLayer1Schema,
  VALIDATION_RULES,
} from '../gate-validators.js';
import {
  GateStatus,
  type OperationContext,
} from '../verification-gates.js';

describe('MCP Priority Validation (T4572)', () => {
  describe('validateLayer1Schema - priority field', () => {
    describe('string priorities (canonical format)', () => {
      it.each(['critical', 'high', 'medium', 'low'])(
        'should accept string priority "%s"',
        async (priority) => {
          const context: OperationContext = {
            domain: 'tasks',
            operation: 'add',
            gateway: 'cleo_mutate',
            params: { priority },
          };

          const result = await validateLayer1Schema(context);
          const priorityViolations = result.violations.filter(
            (v) => v.code === 'E_INVALID_PRIORITY',
          );
          expect(priorityViolations).toHaveLength(0);
        },
      );
    });

    describe('numeric priorities (number type)', () => {
      it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])(
        'should accept numeric priority %d',
        async (priority) => {
          const context: OperationContext = {
            domain: 'tasks',
            operation: 'add',
            gateway: 'cleo_mutate',
            params: { priority },
          };

          const result = await validateLayer1Schema(context);
          const priorityViolations = result.violations.filter(
            (v) => v.code === 'E_INVALID_PRIORITY',
          );
          expect(priorityViolations).toHaveLength(0);
        },
      );
    });

    describe('numeric string priorities', () => {
      it.each(['1', '5', '9'])(
        'should accept numeric string priority "%s"',
        async (priority) => {
          const context: OperationContext = {
            domain: 'tasks',
            operation: 'add',
            gateway: 'cleo_mutate',
            params: { priority },
          };

          const result = await validateLayer1Schema(context);
          const priorityViolations = result.violations.filter(
            (v) => v.code === 'E_INVALID_PRIORITY',
          );
          expect(priorityViolations).toHaveLength(0);
        },
      );
    });

    describe('invalid priorities', () => {
      it('should reject numeric priority out of range (> 9)', async () => {
        const context: OperationContext = {
          domain: 'tasks',
          operation: 'add',
          gateway: 'cleo_mutate',
          params: { priority: 15 },
        };

        const result = await validateLayer1Schema(context);
        expect(result.passed).toBe(false);
        expect(result.violations[0].code).toBe('E_INVALID_PRIORITY');
      });

      it('should reject numeric priority 0', async () => {
        const context: OperationContext = {
          domain: 'tasks',
          operation: 'add',
          gateway: 'cleo_mutate',
          params: { priority: 0 },
        };

        const result = await validateLayer1Schema(context);
        expect(result.passed).toBe(false);
        expect(result.violations.some((v) => v.code === 'E_INVALID_PRIORITY')).toBe(true);
      });

      it('should reject invalid string priority', async () => {
        const context: OperationContext = {
          domain: 'tasks',
          operation: 'add',
          gateway: 'cleo_mutate',
          params: { priority: 'urgent' },
        };

        const result = await validateLayer1Schema(context);
        expect(result.passed).toBe(false);
        expect(result.violations.some((v) => v.code === 'E_INVALID_PRIORITY')).toBe(true);
      });

      it('should reject boolean priority', async () => {
        const context: OperationContext = {
          domain: 'tasks',
          operation: 'add',
          gateway: 'cleo_mutate',
          params: { priority: true },
        };

        const result = await validateLayer1Schema(context);
        expect(result.passed).toBe(false);
        expect(result.violations.some((v) => v.code === 'E_INVALID_PRIORITY')).toBe(true);
      });

      it('should reject negative numeric priority', async () => {
        const context: OperationContext = {
          domain: 'tasks',
          operation: 'add',
          gateway: 'cleo_mutate',
          params: { priority: -1 },
        };

        const result = await validateLayer1Schema(context);
        expect(result.passed).toBe(false);
        expect(result.violations.some((v) => v.code === 'E_INVALID_PRIORITY')).toBe(true);
      });
    });

    describe('combined validation (full create context)', () => {
      it('should pass with string priority in full create params', async () => {
        const context: OperationContext = {
          domain: 'tasks',
          operation: 'add',
          gateway: 'cleo_mutate',
          params: {
            title: 'Valid Task Title',
            description: 'Valid task description with sufficient length',
            priority: 'high',
          },
        };

        const result = await validateLayer1Schema(context);
        expect(result.passed).toBe(true);
        expect(result.status).toBe(GateStatus.PASSED);
      });

      it('should pass with numeric priority in full create params', async () => {
        const context: OperationContext = {
          domain: 'tasks',
          operation: 'add',
          gateway: 'cleo_mutate',
          params: {
            title: 'Valid Task Title',
            description: 'Valid task description with sufficient length',
            priority: 5,
          },
        };

        const result = await validateLayer1Schema(context);
        expect(result.passed).toBe(true);
        expect(result.status).toBe(GateStatus.PASSED);
      });
    });
  });

  describe('VALIDATION_RULES constants', () => {
    it('should export canonical string priorities', () => {
      expect(VALIDATION_RULES.VALID_PRIORITIES).toEqual(['critical', 'high', 'medium', 'low']);
    });

    it('should export numeric priority range', () => {
      expect(VALIDATION_RULES.PRIORITY_NUMERIC_MIN).toBe(1);
      expect(VALIDATION_RULES.PRIORITY_NUMERIC_MAX).toBe(9);
    });
  });
});

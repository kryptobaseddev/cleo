/**
 * E_CLI_REQUIRED Degradation Path Tests
 *
 * Validates that operations marked as CLI-only in capability-matrix.ts
 * return proper E_CLI_REQUIRED error codes when the native engine
 * encounters them without CLI availability.
 *
 * @task T4374
 */

import { describe, it, expect } from '@jest/globals';
import {
  requiresCLI,
  canRunNatively,
  getCapabilityMatrix,
  getOperationMode,
  generateCapabilityReport,
} from '../../src/engine/capability-matrix';
import type { GatewayType } from '../../src/engine/capability-matrix';
import { createCLIRequiredError } from '../../src/lib/mode-detector';

describe('E_CLI_REQUIRED Degradation', () => {
  describe('Capability Matrix: CLI-only operations', () => {
    /**
     * All domains that are entirely CLI-only
     */
    const fullyCliDomains = ['orchestrate', 'research', 'lifecycle', 'release'];

    for (const domain of fullyCliDomains) {
      it(`${domain} domain: all operations require CLI`, () => {
        const matrix = getCapabilityMatrix();
        const domainOps = matrix.filter((cap) => cap.domain === domain);
        expect(domainOps.length).toBeGreaterThan(0);

        for (const op of domainOps) {
          expect(requiresCLI(op.domain, op.operation, op.gateway)).toBe(true);
          expect(canRunNatively(op.domain, op.operation, op.gateway)).toBe(false);
        }
      });
    }

    it('orchestrate.spawn requires CLI', () => {
      expect(requiresCLI('orchestrate', 'spawn', 'mutate')).toBe(true);
    });

    it('research.inject requires CLI', () => {
      expect(requiresCLI('research', 'inject', 'mutate')).toBe(true);
    });

    it('lifecycle.reset requires CLI', () => {
      expect(requiresCLI('lifecycle', 'reset', 'mutate')).toBe(true);
    });

    it('release.push requires CLI', () => {
      expect(requiresCLI('release', 'push', 'mutate')).toBe(true);
    });

    it('validate.protocol requires CLI', () => {
      expect(requiresCLI('validate', 'protocol', 'query')).toBe(true);
    });

    it('tasks.next requires CLI (complex analysis)', () => {
      expect(requiresCLI('tasks', 'next', 'query')).toBe(true);
    });

    it('session.resume requires CLI', () => {
      expect(requiresCLI('session', 'resume', 'mutate')).toBe(true);
    });
  });

  describe('Capability Matrix: Native operations', () => {
    it('tasks.show can run natively', () => {
      expect(canRunNatively('tasks', 'show', 'query')).toBe(true);
    });

    it('tasks.list can run natively', () => {
      expect(canRunNatively('tasks', 'list', 'query')).toBe(true);
    });

    it('tasks.add can run natively', () => {
      expect(canRunNatively('tasks', 'add', 'mutate')).toBe(true);
    });

    it('tasks.complete can run natively', () => {
      expect(canRunNatively('tasks', 'complete', 'mutate')).toBe(true);
    });

    it('session.status can run natively', () => {
      expect(canRunNatively('session', 'status', 'query')).toBe(true);
    });

    it('session.start can run natively', () => {
      expect(canRunNatively('session', 'start', 'mutate')).toBe(true);
    });

    it('system.version can run natively', () => {
      expect(canRunNatively('system', 'version', 'query')).toBe(true);
    });

    it('validate.schema can run natively', () => {
      expect(canRunNatively('validate', 'schema', 'query')).toBe(true);
    });
  });

  describe('Capability Matrix: Hybrid operations', () => {
    it('system.doctor is hybrid', () => {
      expect(getOperationMode('system', 'doctor', 'query')).toBe('hybrid');
      expect(canRunNatively('system', 'doctor', 'query')).toBe(true);
      expect(requiresCLI('system', 'doctor', 'query')).toBe(false);
    });
  });

  describe('Capability Matrix: Unknown operations', () => {
    it('returns undefined for unknown domain', () => {
      expect(getOperationMode('nonexistent', 'op', 'query')).toBeUndefined();
    });

    it('returns undefined for unknown operation', () => {
      expect(getOperationMode('tasks', 'nonexistent', 'query')).toBeUndefined();
    });

    it('requiresCLI returns false for unknown operations', () => {
      expect(requiresCLI('nonexistent', 'op', 'query')).toBe(false);
    });

    it('canRunNatively returns false for unknown operations', () => {
      expect(canRunNatively('nonexistent', 'op', 'query')).toBe(false);
    });
  });

  describe('E_CLI_REQUIRED error contract', () => {
    it('returns correct error structure for orchestrate.spawn', () => {
      const error = createCLIRequiredError('orchestrate', 'spawn');
      expect(error.success).toBe(false);
      expect(error.error.code).toBe('E_CLI_REQUIRED');
      expect(error.error.message).toContain('orchestrate.spawn');
      expect(error.error.message).toContain('requires the CLEO CLI');
      expect(error.error.availableInStandaloneMode).toBe(false);
      expect(Array.isArray(error.error.nativeAlternatives)).toBe(true);
    });

    it('returns correct error structure for research.inject', () => {
      const error = createCLIRequiredError('research', 'inject');
      expect(error.success).toBe(false);
      expect(error.error.code).toBe('E_CLI_REQUIRED');
      expect(error.error.message).toContain('research.inject');
      expect(error.error.availableInStandaloneMode).toBe(false);
    });

    it('returns correct error structure for lifecycle.reset', () => {
      const error = createCLIRequiredError('lifecycle', 'reset');
      expect(error.success).toBe(false);
      expect(error.error.code).toBe('E_CLI_REQUIRED');
      expect(error.error.message).toContain('lifecycle.reset');
    });

    it('returns correct error structure for release.push', () => {
      const error = createCLIRequiredError('release', 'push');
      expect(error.success).toBe(false);
      expect(error.error.code).toBe('E_CLI_REQUIRED');
      expect(error.error.message).toContain('release.push');
    });

    it('error message includes install instructions', () => {
      const error = createCLIRequiredError('orchestrate', 'spawn');
      expect(error.error.message).toContain('./install.sh');
    });

    it('nativeAlternatives is empty array (no alternatives for CLI-only)', () => {
      const error = createCLIRequiredError('orchestrate', 'spawn');
      expect(error.error.nativeAlternatives).toEqual([]);
    });
  });

  describe('Capability Report', () => {
    it('generates a complete capability report', () => {
      const report = generateCapabilityReport();
      expect(report.totalOperations).toBeGreaterThan(0);
      expect(report.native).toBeGreaterThan(0);
      expect(report.cli).toBeGreaterThan(0);
      expect(report.hybrid).toBeGreaterThanOrEqual(1);
      expect(report.native + report.cli + report.hybrid).toBe(report.totalOperations);
    });

    it('report includes all expected domains', () => {
      const report = generateCapabilityReport();
      const expectedDomains = [
        'tasks', 'session', 'system', 'validate',
        'orchestrate', 'research', 'lifecycle', 'release',
      ];
      for (const domain of expectedDomains) {
        expect(report.domains).toHaveProperty(domain);
      }
    });

    it('orchestrate domain has only cli operations in report', () => {
      const report = generateCapabilityReport();
      const orchestrate = report.domains['orchestrate'];
      expect(orchestrate.native).toHaveLength(0);
      expect(orchestrate.hybrid).toHaveLength(0);
      expect(orchestrate.cli.length).toBeGreaterThan(0);
    });

    it('tasks domain has both native and cli operations', () => {
      const report = generateCapabilityReport();
      const tasks = report.domains['tasks'];
      expect(tasks.native.length).toBeGreaterThan(0);
      expect(tasks.cli.length).toBeGreaterThan(0);
    });
  });

  describe('CLI-only operation enumeration', () => {
    /**
     * Exhaustive test: every CLI-only operation in the matrix should
     * produce a valid E_CLI_REQUIRED error response.
     */
    it('all CLI-only operations produce valid error responses', () => {
      const matrix = getCapabilityMatrix();
      const cliOnly = matrix.filter((cap) => cap.mode === 'cli');

      expect(cliOnly.length).toBeGreaterThan(0);

      for (const cap of cliOnly) {
        const error = createCLIRequiredError(cap.domain, cap.operation);
        expect(error.success).toBe(false);
        expect(error.error.code).toBe('E_CLI_REQUIRED');
        expect(error.error.message).toContain(`${cap.domain}.${cap.operation}`);
        expect(error.error.availableInStandaloneMode).toBe(false);
      }
    });
  });
});

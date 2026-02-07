/**
 * Tests for Protocol Enforcement Middleware
 *
 * @task T2918
 * @epic T2908
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { ProtocolEnforcer, ProtocolType } from '../protocol-enforcement.js';

describe('ProtocolEnforcer', () => {
  let enforcer: ProtocolEnforcer;

  beforeEach(() => {
    enforcer = new ProtocolEnforcer(true);
  });

  describe('Research Protocol', () => {
    it('should pass valid research manifest', async () => {
      const manifest = {
        id: 'T2918-research',
        file: 'output.md',
        date: '2026-02-03',
        title: 'Research findings',
        status: 'complete',
        agent_type: 'research',
        key_findings: ['Finding 1', 'Finding 2', 'Finding 3'],
        sources: ['source1.md'],
        linked_tasks: ['T2918'],
      };

      const result = await enforcer.validateProtocol(ProtocolType.RESEARCH, manifest);
      expect(result.valid).toBe(true);
      expect(result.violations.filter(v => v.severity === 'error')).toHaveLength(0);
    });

    it('should fail with missing key_findings', async () => {
      const manifest = {
        id: 'T2918-research',
        file: 'output.md',
        date: '2026-02-03',
        title: 'Research findings',
        status: 'complete',
        agent_type: 'research',
        key_findings: [],
        linked_tasks: ['T2918'],
      };

      const result = await enforcer.validateProtocol(ProtocolType.RESEARCH, manifest);
      expect(result.valid).toBe(false);
      expect(result.violations.some((v) => v.requirement === 'RSCH-006')).toBe(true);
    });

    it('should fail with wrong agent_type', async () => {
      const manifest = {
        id: 'T2918-research',
        file: 'output.md',
        date: '2026-02-03',
        title: 'Research findings',
        status: 'complete',
        agent_type: 'implementation',
        key_findings: ['Finding 1', 'Finding 2', 'Finding 3'],
        linked_tasks: ['T2918'],
      };

      const result = await enforcer.validateProtocol(ProtocolType.RESEARCH, manifest);
      expect(result.valid).toBe(false);
      expect(result.violations.some((v) => v.requirement === 'RSCH-007')).toBe(true);
    });
  });

  describe('Specification Protocol', () => {
    it('should pass valid specification manifest', async () => {
      const manifest = {
        id: 'T2918-spec',
        file: 'spec.md',
        date: '2026-02-03',
        agent_type: 'specification',
        version: '1.0.0',
      };

      const additionalData = {
        fileContent: 'The system MUST support RFC 2119 keywords.',
      };

      const result = await enforcer.validateProtocol(
        ProtocolType.SPECIFICATION,
        manifest,
        additionalData
      );
      expect(result.valid).toBe(true);
    });

    it('should fail without RFC 2119 keywords', async () => {
      const manifest = {
        id: 'T2918-spec',
        file: 'spec.md',
        date: '2026-02-03',
        agent_type: 'specification',
        version: '1.0.0',
      };

      const additionalData = {
        fileContent: 'The system supports features.',
      };

      const result = await enforcer.validateProtocol(
        ProtocolType.SPECIFICATION,
        manifest,
        additionalData
      );
      expect(result.valid).toBe(false);
      expect(result.violations.some((v) => v.requirement === 'SPEC-001')).toBe(true);
    });
  });

  describe('Implementation Protocol', () => {
    it('should pass without new functions', async () => {
      const manifest = {
        id: 'T2918-impl',
        file: 'implementation.md',
        date: '2026-02-03',
        agent_type: 'implementation',
      };

      const additionalData = {
        hasNewFunctions: false,
      };

      const result = await enforcer.validateProtocol(
        ProtocolType.IMPLEMENTATION,
        manifest,
        additionalData
      );
      expect(result.valid).toBe(true);
    });

    it('should fail with new functions but no provenance', async () => {
      const manifest = {
        id: 'T2918-impl',
        file: 'implementation.md',
        date: '2026-02-03',
        agent_type: 'implementation',
      };

      const additionalData = {
        hasNewFunctions: true,
        hasProvenanceTags: false,
      };

      const result = await enforcer.validateProtocol(
        ProtocolType.IMPLEMENTATION,
        manifest,
        additionalData
      );
      expect(result.valid).toBe(false);
      expect(result.violations.some((v) => v.requirement === 'IMPL-003')).toBe(true);
    });
  });

  describe('Release Protocol', () => {
    it('should pass valid release', async () => {
      const manifest = {
        id: 'T2918-release',
        file: 'CHANGELOG.md',
        date: '2026-02-03',
        agent_type: 'documentation',
      };

      const additionalData = {
        version: '1.2.3',
        changelogEntry: 'Added new features',
      };

      const result = await enforcer.validateProtocol(ProtocolType.RELEASE, manifest, additionalData);
      expect(result.valid).toBe(true);
    });

    it('should fail with invalid semver', async () => {
      const manifest = {
        id: 'T2918-release',
        file: 'CHANGELOG.md',
        date: '2026-02-03',
        agent_type: 'documentation',
      };

      const additionalData = {
        version: 'v1.2',
        changelogEntry: 'Added new features',
      };

      const result = await enforcer.validateProtocol(ProtocolType.RELEASE, manifest, additionalData);
      expect(result.valid).toBe(false);
      expect(result.violations.some((v) => v.requirement === 'RLSE-001')).toBe(true);
    });
  });

  describe('Lifecycle Gates', () => {
    it('should pass when all prerequisites met', async () => {
      const rcsdManifest = {
        research: 'completed',
        consensus: 'completed',
        specification: 'completed',
        decomposition: 'completed',
      };

      const result = await enforcer.checkLifecycleGate('T2918', 'implementation', rcsdManifest);
      expect(result.passed).toBe(true);
      expect(result.missingPrerequisites).toHaveLength(0);
    });

    it('should fail when prerequisites missing', async () => {
      const rcsdManifest = {
        research: 'completed',
        consensus: 'pending',
        specification: 'pending',
        decomposition: 'pending',
      };

      const result = await enforcer.checkLifecycleGate('T2918', 'implementation', rcsdManifest);
      expect(result.passed).toBe(false);
      expect(result.missingPrerequisites).toContain('consensus');
      expect(result.missingPrerequisites).toContain('specification');
    });

    it('should allow skipped stages', async () => {
      const rcsdManifest = {
        research: 'completed',
        consensus: 'skipped',
        specification: 'completed',
        decomposition: 'completed',
      };

      const result = await enforcer.checkLifecycleGate('T2918', 'implementation', rcsdManifest);
      expect(result.passed).toBe(true);
    });

    it('should pass with no manifest', async () => {
      const result = await enforcer.checkLifecycleGate('T2918', 'implementation', undefined);
      expect(result.passed).toBe(true);
      expect(result.message).toContain('No RCSD manifest');
    });
  });

  describe('Violation Recording', () => {
    it('should record violations', () => {
      enforcer.recordViolation(
        ProtocolType.RESEARCH,
        [
          {
            requirement: 'RSCH-006',
            severity: 'error',
            message: 'Missing key findings',
            fix: 'Add findings',
          },
        ],
        80,
        'T2918'
      );

      const violations = enforcer.getViolations();
      expect(violations).toHaveLength(1);
      expect(violations[0].taskId).toBe('T2918');
      expect(violations[0].protocol).toBe(ProtocolType.RESEARCH);
    });

    it('should limit violation history', () => {
      for (let i = 0; i < 1100; i++) {
        enforcer.recordViolation(ProtocolType.RESEARCH, [], 100);
      }

      const violations = enforcer.getViolations();
      expect(violations.length).toBeLessThanOrEqual(1000);
    });
  });

  describe('Strict Mode', () => {
    it('should block operations in strict mode', () => {
      enforcer.setStrictMode(true);
      expect(enforcer.isStrictMode()).toBe(true);
    });

    it('should allow operations in non-strict mode', () => {
      enforcer.setStrictMode(false);
      expect(enforcer.isStrictMode()).toBe(false);
    });
  });
});

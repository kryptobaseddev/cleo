/**
 * Protocol enforcement regression testing - all 9 protocols.
 * Validates exit codes 60-67 and protocol compliance rules.
 *
 * @task T4499
 * @epic T4498
 */

import { describe, it, expect } from 'vitest';
import {
  validateResearchProtocol,
  validateConsensusProtocol,
  validateSpecificationProtocol,
  validateDecompositionProtocol,
  validateImplementationProtocol,
  validateContributionProtocol,
  validateReleaseProtocol,
  validateArtifactPublishProtocol,
  validateProvenanceProtocol,
  validateProtocol,
  PROTOCOL_TYPES,
  PROTOCOL_EXIT_CODES,
  type ManifestEntryInput,
  type ProtocolType,
} from '../protocol-validators.js';
import { ExitCode } from '../../../types/exit-codes.js';
import { CleoError } from '../../errors.js';

// ============================================================
// Helper: create valid manifest entry for a protocol
// ============================================================

function validEntry(agentType: string, overrides: Partial<ManifestEntryInput> = {}): ManifestEntryInput {
  return {
    id: 'T001-test',
    file: 'output/T001-test.md',
    title: 'Test entry',
    date: '2026-01-01',
    status: 'complete',
    agent_type: agentType,
    topics: ['testing'],
    key_findings: ['Finding 1', 'Finding 2', 'Finding 3'],
    actionable: true,
    needs_followup: [],
    linked_tasks: ['T001'],
    sources: ['https://example.com'],
    ...overrides,
  };
}

// ============================================================
// 1. RESEARCH PROTOCOL (exit code 60)
// ============================================================

describe('Research Protocol', () => {
  it('passes valid research entry', () => {
    const result = validateResearchProtocol(validEntry('research'));
    expect(result.valid).toBe(true);
    expect(result.protocol).toBe('research');
    expect(result.score).toBe(100);
  });

  it('fails when key_findings < 3', () => {
    const result = validateResearchProtocol(
      validEntry('research', { key_findings: ['one', 'two'] }),
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ requirement: 'RSCH-006' }),
    );
  });

  it('fails when key_findings > 7', () => {
    const result = validateResearchProtocol(
      validEntry('research', { key_findings: Array(8).fill('finding') }),
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ requirement: 'RSCH-006' }),
    );
  });

  it('fails when agent_type is wrong', () => {
    const result = validateResearchProtocol(
      validEntry('implementation'),
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ requirement: 'RSCH-007' }),
    );
  });

  it('fails when code changes detected', () => {
    const result = validateResearchProtocol(
      validEntry('research'),
      { hasCodeChanges: true },
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ requirement: 'RSCH-001' }),
    );
  });

  it('warns about missing sources in strict mode', () => {
    const result = validateResearchProtocol(
      validEntry('research', { sources: undefined }),
      { strict: true },
    );
    expect(result.violations).toContainEqual(
      expect.objectContaining({ requirement: 'RSCH-002', severity: 'warning' }),
    );
  });

  it('score decreases with violations', () => {
    const result = validateResearchProtocol(
      validEntry('implementation', { key_findings: [] }),
      { hasCodeChanges: true },
    );
    expect(result.score).toBeLessThan(50);
  });
});

// ============================================================
// 2. CONSENSUS PROTOCOL (exit code 61)
// ============================================================

describe('Consensus Protocol', () => {
  it('passes valid consensus entry', () => {
    const result = validateConsensusProtocol(
      validEntry('analysis'),
      {
        options: [
          { name: 'Option A', confidence: 0.8 },
          { name: 'Option B', confidence: 0.6 },
        ],
      },
    );
    expect(result.valid).toBe(true);
    expect(result.protocol).toBe('consensus');
  });

  it('fails with < 2 options', () => {
    const result = validateConsensusProtocol(
      validEntry('analysis'),
      { options: [{ name: 'Only one', confidence: 0.9 }] },
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ requirement: 'CONS-001' }),
    );
  });

  it('fails with invalid confidence scores', () => {
    const result = validateConsensusProtocol(
      validEntry('analysis'),
      {
        options: [
          { name: 'A', confidence: 1.5 },
          { name: 'B', confidence: 0.3 },
        ],
      },
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ requirement: 'CONS-003' }),
    );
  });

  it('fails when threshold not met', () => {
    const result = validateConsensusProtocol(
      validEntry('analysis'),
      {
        options: [
          { name: 'A', confidence: 0.3 },
          { name: 'B', confidence: 0.2 },
        ],
      },
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ requirement: 'CONS-004' }),
    );
  });

  it('fails when agent_type is wrong', () => {
    const result = validateConsensusProtocol(
      validEntry('research'),
      {
        options: [
          { name: 'A', confidence: 0.8 },
          { name: 'B', confidence: 0.6 },
        ],
      },
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ requirement: 'CONS-007' }),
    );
  });
});

// ============================================================
// 3. SPECIFICATION PROTOCOL (exit code 62)
// ============================================================

describe('Specification Protocol', () => {
  it('passes valid spec entry with RFC 2119 keywords', () => {
    const result = validateSpecificationProtocol(
      validEntry('specification'),
      'The system MUST support all protocols. The API SHOULD be versioned.',
    );
    expect(result.valid).toBe(true);
    expect(result.protocol).toBe('specification');
  });

  it('fails without RFC 2119 keywords', () => {
    const result = validateSpecificationProtocol(
      validEntry('specification'),
      'The system supports all protocols. The API is versioned.',
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ requirement: 'SPEC-001' }),
    );
  });

  it('fails without output file', () => {
    const result = validateSpecificationProtocol(
      validEntry('specification', { file: undefined }),
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ requirement: 'SPEC-003' }),
    );
  });

  it('fails with wrong agent_type', () => {
    const result = validateSpecificationProtocol(
      validEntry('research'),
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ requirement: 'SPEC-007' }),
    );
  });
});

// ============================================================
// 4. DECOMPOSITION PROTOCOL (exit code 63)
// ============================================================

describe('Decomposition Protocol', () => {
  it('passes valid decomposition entry', () => {
    const result = validateDecompositionProtocol(
      validEntry('decomposition'),
      { siblingCount: 5 },
    );
    expect(result.valid).toBe(true);
    expect(result.protocol).toBe('decomposition');
  });

  it('fails with too many siblings', () => {
    const result = validateDecompositionProtocol(
      validEntry('decomposition'),
      { siblingCount: 10 },
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ requirement: 'DCOMP-001' }),
    );
  });

  it('fails with unclear descriptions', () => {
    const result = validateDecompositionProtocol(
      validEntry('decomposition'),
      { descriptionClarity: false },
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ requirement: 'DCOMP-002' }),
    );
  });

  it('fails with wrong agent_type', () => {
    const result = validateDecompositionProtocol(
      validEntry('research'),
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ requirement: 'DCOMP-007' }),
    );
  });
});

// ============================================================
// 5. IMPLEMENTATION PROTOCOL (exit code 64)
// ============================================================

describe('Implementation Protocol', () => {
  it('passes valid implementation entry', () => {
    const result = validateImplementationProtocol(
      validEntry('implementation'),
      { hasTaskTags: true },
    );
    expect(result.valid).toBe(true);
    expect(result.protocol).toBe('implementation');
  });

  it('fails without @task tags', () => {
    const result = validateImplementationProtocol(
      validEntry('implementation'),
      { hasTaskTags: false },
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ requirement: 'IMPL-001' }),
    );
  });

  it('fails without output file', () => {
    const result = validateImplementationProtocol(
      validEntry('implementation', { file: undefined }),
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ requirement: 'IMPL-003' }),
    );
  });

  it('fails without linked tasks', () => {
    const result = validateImplementationProtocol(
      validEntry('implementation', { linked_tasks: [] }),
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ requirement: 'IMPL-004' }),
    );
  });
});

// ============================================================
// 6. CONTRIBUTION PROTOCOL (exit code 65)
// ============================================================

describe('Contribution Protocol', () => {
  it('passes valid contribution entry', () => {
    const result = validateContributionProtocol(
      validEntry('contribution'),
      { hasContributionTags: true },
    );
    expect(result.valid).toBe(true);
    expect(result.protocol).toBe('contribution');
  });

  it('fails without contribution tags', () => {
    const result = validateContributionProtocol(
      validEntry('contribution'),
      { hasContributionTags: false },
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ requirement: 'CONT-001' }),
    );
  });

  it('fails without linked tasks', () => {
    const result = validateContributionProtocol(
      validEntry('contribution', { linked_tasks: [] }),
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ requirement: 'CONT-003' }),
    );
  });
});

// ============================================================
// 7. RELEASE PROTOCOL (exit code 66)
// ============================================================

describe('Release Protocol', () => {
  it('passes valid release entry', () => {
    const result = validateReleaseProtocol(
      validEntry('release'),
      { version: '1.0.0', hasChangelog: true },
    );
    expect(result.valid).toBe(true);
    expect(result.protocol).toBe('release');
  });

  it('fails with invalid semver', () => {
    const result = validateReleaseProtocol(
      validEntry('release'),
      { version: 'not-valid' },
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ requirement: 'REL-001' }),
    );
  });

  it('accepts semver with pre-release', () => {
    const result = validateReleaseProtocol(
      validEntry('release'),
      { version: '1.0.0-alpha.1', hasChangelog: true },
    );
    expect(result.valid).toBe(true);
  });

  it('fails without changelog', () => {
    const result = validateReleaseProtocol(
      validEntry('release'),
      { hasChangelog: false },
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ requirement: 'REL-002' }),
    );
  });
});

// ============================================================
// 8. ARTIFACT PUBLISH PROTOCOL (exit code 67)
// ============================================================

describe('Artifact Publish Protocol', () => {
  it('passes valid artifact publish entry', () => {
    const result = validateArtifactPublishProtocol(
      validEntry('artifact-publish'),
      { artifactType: 'npm', buildPassed: true },
    );
    expect(result.valid).toBe(true);
    expect(result.protocol).toBe('artifact-publish');
  });

  it('fails without artifact type', () => {
    const result = validateArtifactPublishProtocol(
      validEntry('artifact-publish'),
      { buildPassed: true },
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ requirement: 'ARTF-001' }),
    );
  });

  it('fails when build did not pass', () => {
    const result = validateArtifactPublishProtocol(
      validEntry('artifact-publish'),
      { artifactType: 'npm', buildPassed: false },
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ requirement: 'ARTF-002' }),
    );
  });
});

// ============================================================
// 9. PROVENANCE PROTOCOL (exit code 67)
// ============================================================

describe('Provenance Protocol', () => {
  it('passes valid provenance entry', () => {
    const result = validateProvenanceProtocol(
      validEntry('provenance'),
      { hasAttestation: true, hasSbom: true },
    );
    expect(result.valid).toBe(true);
    expect(result.protocol).toBe('provenance');
  });

  it('fails without attestation', () => {
    const result = validateProvenanceProtocol(
      validEntry('provenance'),
      { hasAttestation: false },
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ requirement: 'PROV-001' }),
    );
  });

  it('warns about missing SBOM', () => {
    const result = validateProvenanceProtocol(
      validEntry('provenance'),
      { hasSbom: false },
    );
    // SBOM is a warning, not error, so valid can still be true
    expect(result.violations).toContainEqual(
      expect.objectContaining({ requirement: 'PROV-002', severity: 'warning' }),
    );
  });
});

// ============================================================
// UNIFIED DISPATCHER
// ============================================================

describe('validateProtocol (unified dispatcher)', () => {
  it('dispatches to all 9 protocols', () => {
    for (const protocol of PROTOCOL_TYPES) {
      const agentType = protocol === 'consensus' ? 'analysis' : protocol;
      const entry = validEntry(agentType);
      // All should not throw without strict mode
      const result = validateProtocol(protocol, entry);
      expect(result.protocol).toBe(protocol);
    }
  });

  it('throws CleoError in strict mode on validation failure', () => {
    const entry = validEntry('wrong-type');
    expect(() => validateProtocol('research', entry, {}, true)).toThrow(CleoError);
  });

  it('uses correct exit codes for each protocol', () => {
    // Verify exit code mapping covers range 60-67
    const exitCodes = new Set(Object.values(PROTOCOL_EXIT_CODES));
    expect(exitCodes.has(ExitCode.PROTOCOL_MISSING)).toBe(true);       // 60
    expect(exitCodes.has(ExitCode.INVALID_RETURN_MESSAGE)).toBe(true);  // 61
    expect(exitCodes.has(ExitCode.MANIFEST_ENTRY_MISSING)).toBe(true);  // 62
    expect(exitCodes.has(ExitCode.SPAWN_VALIDATION_FAILED)).toBe(true); // 63
    expect(exitCodes.has(ExitCode.AUTONOMOUS_BOUNDARY)).toBe(true);     // 64
    expect(exitCodes.has(ExitCode.HANDOFF_REQUIRED)).toBe(true);        // 65
    expect(exitCodes.has(ExitCode.RESUME_FAILED)).toBe(true);           // 66
    expect(exitCodes.has(ExitCode.CONCURRENT_SESSION)).toBe(true);      // 67
  });

  it('strict mode throws with correct exit code per protocol', () => {
    const testCases: Array<{ protocol: ProtocolType; expectedCode: ExitCode }> = [
      { protocol: 'research', expectedCode: ExitCode.PROTOCOL_MISSING },
      { protocol: 'consensus', expectedCode: ExitCode.INVALID_RETURN_MESSAGE },
      { protocol: 'specification', expectedCode: ExitCode.MANIFEST_ENTRY_MISSING },
      { protocol: 'decomposition', expectedCode: ExitCode.SPAWN_VALIDATION_FAILED },
      { protocol: 'implementation', expectedCode: ExitCode.AUTONOMOUS_BOUNDARY },
      { protocol: 'contribution', expectedCode: ExitCode.HANDOFF_REQUIRED },
      { protocol: 'release', expectedCode: ExitCode.RESUME_FAILED },
      { protocol: 'artifact-publish', expectedCode: ExitCode.CONCURRENT_SESSION },
    ];

    for (const { protocol, expectedCode } of testCases) {
      const entry = validEntry('wrong-type');
      try {
        validateProtocol(protocol, entry, {}, true);
        // Should not reach here
        expect.fail(`Expected CleoError for protocol ${protocol}`);
      } catch (err) {
        expect(err).toBeInstanceOf(CleoError);
        expect((err as CleoError).code).toBe(expectedCode);
      }
    }
  });

  it('PROTOCOL_TYPES contains all 9 protocols', () => {
    expect(PROTOCOL_TYPES).toHaveLength(9);
    expect(PROTOCOL_TYPES).toContain('research');
    expect(PROTOCOL_TYPES).toContain('consensus');
    expect(PROTOCOL_TYPES).toContain('specification');
    expect(PROTOCOL_TYPES).toContain('decomposition');
    expect(PROTOCOL_TYPES).toContain('implementation');
    expect(PROTOCOL_TYPES).toContain('contribution');
    expect(PROTOCOL_TYPES).toContain('release');
    expect(PROTOCOL_TYPES).toContain('artifact-publish');
    expect(PROTOCOL_TYPES).toContain('provenance');
  });
});

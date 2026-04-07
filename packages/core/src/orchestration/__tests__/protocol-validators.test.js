/**
 * Protocol enforcement regression testing - all 9 protocols.
 * Validates exit codes 60-67 and protocol compliance rules.
 *
 * @task T4499
 * @epic T4498
 */
import { ExitCode } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { CleoError } from '../../errors.js';
import { PROTOCOL_EXIT_CODES, PROTOCOL_TYPES, validateArchitectureDecisionProtocol, validateArtifactPublishProtocol, validateConsensusProtocol, validateContributionProtocol, validateDecompositionProtocol, validateImplementationProtocol, validateProtocol, validateProvenanceProtocol, validateReleaseProtocol, validateResearchProtocol, validateSpecificationProtocol, validateTestingProtocol, validateValidationProtocol, } from '../protocol-validators.js';
// ============================================================
// Helper: create valid manifest entry for a protocol
// ============================================================
function validEntry(agentType, overrides = {}) {
    return {
        id: 'T001-test',
        file: 'output/T001-test.md',
        title: 'Test entry',
        date: '2026-01-01',
        status: 'completed',
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
        const result = validateResearchProtocol(validEntry('research', { key_findings: ['one', 'two'] }));
        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(expect.objectContaining({ requirement: 'RSCH-006' }));
    });
    it('fails when key_findings > 7', () => {
        const result = validateResearchProtocol(validEntry('research', { key_findings: Array(8).fill('finding') }));
        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(expect.objectContaining({ requirement: 'RSCH-006' }));
    });
    it('fails when agent_type is wrong', () => {
        const result = validateResearchProtocol(validEntry('implementation'));
        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(expect.objectContaining({ requirement: 'RSCH-007' }));
    });
    it('fails when code changes detected', () => {
        const result = validateResearchProtocol(validEntry('research'), { hasCodeChanges: true });
        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(expect.objectContaining({ requirement: 'RSCH-001' }));
    });
    it('warns about missing sources in strict mode', () => {
        const result = validateResearchProtocol(validEntry('research', { sources: undefined }), {
            strict: true,
        });
        expect(result.violations).toContainEqual(expect.objectContaining({ requirement: 'RSCH-002', severity: 'warning' }));
    });
    it('score decreases with violations', () => {
        const result = validateResearchProtocol(validEntry('implementation', { key_findings: [] }), {
            hasCodeChanges: true,
        });
        expect(result.score).toBeLessThan(50);
    });
});
// ============================================================
// 2. CONSENSUS PROTOCOL (exit code 61)
// ============================================================
describe('Consensus Protocol', () => {
    it('passes valid consensus entry', () => {
        const result = validateConsensusProtocol(validEntry('analysis'), {
            options: [
                { name: 'Option A', confidence: 0.8 },
                { name: 'Option B', confidence: 0.6 },
            ],
        });
        expect(result.valid).toBe(true);
        expect(result.protocol).toBe('consensus');
    });
    it('fails with < 2 options', () => {
        const result = validateConsensusProtocol(validEntry('analysis'), {
            options: [{ name: 'Only one', confidence: 0.9 }],
        });
        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(expect.objectContaining({ requirement: 'CONS-001' }));
    });
    it('fails with invalid confidence scores', () => {
        const result = validateConsensusProtocol(validEntry('analysis'), {
            options: [
                { name: 'A', confidence: 1.5 },
                { name: 'B', confidence: 0.3 },
            ],
        });
        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(expect.objectContaining({ requirement: 'CONS-003' }));
    });
    it('fails when threshold not met', () => {
        const result = validateConsensusProtocol(validEntry('analysis'), {
            options: [
                { name: 'A', confidence: 0.3 },
                { name: 'B', confidence: 0.2 },
            ],
        });
        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(expect.objectContaining({ requirement: 'CONS-004' }));
    });
    it('fails when agent_type is wrong', () => {
        const result = validateConsensusProtocol(validEntry('research'), {
            options: [
                { name: 'A', confidence: 0.8 },
                { name: 'B', confidence: 0.6 },
            ],
        });
        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(expect.objectContaining({ requirement: 'CONS-007' }));
    });
});
// ============================================================
// 3. SPECIFICATION PROTOCOL (exit code 62)
// ============================================================
describe('Specification Protocol', () => {
    it('passes valid spec entry with RFC 2119 keywords', () => {
        const result = validateSpecificationProtocol(validEntry('specification'), 'The system MUST support all protocols. The API SHOULD be versioned.');
        expect(result.valid).toBe(true);
        expect(result.protocol).toBe('specification');
    });
    it('fails without RFC 2119 keywords', () => {
        const result = validateSpecificationProtocol(validEntry('specification'), 'The system supports all protocols. The API is versioned.');
        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(expect.objectContaining({ requirement: 'SPEC-001' }));
    });
    it('fails without output file', () => {
        const result = validateSpecificationProtocol(validEntry('specification', { file: undefined }));
        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(expect.objectContaining({ requirement: 'SPEC-003' }));
    });
    it('fails with wrong agent_type', () => {
        const result = validateSpecificationProtocol(validEntry('research'));
        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(expect.objectContaining({ requirement: 'SPEC-007' }));
    });
});
// ============================================================
// 4. DECOMPOSITION PROTOCOL (exit code 63)
// ============================================================
describe('Decomposition Protocol', () => {
    it('passes valid decomposition entry', () => {
        const result = validateDecompositionProtocol(validEntry('decomposition'), { siblingCount: 5 });
        expect(result.valid).toBe(true);
        expect(result.protocol).toBe('decomposition');
    });
    it('fails with too many siblings', () => {
        const result = validateDecompositionProtocol(validEntry('decomposition'), {
            siblingCount: 10,
            maxSiblings: 7,
        });
        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(expect.objectContaining({ requirement: 'DCOMP-001' }));
    });
    it('fails with unclear descriptions', () => {
        const result = validateDecompositionProtocol(validEntry('decomposition'), {
            descriptionClarity: false,
        });
        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(expect.objectContaining({ requirement: 'DCOMP-002' }));
    });
    it('fails with wrong agent_type', () => {
        const result = validateDecompositionProtocol(validEntry('research'));
        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(expect.objectContaining({ requirement: 'DCOMP-007' }));
    });
});
// ============================================================
// 5. IMPLEMENTATION PROTOCOL (exit code 64)
// ============================================================
describe('Implementation Protocol', () => {
    it('passes valid implementation entry', () => {
        const result = validateImplementationProtocol(validEntry('implementation'), {
            hasTaskTags: true,
        });
        expect(result.valid).toBe(true);
        expect(result.protocol).toBe('implementation');
    });
    it('fails without @task tags', () => {
        const result = validateImplementationProtocol(validEntry('implementation'), {
            hasTaskTags: false,
        });
        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(expect.objectContaining({ requirement: 'IMPL-001' }));
    });
    it('fails without output file', () => {
        const result = validateImplementationProtocol(validEntry('implementation', { file: undefined }));
        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(expect.objectContaining({ requirement: 'IMPL-003' }));
    });
    it('fails without linked tasks', () => {
        const result = validateImplementationProtocol(validEntry('implementation', { linked_tasks: [] }));
        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(expect.objectContaining({ requirement: 'IMPL-004' }));
    });
});
// ============================================================
// 6. CONTRIBUTION PROTOCOL (exit code 65)
// ============================================================
describe('Contribution Protocol', () => {
    it('passes valid contribution entry', () => {
        const result = validateContributionProtocol(validEntry('contribution'), {
            hasContributionTags: true,
        });
        expect(result.valid).toBe(true);
        expect(result.protocol).toBe('contribution');
    });
    it('fails without contribution tags', () => {
        const result = validateContributionProtocol(validEntry('contribution'), {
            hasContributionTags: false,
        });
        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(expect.objectContaining({ requirement: 'CONT-001' }));
    });
    it('fails without linked tasks', () => {
        const result = validateContributionProtocol(validEntry('contribution', { linked_tasks: [] }));
        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(expect.objectContaining({ requirement: 'CONT-003' }));
    });
});
// ============================================================
// 7. RELEASE PROTOCOL (exit code 66)
// ============================================================
describe('Release Protocol', () => {
    it('passes valid release entry', () => {
        const result = validateReleaseProtocol(validEntry('release'), {
            version: '1.0.0',
            hasChangelog: true,
        });
        expect(result.valid).toBe(true);
        expect(result.protocol).toBe('release');
    });
    it('fails with invalid version format', () => {
        const result = validateReleaseProtocol(validEntry('release'), { version: 'not-valid' });
        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(expect.objectContaining({ requirement: 'REL-001' }));
    });
    it('accepts version with pre-release', () => {
        const result = validateReleaseProtocol(validEntry('release'), {
            version: '1.0.0-alpha.1',
            hasChangelog: true,
        });
        expect(result.valid).toBe(true);
    });
    it('fails without changelog', () => {
        const result = validateReleaseProtocol(validEntry('release'), { hasChangelog: false });
        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(expect.objectContaining({ requirement: 'REL-002' }));
    });
});
// ============================================================
// 8. ARTIFACT PUBLISH PROTOCOL (exit code 67)
// ============================================================
describe('Artifact Publish Protocol', () => {
    it('passes valid artifact publish entry', () => {
        const result = validateArtifactPublishProtocol(validEntry('artifact-publish'), {
            artifactType: 'npm',
            buildPassed: true,
        });
        expect(result.valid).toBe(true);
        expect(result.protocol).toBe('artifact-publish');
    });
    it('fails without artifact type', () => {
        const result = validateArtifactPublishProtocol(validEntry('artifact-publish'), {
            buildPassed: true,
        });
        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(expect.objectContaining({ requirement: 'ARTF-001' }));
    });
    it('fails when build did not pass', () => {
        const result = validateArtifactPublishProtocol(validEntry('artifact-publish'), {
            artifactType: 'npm',
            buildPassed: false,
        });
        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(expect.objectContaining({ requirement: 'ARTF-002' }));
    });
});
// ============================================================
// 9. PROVENANCE PROTOCOL (exit code 67)
// ============================================================
describe('Provenance Protocol', () => {
    it('passes valid provenance entry', () => {
        const result = validateProvenanceProtocol(validEntry('provenance'), {
            hasAttestation: true,
            hasSbom: true,
        });
        expect(result.valid).toBe(true);
        expect(result.protocol).toBe('provenance');
    });
    it('fails without attestation', () => {
        const result = validateProvenanceProtocol(validEntry('provenance'), { hasAttestation: false });
        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(expect.objectContaining({ requirement: 'PROV-001' }));
    });
    it('warns about missing SBOM', () => {
        const result = validateProvenanceProtocol(validEntry('provenance'), { hasSbom: false });
        // SBOM is a warning, not error, so valid can still be true
        expect(result.violations).toContainEqual(expect.objectContaining({ requirement: 'PROV-002', severity: 'warning' }));
    });
});
// ============================================================
// 10. ARCHITECTURE DECISION RECORD PROTOCOL (exit code 84)
// ============================================================
describe('Architecture Decision Record Protocol', () => {
    const adrEntry = (overrides = {}) => ({
        ...validEntry('decision'),
        consensus_manifest_id: 'manifest_consensus_2026_04_07',
        ...overrides,
    });
    it('passes a complete ADR entry', () => {
        const result = validateArchitectureDecisionProtocol(adrEntry(), {
            status: 'proposed',
            adrContent: '## Context\n## Options Evaluated\n## Decision\n## Rationale\n## Consequences\n',
            persistedInDb: true,
        });
        expect(result.valid).toBe(true);
        expect(result.protocol).toBe('architecture-decision');
    });
    it('fails without a consensus manifest link (ADR-001)', () => {
        const result = validateArchitectureDecisionProtocol(adrEntry({ consensus_manifest_id: undefined }));
        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(expect.objectContaining({ requirement: 'ADR-001' }));
    });
    it('fails when accepted without HITL review (ADR-003)', () => {
        const result = validateArchitectureDecisionProtocol(adrEntry(), {
            status: 'accepted',
            hitlReviewed: false,
            adrContent: '## Context\n## Options\n## Decision\n## Rationale\n## Consequences\n',
            persistedInDb: true,
        });
        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(expect.objectContaining({ requirement: 'ADR-003' }));
    });
    it('fails when required sections are missing (ADR-004)', () => {
        const result = validateArchitectureDecisionProtocol(adrEntry(), {
            status: 'proposed',
            adrContent: '## Context only',
            persistedInDb: true,
        });
        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(expect.objectContaining({ requirement: 'ADR-004' }));
    });
    it('fails superseded ADR without downstream flag (ADR-005)', () => {
        const result = validateArchitectureDecisionProtocol(adrEntry(), {
            status: 'superseded',
            downstreamFlagged: false,
            adrContent: '## Context\n## Options\n## Decision\n## Rationale\n## Consequences\n',
            persistedInDb: true,
        });
        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(expect.objectContaining({ requirement: 'ADR-005' }));
    });
    it('fails when not persisted in SQLite (ADR-006)', () => {
        const result = validateArchitectureDecisionProtocol(adrEntry(), {
            status: 'proposed',
            persistedInDb: false,
            adrContent: '## Context\n## Options\n## Decision\n## Rationale\n## Consequences\n',
        });
        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(expect.objectContaining({ requirement: 'ADR-006' }));
    });
    it('fails with wrong agent_type (ADR-007)', () => {
        const result = validateArchitectureDecisionProtocol(adrEntry({ agent_type: 'specification' }));
        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(expect.objectContaining({ requirement: 'ADR-007' }));
    });
});
// ============================================================
// 11. VALIDATION PROTOCOL (exit code 80)
// ============================================================
describe('Validation Protocol', () => {
    it('passes a complete validation entry', () => {
        const result = validateValidationProtocol(validEntry('validation'), {
            specMatchConfirmed: true,
            testSuitePassed: true,
            protocolComplianceChecked: true,
        });
        expect(result.valid).toBe(true);
        expect(result.protocol).toBe('validation');
    });
    it('fails when spec-match not confirmed (VALID-001)', () => {
        const result = validateValidationProtocol(validEntry('validation'), {
            specMatchConfirmed: false,
        });
        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(expect.objectContaining({ requirement: 'VALID-001' }));
    });
    it('fails when test suite failed (VALID-002)', () => {
        const result = validateValidationProtocol(validEntry('validation'), {
            testSuitePassed: false,
        });
        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(expect.objectContaining({ requirement: 'VALID-002' }));
    });
    it('fails without key_findings (VALID-005)', () => {
        const result = validateValidationProtocol(validEntry('validation', { key_findings: [] }));
        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(expect.objectContaining({ requirement: 'VALID-005' }));
    });
    it('fails with wrong agent_type (VALID-006)', () => {
        const result = validateValidationProtocol(validEntry('implementation'));
        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(expect.objectContaining({ requirement: 'VALID-006' }));
    });
});
// ============================================================
// 12. TESTING PROTOCOL (project-agnostic IVT loop)
// ============================================================
describe('Testing Protocol', () => {
    it('passes a complete testing entry with any framework', () => {
        const result = validateTestingProtocol(validEntry('testing'), {
            framework: 'vitest',
            testsRun: 42,
            testsPassed: 42,
            testsFailed: 0,
            ivtLoopConverged: true,
        });
        expect(result.valid).toBe(true);
        expect(result.protocol).toBe('testing');
    });
    it('is project-agnostic — accepts any supported framework', () => {
        const frameworks = [
            'vitest',
            'jest',
            'pytest',
            'go-test',
            'cargo-test',
            'rspec',
            'bats',
            'other',
        ];
        for (const framework of frameworks) {
            const result = validateTestingProtocol(validEntry('testing'), {
                framework,
                testsRun: 1,
                testsPassed: 1,
                testsFailed: 0,
                ivtLoopConverged: true,
            });
            expect(result.valid).toBe(true);
        }
    });
    it('fails without a detected framework (TEST-001)', () => {
        const result = validateTestingProtocol(validEntry('testing'), {
            testsRun: 10,
            testsPassed: 10,
            testsFailed: 0,
            ivtLoopConverged: true,
        });
        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(expect.objectContaining({ requirement: 'TEST-001' }));
    });
    it('fails when tests failed (TEST-004)', () => {
        const result = validateTestingProtocol(validEntry('testing'), {
            framework: 'vitest',
            testsRun: 10,
            testsPassed: 8,
            testsFailed: 2,
            ivtLoopConverged: false,
        });
        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(expect.objectContaining({ requirement: 'TEST-004' }));
    });
    it('fails when IVT loop has not converged (TEST-005)', () => {
        const result = validateTestingProtocol(validEntry('testing'), {
            framework: 'vitest',
            ivtLoopConverged: false,
        });
        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(expect.objectContaining({ requirement: 'TEST-005' }));
    });
    it('warns on coverage below threshold (non-blocking)', () => {
        const result = validateTestingProtocol(validEntry('testing'), {
            framework: 'vitest',
            testsRun: 10,
            testsPassed: 10,
            testsFailed: 0,
            ivtLoopConverged: true,
            coveragePercent: 70,
            coverageThreshold: 80,
        });
        expect(result.violations).toContainEqual(expect.objectContaining({ requirement: 'TEST-004', severity: 'warning' }));
    });
    it('fails with wrong agent_type (TEST-007)', () => {
        const result = validateTestingProtocol(validEntry('implementation'), {
            framework: 'vitest',
            ivtLoopConverged: true,
        });
        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(expect.objectContaining({ requirement: 'TEST-007' }));
    });
});
// ============================================================
// UNIFIED DISPATCHER
// ============================================================
describe('validateProtocol (unified dispatcher)', () => {
    it('dispatches to all 12 protocols', () => {
        for (const protocol of PROTOCOL_TYPES) {
            // Map protocol name to expected agent_type
            const agentTypeMap = {
                research: 'research',
                consensus: 'analysis',
                'architecture-decision': 'decision',
                specification: 'specification',
                decomposition: 'decomposition',
                implementation: 'implementation',
                contribution: 'contribution',
                validation: 'validation',
                testing: 'testing',
                release: 'release',
                'artifact-publish': 'artifact-publish',
                provenance: 'provenance',
            };
            const entry = {
                ...validEntry(agentTypeMap[protocol]),
                consensus_manifest_id: 'mf_consensus_test',
            };
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
        // Pipeline codes 60-67 + dedicated codes for cross-cutting protocols
        const exitCodes = new Set(Object.values(PROTOCOL_EXIT_CODES));
        expect(exitCodes.has(ExitCode.PROTOCOL_MISSING)).toBe(true); // 60
        expect(exitCodes.has(ExitCode.INVALID_RETURN_MESSAGE)).toBe(true); // 61
        expect(exitCodes.has(ExitCode.MANIFEST_ENTRY_MISSING)).toBe(true); // 62
        expect(exitCodes.has(ExitCode.SPAWN_VALIDATION_FAILED)).toBe(true); // 63
        expect(exitCodes.has(ExitCode.AUTONOMOUS_BOUNDARY)).toBe(true); // 64
        expect(exitCodes.has(ExitCode.HANDOFF_REQUIRED)).toBe(true); // 65
        expect(exitCodes.has(ExitCode.RESUME_FAILED)).toBe(true); // 66
        expect(exitCodes.has(ExitCode.CONCURRENT_SESSION)).toBe(true); // 67
        expect(exitCodes.has(ExitCode.LIFECYCLE_GATE_FAILED)).toBe(true); // 80 (validation)
        expect(exitCodes.has(ExitCode.PROVENANCE_REQUIRED)).toBe(true); // 84 (ADR)
        expect(exitCodes.has(ExitCode.ARTIFACT_PUBLISH_FAILED)).toBe(true); // 88
        expect(exitCodes.has(ExitCode.ATTESTATION_INVALID)).toBe(true); // 94
    });
    it('strict mode throws with correct exit code per protocol', () => {
        const testCases = [
            { protocol: 'research', expectedCode: ExitCode.PROTOCOL_MISSING },
            { protocol: 'consensus', expectedCode: ExitCode.INVALID_RETURN_MESSAGE },
            { protocol: 'specification', expectedCode: ExitCode.MANIFEST_ENTRY_MISSING },
            { protocol: 'decomposition', expectedCode: ExitCode.SPAWN_VALIDATION_FAILED },
            { protocol: 'implementation', expectedCode: ExitCode.AUTONOMOUS_BOUNDARY },
            { protocol: 'contribution', expectedCode: ExitCode.HANDOFF_REQUIRED },
            { protocol: 'release', expectedCode: ExitCode.RESUME_FAILED },
            { protocol: 'testing', expectedCode: ExitCode.CONCURRENT_SESSION },
            { protocol: 'validation', expectedCode: ExitCode.LIFECYCLE_GATE_FAILED },
            { protocol: 'architecture-decision', expectedCode: ExitCode.PROVENANCE_REQUIRED },
            { protocol: 'artifact-publish', expectedCode: ExitCode.ARTIFACT_PUBLISH_FAILED },
            { protocol: 'provenance', expectedCode: ExitCode.ATTESTATION_INVALID },
        ];
        for (const { protocol, expectedCode } of testCases) {
            const entry = validEntry('wrong-type');
            try {
                validateProtocol(protocol, entry, {}, true);
                // Should not reach here
                expect.fail(`Expected CleoError for protocol ${protocol}`);
            }
            catch (err) {
                expect(err).toBeInstanceOf(CleoError);
                expect(err.code).toBe(expectedCode);
            }
        }
    });
    it('PROTOCOL_TYPES contains all 12 protocols', () => {
        expect(PROTOCOL_TYPES).toHaveLength(12);
        expect(PROTOCOL_TYPES).toContain('research');
        expect(PROTOCOL_TYPES).toContain('consensus');
        expect(PROTOCOL_TYPES).toContain('architecture-decision');
        expect(PROTOCOL_TYPES).toContain('specification');
        expect(PROTOCOL_TYPES).toContain('decomposition');
        expect(PROTOCOL_TYPES).toContain('implementation');
        expect(PROTOCOL_TYPES).toContain('contribution');
        expect(PROTOCOL_TYPES).toContain('validation');
        expect(PROTOCOL_TYPES).toContain('testing');
        expect(PROTOCOL_TYPES).toContain('release');
        expect(PROTOCOL_TYPES).toContain('artifact-publish');
        expect(PROTOCOL_TYPES).toContain('provenance');
    });
});
//# sourceMappingURL=protocol-validators.test.js.map
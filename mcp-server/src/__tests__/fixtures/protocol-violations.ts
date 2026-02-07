/**
 * Protocol Violation Fixtures for Testing
 *
 * @task T2923
 * @epic T2908
 *
 * Sample violations and valid examples for each RCSD-IVTR protocol.
 */

/**
 * Research Protocol Fixtures (Exit Code 60)
 */
export const researchViolations = {
  // RSCH-001: Code modifications
  codeModified: {
    manifestEntry: {
      id: 'T2001-research',
      file: 'research.md',
      date: '2026-02-04',
      title: 'Research output',
      status: 'complete',
      agent_type: 'research',
      key_findings: ['Finding 1', 'Finding 2', 'Finding 3'],
      linked_tasks: ['T2001'],
    },
    additionalData: {
      hasCodeChanges: true, // Violation: research should not modify code
    },
  },

  // RSCH-006: Insufficient key findings
  insufficientFindings: {
    manifestEntry: {
      id: 'T2002-research',
      file: 'research.md',
      date: '2026-02-04',
      title: 'Research output',
      status: 'complete',
      agent_type: 'research',
      key_findings: ['Only one finding'], // Violation: need 3-7
      linked_tasks: ['T2002'],
    },
    additionalData: {},
  },

  // RSCH-007: Wrong agent_type
  wrongAgentType: {
    manifestEntry: {
      id: 'T2003-research',
      file: 'research.md',
      date: '2026-02-04',
      title: 'Research output',
      status: 'complete',
      agent_type: 'implementation', // Violation: should be 'research'
      key_findings: ['Finding 1', 'Finding 2', 'Finding 3'],
      linked_tasks: ['T2003'],
    },
    additionalData: {},
  },

  // RSCH-003: Missing linked_tasks
  missingLinkedTasks: {
    manifestEntry: {
      id: 'T2029-research',
      file: 'research.md',
      date: '2026-02-04',
      status: 'complete',
      agent_type: 'research',
      title: 'Research findings',
      key_findings: ['Finding 1', 'Finding 2', 'Finding 3'],
      sources: ['https://example.com/doc'],
      // linked_tasks missing
    },
    additionalData: {
      hasCodeChanges: false,
    },
  },

  // Valid research
  valid: {
    manifestEntry: {
      id: 'T2004-research',
      file: 'research.md',
      date: '2026-02-04',
      status: 'complete',
      agent_type: 'research',
      title: 'Research findings',
      key_findings: ['Finding 1', 'Finding 2', 'Finding 3', 'Finding 4'],
      sources: ['https://example.com/doc'],
      linked_tasks: ['T2000', 'T2004'],
    },
    additionalData: {
      hasCodeChanges: false,
    },
  },
};

/**
 * Consensus Protocol Fixtures (Exit Code 61)
 */
export const consensusViolations = {
  // CONS-001: Too few options
  tooFewOptions: {
    manifestEntry: {
      id: 'T2005-consensus',
      file: 'consensus.md',
      date: '2026-02-04',
      status: 'complete',
      agent_type: 'analysis',
    },
    additionalData: {
      votingMatrix: {
        options: [{ confidence: 0.8 }], // Violation: need ≥2 options
      },
    },
  },

  // CONS-003: Invalid confidence scores
  invalidConfidence: {
    manifestEntry: {
      id: 'T2006-consensus',
      file: 'consensus.md',
      date: '2026-02-04',
      status: 'complete',
      agent_type: 'analysis',
    },
    additionalData: {
      votingMatrix: {
        options: [
          { confidence: 1.5 }, // Violation: > 1.0
          { confidence: 0.3 },
        ],
      },
    },
  },

  // CONS-004: Threshold not met
  thresholdNotMet: {
    manifestEntry: {
      id: 'T2007-consensus',
      file: 'consensus.md',
      date: '2026-02-04',
      status: 'complete',
      agent_type: 'analysis',
    },
    additionalData: {
      votingMatrix: {
        options: [
          { confidence: 0.4 }, // Violation: max < 0.5
          { confidence: 0.3 },
        ],
      },
    },
  },

  // CONS-006: Threshold not met without HITL escalation
  noEscalation: {
    manifestEntry: {
      id: 'T2028-consensus',
      file: 'consensus.md',
      date: '2026-02-04',
      status: 'complete',
      agent_type: 'analysis',
    },
    additionalData: {
      votingMatrix: {
        options: [
          { confidence: 0.3, rationale: 'Option A analysis' },
          { confidence: 0.4, rationale: 'Option B analysis' },
        ],
      },
    },
  },

  // Valid consensus
  valid: {
    manifestEntry: {
      id: 'T2008-consensus',
      file: 'consensus.md',
      date: '2026-02-04',
      status: 'complete',
      agent_type: 'analysis',
    },
    additionalData: {
      votingMatrix: {
        options: [
          { confidence: 0.8, rationale: 'Strong evidence supporting option A' },
          { confidence: 0.2, rationale: 'Limited support for option B' },
        ],
        notes: 'Decision reached with high confidence',
      },
    },
  },
};

/**
 * Specification Protocol Fixtures (Exit Code 62)
 */
export const specificationViolations = {
  // SPEC-001: Missing RFC 2119 keywords
  missingRFC2119: {
    manifestEntry: {
      id: 'T2009-spec',
      file: 'spec.md',
      date: '2026-02-04',
      status: 'complete',
      agent_type: 'specification',
      version: '1.0.0',
    },
    additionalData: {
      fileContent: 'This is a specification without any keywords.', // No MUST/SHOULD/MAY
    },
  },

  // SPEC-002: Missing version
  missingVersion: {
    manifestEntry: {
      id: 'T2010-spec',
      file: 'spec.md',
      date: '2026-02-04',
      status: 'complete',
      agent_type: 'specification',
      // version missing
    },
    additionalData: {
      fileContent: 'The system MUST validate inputs.',
    },
  },

  // Valid specification
  valid: {
    manifestEntry: {
      id: 'T2011-spec',
      file: 'spec.md',
      date: '2026-02-04',
      status: 'complete',
      agent_type: 'specification',
      version: '1.0.0',
    },
    additionalData: {
      fileContent: 'The system MUST validate inputs. It SHOULD log errors. MAY retry.',
    },
  },
};

/**
 * Decomposition Protocol Fixtures (Exit Code 63)
 */
export const decompositionViolations = {
  // DCMP-003: Depth exceeded
  depthExceeded: {
    manifestEntry: {
      id: 'T2012-decomp',
      file: 'decomp.md',
      date: '2026-02-04',
      status: 'complete',
      agent_type: 'specification',
    },
    additionalData: {
      hierarchyDepth: 4, // Violation: max is 3
    },
  },

  // DCMP-006: Too many siblings
  tooManySiblings: {
    manifestEntry: {
      id: 'T2013-decomp',
      file: 'decomp.md',
      date: '2026-02-04',
      status: 'complete',
      agent_type: 'specification',
    },
    additionalData: {
      siblingCount: 8, // Violation: max is 7
    },
  },

  // DCMP-005: Time estimates
  timeEstimates: {
    manifestEntry: {
      id: 'T2014-decomp',
      file: 'decomp.md',
      date: '2026-02-04',
      status: 'complete',
      agent_type: 'specification',
      title: 'Task will take 3 hours', // Violation: time estimate
      description: 'Implementation',
    },
    additionalData: {},
  },

  // Valid decomposition
  valid: {
    manifestEntry: {
      id: 'T2015-decomp',
      file: 'decomp.md',
      date: '2026-02-04',
      status: 'complete',
      agent_type: 'specification',
      title: 'Create authentication module',
      description: 'Implement OAuth2 flow',
    },
    additionalData: {
      hierarchyDepth: 2,
      siblingCount: 5,
    },
  },
};

/**
 * Implementation Protocol Fixtures (Exit Code 64)
 */
export const implementationViolations = {
  // IMPL-003: Missing provenance tags
  missingProvenanceTags: {
    manifestEntry: {
      id: 'T2016-impl',
      file: 'code.ts',
      date: '2026-02-04',
      status: 'complete',
      agent_type: 'implementation',
    },
    additionalData: {
      hasNewFunctions: true,
      hasProvenanceTags: false, // Violation: new functions without @task tags
    },
  },

  // IMPL-007: Wrong agent_type
  wrongAgentType: {
    manifestEntry: {
      id: 'T2017-impl',
      file: 'code.ts',
      date: '2026-02-04',
      status: 'complete',
      agent_type: 'research', // Violation: should be 'implementation'
    },
    additionalData: {
      hasNewFunctions: false,
    },
  },

  // Valid implementation
  valid: {
    manifestEntry: {
      id: 'T2018-impl',
      file: 'code.ts',
      date: '2026-02-04',
      status: 'complete',
      agent_type: 'implementation',
    },
    additionalData: {
      hasNewFunctions: true,
      hasProvenanceTags: true,
    },
  },
};

/**
 * Release Protocol Fixtures (Exit Code 66)
 */
export const releaseViolations = {
  // RLSE-001: Invalid semver
  invalidSemver: {
    manifestEntry: {
      id: 'T2019-release',
      file: 'CHANGELOG.md',
      date: '2026-02-04',
      status: 'complete',
      agent_type: 'release',
    },
    additionalData: {
      version: 'v1.0', // Violation: not proper semver (X.Y.Z)
      changelogEntry: 'Release notes',
    },
  },

  // RLSE-002: Missing changelog
  missingChangelog: {
    manifestEntry: {
      id: 'T2020-release',
      file: 'VERSION',
      date: '2026-02-04',
      status: 'complete',
      agent_type: 'release',
    },
    additionalData: {
      version: '1.0.0',
      // changelogEntry missing
    },
  },

  // Valid release
  valid: {
    manifestEntry: {
      id: 'T2021-release',
      file: 'CHANGELOG.md',
      date: '2026-02-04',
      status: 'complete',
      agent_type: 'release',
    },
    additionalData: {
      version: '1.0.0',
      changelogEntry: '## 1.0.0\n\n- Initial release',
    },
  },
};

/**
 * Validation Protocol Fixtures (Exit Code 68)
 */
export const validationViolations = {
  // VALID-001: Missing validation_result
  missingValidationResult: {
    manifestEntry: {
      id: 'T2022-validation',
      file: 'validation.md',
      date: '2026-02-04',
      status: 'complete',
      agent_type: 'validation',
      // validation_result missing
    },
    additionalData: {},
  },

  // VALID-003: Invalid status
  invalidStatus: {
    manifestEntry: {
      id: 'T2023-validation',
      file: 'validation.md',
      date: '2026-02-04',
      status: 'invalid', // Violation: not in enum
      agent_type: 'validation',
      validation_result: 'passed',
    },
    additionalData: {},
  },

  // Valid validation
  valid: {
    manifestEntry: {
      id: 'T2024-validation',
      file: 'validation.md',
      date: '2026-02-04',
      status: 'complete',
      agent_type: 'validation',
      validation_result: 'passed',
      key_findings: ['All tests passed', 'No violations found'],
    },
    additionalData: {},
  },
};

/**
 * Testing Protocol Fixtures (Exit Codes 69/70)
 */
export const testingViolations = {
  // TEST-004: Pass rate below 100%
  failingTests: {
    manifestEntry: {
      id: 'T2025-testing',
      file: 'test-results.md',
      date: '2026-02-04',
      status: 'complete',
      agent_type: 'testing',
      key_findings: ['10 tests passed', '2 tests failed'],
    },
    additionalData: {
      testResults: {
        pass_rate: 0.83, // Violation: must be 1.0
      },
    },
  },

  // TEST-006: Missing test summary
  missingTestSummary: {
    manifestEntry: {
      id: 'T2026-testing',
      file: 'test-results.md',
      date: '2026-02-04',
      status: 'complete',
      agent_type: 'testing',
      // key_findings missing
    },
    additionalData: {
      testResults: {
        pass_rate: 1.0,
      },
    },
  },

  // Valid testing
  valid: {
    manifestEntry: {
      id: 'T2027-testing',
      file: 'test-results.md',
      date: '2026-02-04',
      status: 'complete',
      agent_type: 'testing',
      key_findings: ['All 50 tests passed', 'Coverage: 95%'],
    },
    additionalData: {
      testResults: {
        pass_rate: 1.0,
      },
    },
  },
};

/**
 * Contribution Protocol Fixtures (Exit Code 65)
 */
export const contributionViolations = {
  // CONT-001: Invalid commit message
  invalidCommitMessage: {
    manifestEntry: {
      id: 'T2030-contribution',
      file: 'code.ts',
      date: '2026-02-04',
      status: 'complete',
      agent_type: 'implementation',
    },
    additionalData: {
      commitMessage: 'updated some stuff', // Violation: not following conventions
      hasNewFunctions: false,
    },
  },

  // CONT-003: Validation gates not passed
  validationNotPassed: {
    manifestEntry: {
      id: 'T2031-contribution',
      file: 'code.ts',
      date: '2026-02-04',
      status: 'complete',
      agent_type: 'implementation',
    },
    additionalData: {
      commitMessage: 'feat: add new feature',
      validationPassed: false, // Violation: gates not passed
      hasNewFunctions: false,
    },
  },

  // Valid contribution
  valid: {
    manifestEntry: {
      id: 'T2032-contribution',
      file: 'code.ts',
      date: '2026-02-04',
      status: 'complete',
      agent_type: 'implementation',
    },
    additionalData: {
      commitMessage: 'feat(auth): add OAuth2 flow',
      hasNewFunctions: true,
      hasProvenanceTags: true,
      validationPassed: true,
    },
  },
};

/**
 * Combined fixture export
 */
export const protocolFixtures = {
  research: researchViolations,
  consensus: consensusViolations,
  specification: specificationViolations,
  decomposition: decompositionViolations,
  implementation: implementationViolations,
  contribution: contributionViolations,
  release: releaseViolations,
  validation: validationViolations,
  testing: testingViolations,
};

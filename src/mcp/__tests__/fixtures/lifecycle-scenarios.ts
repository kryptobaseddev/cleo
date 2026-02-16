/**
 * Lifecycle Gate Scenario Fixtures for Testing
 *
 * @task T2923
 * @epic T2908
 *
 * Epic states and gate failure scenarios for lifecycle enforcement testing.
 */

/**
 * RCSD Pipeline States
 */

export const rcsdStates = {
  // No RCSD stages completed
  noRCSD: {
    epicId: 'T3000',
    manifest: null, // No manifest exists
  },

  // Partial RCSD (only research complete)
  researchOnly: {
    epicId: 'T3001',
    manifest: {
      research: 'completed',
      consensus: 'pending',
      specification: 'pending',
      decomposition: 'pending',
    },
  },

  // Partial RCSD (research + consensus complete)
  researchAndConsensus: {
    epicId: 'T3002',
    manifest: {
      research: 'completed',
      consensus: 'completed',
      specification: 'pending',
      decomposition: 'pending',
    },
  },

  // Partial RCSD (research + consensus + spec complete)
  upToSpecification: {
    epicId: 'T3003',
    manifest: {
      research: 'completed',
      consensus: 'completed',
      specification: 'completed',
      decomposition: 'pending',
    },
  },

  // Complete RCSD (all stages done)
  completeRCSD: {
    epicId: 'T3004',
    manifest: {
      research: 'completed',
      consensus: 'completed',
      specification: 'completed',
      decomposition: 'completed',
    },
  },

  // RCSD with skipped stage (consensus skipped)
  consensusSkipped: {
    epicId: 'T3005',
    manifest: {
      research: 'completed',
      consensus: 'skipped', // Skipped stages count as passed
      specification: 'completed',
      decomposition: 'completed',
    },
  },

  // RCSD with failed stage
  specificationFailed: {
    epicId: 'T3006',
    manifest: {
      research: 'completed',
      consensus: 'completed',
      specification: 'failed', // Failed stage blocks progression
      decomposition: 'pending',
    },
  },
};

/**
 * IVTR Pipeline States
 */

export const ivtrStates = {
  // Only implementation complete
  implementationOnly: {
    epicId: 'T3010',
    manifest: {
      research: 'completed',
      consensus: 'completed',
      specification: 'completed',
      decomposition: 'completed',
      implementation: 'completed',
      validation: 'pending',
      testing: 'pending',
      release: 'pending',
    },
  },

  // Implementation + validation complete
  validationComplete: {
    epicId: 'T3011',
    manifest: {
      research: 'completed',
      consensus: 'completed',
      specification: 'completed',
      decomposition: 'completed',
      implementation: 'completed',
      validation: 'completed',
      testing: 'pending',
      release: 'pending',
    },
  },

  // Ready for release (all stages complete)
  readyForRelease: {
    epicId: 'T3012',
    manifest: {
      research: 'completed',
      consensus: 'completed',
      specification: 'completed',
      decomposition: 'completed',
      implementation: 'completed',
      validation: 'completed',
      testing: 'completed',
      release: 'pending',
    },
  },

  // Release complete (full lifecycle)
  releaseComplete: {
    epicId: 'T3013',
    manifest: {
      research: 'completed',
      consensus: 'completed',
      specification: 'completed',
      decomposition: 'completed',
      implementation: 'completed',
      validation: 'completed',
      testing: 'completed',
      release: 'completed',
    },
  },
};

/**
 * Gate Failure Scenarios
 */

export const gateFailures = {
  // Try to skip to implementation without RCSD
  skipToImplementation: {
    epicId: 'T3020',
    targetStage: 'implementation',
    currentManifest: null, // No RCSD done
    expectedResult: {
      passed: false,
      missingPrerequisites: ['research', 'consensus', 'specification', 'decomposition'],
      exitCode: 75, // E_LIFECYCLE_GATE_FAILED
    },
  },

  // Try consensus without research
  consensusWithoutResearch: {
    epicId: 'T3021',
    targetStage: 'consensus',
    currentManifest: {
      research: 'pending',
    },
    expectedResult: {
      passed: false,
      missingPrerequisites: ['research'],
      exitCode: 75,
    },
  },

  // Try decomposition without specification
  decompositionWithoutSpec: {
    epicId: 'T3022',
    targetStage: 'decomposition',
    currentManifest: {
      research: 'completed',
      consensus: 'completed',
      specification: 'pending',
    },
    expectedResult: {
      passed: false,
      missingPrerequisites: ['specification'],
      exitCode: 75,
    },
  },

  // Try validation without implementation
  validationWithoutImplementation: {
    epicId: 'T3023',
    targetStage: 'validation',
    currentManifest: {
      research: 'completed',
      consensus: 'completed',
      specification: 'completed',
      decomposition: 'completed',
      implementation: 'pending',
    },
    expectedResult: {
      passed: false,
      missingPrerequisites: ['implementation'],
      exitCode: 75,
    },
  },

  // Try release without testing
  releaseWithoutTesting: {
    epicId: 'T3024',
    targetStage: 'release',
    currentManifest: {
      research: 'completed',
      consensus: 'completed',
      specification: 'completed',
      decomposition: 'completed',
      implementation: 'completed',
      validation: 'completed',
      testing: 'pending',
    },
    expectedResult: {
      passed: false,
      missingPrerequisites: ['testing'],
      exitCode: 75,
    },
  },
};

/**
 * Gate Success Scenarios
 */

export const gateSuccesses = {
  // Valid progression: research → consensus
  researchToConsensus: {
    epicId: 'T3030',
    targetStage: 'consensus',
    currentManifest: {
      research: 'completed',
    },
    expectedResult: {
      passed: true,
      missingPrerequisites: [],
    },
  },

  // Valid progression: with skipped stage
  withSkippedStage: {
    epicId: 'T3031',
    targetStage: 'specification',
    currentManifest: {
      research: 'completed',
      consensus: 'skipped', // Skipped is acceptable
    },
    expectedResult: {
      passed: true,
      missingPrerequisites: [],
    },
  },

  // Valid progression: complete RCSD to implementation
  completeRCSDToImplementation: {
    epicId: 'T3032',
    targetStage: 'implementation',
    currentManifest: {
      research: 'completed',
      consensus: 'completed',
      specification: 'completed',
      decomposition: 'completed',
    },
    expectedResult: {
      passed: true,
      missingPrerequisites: [],
    },
  },

  // Valid progression: ready for release
  readyForRelease: {
    epicId: 'T3033',
    targetStage: 'release',
    currentManifest: {
      research: 'completed',
      consensus: 'completed',
      specification: 'completed',
      decomposition: 'completed',
      implementation: 'completed',
      validation: 'completed',
      testing: 'completed',
    },
    expectedResult: {
      passed: true,
      missingPrerequisites: [],
    },
  },
};

/**
 * Enforcement Mode Scenarios
 */

export const enforcementModes = {
  // Strict mode: blocks on gate failure
  strict: {
    mode: 'strict',
    gateFailure: gateFailures.skipToImplementation,
    expectedBehavior: 'block', // Should return error with exit code 75
  },

  // Advisory mode: warns but allows
  advisory: {
    mode: 'advisory',
    gateFailure: gateFailures.skipToImplementation,
    expectedBehavior: 'warn', // Should log warning but proceed
  },

  // Off mode: no checks
  off: {
    mode: 'off',
    gateFailure: gateFailures.skipToImplementation,
    expectedBehavior: 'allow', // Should proceed without checks
  },
};

/**
 * Gate Bypass Scenarios (emergency use only)
 */

export const bypassScenarios = {
  // Emergency bypass via config
  configBypass: {
    epicId: 'T3040',
    targetStage: 'implementation',
    currentManifest: null,
    config: {
      lifecycleEnforcement: {
        mode: 'off', // Bypass all checks
      },
    },
    expectedResult: {
      passed: true, // Should pass despite missing prerequisites
      bypassUsed: true,
    },
  },

  // Selective stage skip
  stageSkip: {
    epicId: 'T3041',
    targetStage: 'specification',
    currentManifest: {
      research: 'completed',
      consensus: 'skipped', // Explicitly skipped
    },
    config: {
      lifecycleEnforcement: {
        mode: 'strict',
        allowSkip: ['consensus'], // Consensus can be skipped
      },
    },
    expectedResult: {
      passed: true,
    },
  },
};

/**
 * Combined lifecycle scenario export
 */
export const lifecycleScenarios = {
  rcsd: rcsdStates,
  ivtr: ivtrStates,
  failures: gateFailures,
  successes: gateSuccesses,
  modes: enforcementModes,
  bypasses: bypassScenarios,
};

/**
 * Protocol Violation Fixtures for Testing
 *
 * @task T2923
 * @epic T2908
 *
 * Sample violations and valid examples for each RCASD-IVTR+C protocol.
 */
/**
 * Research Protocol Fixtures (Exit Code 60)
 */
export declare const researchViolations: {
  codeModified: {
    manifestEntry: {
      id: string;
      file: string;
      date: string;
      title: string;
      status: string;
      agent_type: string;
      key_findings: string[];
      linked_tasks: string[];
    };
    additionalData: {
      hasCodeChanges: boolean;
    };
  };
  insufficientFindings: {
    manifestEntry: {
      id: string;
      file: string;
      date: string;
      title: string;
      status: string;
      agent_type: string;
      key_findings: string[];
      linked_tasks: string[];
    };
    additionalData: {};
  };
  wrongAgentType: {
    manifestEntry: {
      id: string;
      file: string;
      date: string;
      title: string;
      status: string;
      agent_type: string;
      key_findings: string[];
      linked_tasks: string[];
    };
    additionalData: {};
  };
  missingLinkedTasks: {
    manifestEntry: {
      id: string;
      file: string;
      date: string;
      status: string;
      agent_type: string;
      title: string;
      key_findings: string[];
      sources: string[];
    };
    additionalData: {
      hasCodeChanges: boolean;
    };
  };
  valid: {
    manifestEntry: {
      id: string;
      file: string;
      date: string;
      status: string;
      agent_type: string;
      title: string;
      key_findings: string[];
      sources: string[];
      linked_tasks: string[];
    };
    additionalData: {
      hasCodeChanges: boolean;
    };
  };
};
/**
 * Consensus Protocol Fixtures (Exit Code 61)
 */
export declare const consensusViolations: {
  tooFewOptions: {
    manifestEntry: {
      id: string;
      file: string;
      date: string;
      status: string;
      agent_type: string;
    };
    additionalData: {
      votingMatrix: {
        options: {
          confidence: number;
        }[];
      };
    };
  };
  invalidConfidence: {
    manifestEntry: {
      id: string;
      file: string;
      date: string;
      status: string;
      agent_type: string;
    };
    additionalData: {
      votingMatrix: {
        options: {
          confidence: number;
        }[];
      };
    };
  };
  thresholdNotMet: {
    manifestEntry: {
      id: string;
      file: string;
      date: string;
      status: string;
      agent_type: string;
    };
    additionalData: {
      votingMatrix: {
        options: {
          confidence: number;
        }[];
      };
    };
  };
  noEscalation: {
    manifestEntry: {
      id: string;
      file: string;
      date: string;
      status: string;
      agent_type: string;
    };
    additionalData: {
      votingMatrix: {
        options: {
          confidence: number;
          rationale: string;
        }[];
      };
    };
  };
  valid: {
    manifestEntry: {
      id: string;
      file: string;
      date: string;
      status: string;
      agent_type: string;
    };
    additionalData: {
      votingMatrix: {
        options: {
          confidence: number;
          rationale: string;
        }[];
        notes: string;
      };
    };
  };
};
/**
 * Specification Protocol Fixtures (Exit Code 62)
 */
export declare const specificationViolations: {
  missingRFC2119: {
    manifestEntry: {
      id: string;
      file: string;
      date: string;
      status: string;
      agent_type: string;
      version: string;
    };
    additionalData: {
      fileContent: string;
    };
  };
  missingVersion: {
    manifestEntry: {
      id: string;
      file: string;
      date: string;
      status: string;
      agent_type: string;
    };
    additionalData: {
      fileContent: string;
    };
  };
  valid: {
    manifestEntry: {
      id: string;
      file: string;
      date: string;
      status: string;
      agent_type: string;
      version: string;
    };
    additionalData: {
      fileContent: string;
    };
  };
};
/**
 * Decomposition Protocol Fixtures (Exit Code 63)
 */
export declare const decompositionViolations: {
  depthExceeded: {
    manifestEntry: {
      id: string;
      file: string;
      date: string;
      status: string;
      agent_type: string;
    };
    additionalData: {
      hierarchyDepth: number;
    };
  };
  tooManySiblings: {
    manifestEntry: {
      id: string;
      file: string;
      date: string;
      status: string;
      agent_type: string;
    };
    additionalData: {
      siblingCount: number;
    };
  };
  timeEstimates: {
    manifestEntry: {
      id: string;
      file: string;
      date: string;
      status: string;
      agent_type: string;
      title: string;
      description: string;
    };
    additionalData: {};
  };
  valid: {
    manifestEntry: {
      id: string;
      file: string;
      date: string;
      status: string;
      agent_type: string;
      title: string;
      description: string;
    };
    additionalData: {
      hierarchyDepth: number;
      siblingCount: number;
    };
  };
};
/**
 * Implementation Protocol Fixtures (Exit Code 64)
 */
export declare const implementationViolations: {
  missingProvenanceTags: {
    manifestEntry: {
      id: string;
      file: string;
      date: string;
      status: string;
      agent_type: string;
    };
    additionalData: {
      hasNewFunctions: boolean;
      hasProvenanceTags: boolean;
    };
  };
  wrongAgentType: {
    manifestEntry: {
      id: string;
      file: string;
      date: string;
      status: string;
      agent_type: string;
    };
    additionalData: {
      hasNewFunctions: boolean;
    };
  };
  valid: {
    manifestEntry: {
      id: string;
      file: string;
      date: string;
      status: string;
      agent_type: string;
    };
    additionalData: {
      hasNewFunctions: boolean;
      hasProvenanceTags: boolean;
    };
  };
};
/**
 * Release Protocol Fixtures (Exit Code 66)
 */
export declare const releaseViolations: {
  invalidSemver: {
    manifestEntry: {
      id: string;
      file: string;
      date: string;
      status: string;
      agent_type: string;
    };
    additionalData: {
      version: string;
      changelogEntry: string;
    };
  };
  missingChangelog: {
    manifestEntry: {
      id: string;
      file: string;
      date: string;
      status: string;
      agent_type: string;
    };
    additionalData: {
      version: string;
    };
  };
  valid: {
    manifestEntry: {
      id: string;
      file: string;
      date: string;
      status: string;
      agent_type: string;
    };
    additionalData: {
      version: string;
      changelogEntry: string;
    };
  };
};
/**
 * Validation Protocol Fixtures (Exit Code 68)
 */
export declare const validationViolations: {
  missingValidationResult: {
    manifestEntry: {
      id: string;
      file: string;
      date: string;
      status: string;
      agent_type: string;
    };
    additionalData: {};
  };
  invalidStatus: {
    manifestEntry: {
      id: string;
      file: string;
      date: string;
      status: string;
      agent_type: string;
      validation_result: string;
    };
    additionalData: {};
  };
  valid: {
    manifestEntry: {
      id: string;
      file: string;
      date: string;
      status: string;
      agent_type: string;
      validation_result: string;
      key_findings: string[];
    };
    additionalData: {};
  };
};
/**
 * Testing Protocol Fixtures (Exit Codes 69/70)
 */
export declare const testingViolations: {
  failingTests: {
    manifestEntry: {
      id: string;
      file: string;
      date: string;
      status: string;
      agent_type: string;
      key_findings: string[];
    };
    additionalData: {
      testResults: {
        pass_rate: number;
      };
    };
  };
  missingTestSummary: {
    manifestEntry: {
      id: string;
      file: string;
      date: string;
      status: string;
      agent_type: string;
    };
    additionalData: {
      testResults: {
        pass_rate: number;
      };
    };
  };
  valid: {
    manifestEntry: {
      id: string;
      file: string;
      date: string;
      status: string;
      agent_type: string;
      key_findings: string[];
    };
    additionalData: {
      testResults: {
        pass_rate: number;
      };
    };
  };
};
/**
 * Contribution Protocol Fixtures (Exit Code 65)
 */
export declare const contributionViolations: {
  invalidCommitMessage: {
    manifestEntry: {
      id: string;
      file: string;
      date: string;
      status: string;
      agent_type: string;
    };
    additionalData: {
      commitMessage: string;
      hasNewFunctions: boolean;
    };
  };
  validationNotPassed: {
    manifestEntry: {
      id: string;
      file: string;
      date: string;
      status: string;
      agent_type: string;
    };
    additionalData: {
      commitMessage: string;
      validationPassed: boolean;
      hasNewFunctions: boolean;
    };
  };
  valid: {
    manifestEntry: {
      id: string;
      file: string;
      date: string;
      status: string;
      agent_type: string;
    };
    additionalData: {
      commitMessage: string;
      hasNewFunctions: boolean;
      hasProvenanceTags: boolean;
      validationPassed: boolean;
    };
  };
};
/**
 * Combined fixture export
 */
export declare const protocolFixtures: {
  research: {
    codeModified: {
      manifestEntry: {
        id: string;
        file: string;
        date: string;
        title: string;
        status: string;
        agent_type: string;
        key_findings: string[];
        linked_tasks: string[];
      };
      additionalData: {
        hasCodeChanges: boolean;
      };
    };
    insufficientFindings: {
      manifestEntry: {
        id: string;
        file: string;
        date: string;
        title: string;
        status: string;
        agent_type: string;
        key_findings: string[];
        linked_tasks: string[];
      };
      additionalData: {};
    };
    wrongAgentType: {
      manifestEntry: {
        id: string;
        file: string;
        date: string;
        title: string;
        status: string;
        agent_type: string;
        key_findings: string[];
        linked_tasks: string[];
      };
      additionalData: {};
    };
    missingLinkedTasks: {
      manifestEntry: {
        id: string;
        file: string;
        date: string;
        status: string;
        agent_type: string;
        title: string;
        key_findings: string[];
        sources: string[];
      };
      additionalData: {
        hasCodeChanges: boolean;
      };
    };
    valid: {
      manifestEntry: {
        id: string;
        file: string;
        date: string;
        status: string;
        agent_type: string;
        title: string;
        key_findings: string[];
        sources: string[];
        linked_tasks: string[];
      };
      additionalData: {
        hasCodeChanges: boolean;
      };
    };
  };
  consensus: {
    tooFewOptions: {
      manifestEntry: {
        id: string;
        file: string;
        date: string;
        status: string;
        agent_type: string;
      };
      additionalData: {
        votingMatrix: {
          options: {
            confidence: number;
          }[];
        };
      };
    };
    invalidConfidence: {
      manifestEntry: {
        id: string;
        file: string;
        date: string;
        status: string;
        agent_type: string;
      };
      additionalData: {
        votingMatrix: {
          options: {
            confidence: number;
          }[];
        };
      };
    };
    thresholdNotMet: {
      manifestEntry: {
        id: string;
        file: string;
        date: string;
        status: string;
        agent_type: string;
      };
      additionalData: {
        votingMatrix: {
          options: {
            confidence: number;
          }[];
        };
      };
    };
    noEscalation: {
      manifestEntry: {
        id: string;
        file: string;
        date: string;
        status: string;
        agent_type: string;
      };
      additionalData: {
        votingMatrix: {
          options: {
            confidence: number;
            rationale: string;
          }[];
        };
      };
    };
    valid: {
      manifestEntry: {
        id: string;
        file: string;
        date: string;
        status: string;
        agent_type: string;
      };
      additionalData: {
        votingMatrix: {
          options: {
            confidence: number;
            rationale: string;
          }[];
          notes: string;
        };
      };
    };
  };
  specification: {
    missingRFC2119: {
      manifestEntry: {
        id: string;
        file: string;
        date: string;
        status: string;
        agent_type: string;
        version: string;
      };
      additionalData: {
        fileContent: string;
      };
    };
    missingVersion: {
      manifestEntry: {
        id: string;
        file: string;
        date: string;
        status: string;
        agent_type: string;
      };
      additionalData: {
        fileContent: string;
      };
    };
    valid: {
      manifestEntry: {
        id: string;
        file: string;
        date: string;
        status: string;
        agent_type: string;
        version: string;
      };
      additionalData: {
        fileContent: string;
      };
    };
  };
  decomposition: {
    depthExceeded: {
      manifestEntry: {
        id: string;
        file: string;
        date: string;
        status: string;
        agent_type: string;
      };
      additionalData: {
        hierarchyDepth: number;
      };
    };
    tooManySiblings: {
      manifestEntry: {
        id: string;
        file: string;
        date: string;
        status: string;
        agent_type: string;
      };
      additionalData: {
        siblingCount: number;
      };
    };
    timeEstimates: {
      manifestEntry: {
        id: string;
        file: string;
        date: string;
        status: string;
        agent_type: string;
        title: string;
        description: string;
      };
      additionalData: {};
    };
    valid: {
      manifestEntry: {
        id: string;
        file: string;
        date: string;
        status: string;
        agent_type: string;
        title: string;
        description: string;
      };
      additionalData: {
        hierarchyDepth: number;
        siblingCount: number;
      };
    };
  };
  implementation: {
    missingProvenanceTags: {
      manifestEntry: {
        id: string;
        file: string;
        date: string;
        status: string;
        agent_type: string;
      };
      additionalData: {
        hasNewFunctions: boolean;
        hasProvenanceTags: boolean;
      };
    };
    wrongAgentType: {
      manifestEntry: {
        id: string;
        file: string;
        date: string;
        status: string;
        agent_type: string;
      };
      additionalData: {
        hasNewFunctions: boolean;
      };
    };
    valid: {
      manifestEntry: {
        id: string;
        file: string;
        date: string;
        status: string;
        agent_type: string;
      };
      additionalData: {
        hasNewFunctions: boolean;
        hasProvenanceTags: boolean;
      };
    };
  };
  contribution: {
    invalidCommitMessage: {
      manifestEntry: {
        id: string;
        file: string;
        date: string;
        status: string;
        agent_type: string;
      };
      additionalData: {
        commitMessage: string;
        hasNewFunctions: boolean;
      };
    };
    validationNotPassed: {
      manifestEntry: {
        id: string;
        file: string;
        date: string;
        status: string;
        agent_type: string;
      };
      additionalData: {
        commitMessage: string;
        validationPassed: boolean;
        hasNewFunctions: boolean;
      };
    };
    valid: {
      manifestEntry: {
        id: string;
        file: string;
        date: string;
        status: string;
        agent_type: string;
      };
      additionalData: {
        commitMessage: string;
        hasNewFunctions: boolean;
        hasProvenanceTags: boolean;
        validationPassed: boolean;
      };
    };
  };
  release: {
    invalidSemver: {
      manifestEntry: {
        id: string;
        file: string;
        date: string;
        status: string;
        agent_type: string;
      };
      additionalData: {
        version: string;
        changelogEntry: string;
      };
    };
    missingChangelog: {
      manifestEntry: {
        id: string;
        file: string;
        date: string;
        status: string;
        agent_type: string;
      };
      additionalData: {
        version: string;
      };
    };
    valid: {
      manifestEntry: {
        id: string;
        file: string;
        date: string;
        status: string;
        agent_type: string;
      };
      additionalData: {
        version: string;
        changelogEntry: string;
      };
    };
  };
  validation: {
    missingValidationResult: {
      manifestEntry: {
        id: string;
        file: string;
        date: string;
        status: string;
        agent_type: string;
      };
      additionalData: {};
    };
    invalidStatus: {
      manifestEntry: {
        id: string;
        file: string;
        date: string;
        status: string;
        agent_type: string;
        validation_result: string;
      };
      additionalData: {};
    };
    valid: {
      manifestEntry: {
        id: string;
        file: string;
        date: string;
        status: string;
        agent_type: string;
        validation_result: string;
        key_findings: string[];
      };
      additionalData: {};
    };
  };
  testing: {
    failingTests: {
      manifestEntry: {
        id: string;
        file: string;
        date: string;
        status: string;
        agent_type: string;
        key_findings: string[];
      };
      additionalData: {
        testResults: {
          pass_rate: number;
        };
      };
    };
    missingTestSummary: {
      manifestEntry: {
        id: string;
        file: string;
        date: string;
        status: string;
        agent_type: string;
      };
      additionalData: {
        testResults: {
          pass_rate: number;
        };
      };
    };
    valid: {
      manifestEntry: {
        id: string;
        file: string;
        date: string;
        status: string;
        agent_type: string;
        key_findings: string[];
      };
      additionalData: {
        testResults: {
          pass_rate: number;
        };
      };
    };
  };
};
//# sourceMappingURL=protocol-violations.d.ts.map

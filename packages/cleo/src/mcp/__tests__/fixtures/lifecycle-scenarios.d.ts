/**
 * Lifecycle Gate Scenario Fixtures for Testing
 *
 * @task T2923
 * @epic T2908
 *
 * Epic states and gate failure scenarios for lifecycle enforcement testing.
 */
/**
 * RCASD-IVTR+C Pipeline States
 */
export declare const rcasdStates: {
    noRCASD: {
        epicId: string;
        manifest: null;
    };
    researchOnly: {
        epicId: string;
        manifest: {
            research: string;
            consensus: string;
            specification: string;
            decomposition: string;
        };
    };
    researchAndConsensus: {
        epicId: string;
        manifest: {
            research: string;
            consensus: string;
            architecture_decision: string;
            specification: string;
            decomposition: string;
        };
    };
    upToSpecification: {
        epicId: string;
        manifest: {
            research: string;
            consensus: string;
            architecture_decision: string;
            specification: string;
            decomposition: string;
        };
    };
    completeRCASD: {
        epicId: string;
        manifest: {
            research: string;
            consensus: string;
            architecture_decision: string;
            specification: string;
            decomposition: string;
        };
    };
    consensusSkipped: {
        epicId: string;
        manifest: {
            research: string;
            consensus: string;
            architecture_decision: string;
            specification: string;
            decomposition: string;
        };
    };
    specificationFailed: {
        epicId: string;
        manifest: {
            research: string;
            consensus: string;
            architecture_decision: string;
            specification: string;
            decomposition: string;
        };
    };
};
/**
 * IVTR Pipeline States
 */
export declare const ivtrStates: {
    implementationOnly: {
        epicId: string;
        manifest: {
            research: string;
            consensus: string;
            architecture_decision: string;
            specification: string;
            decomposition: string;
            implementation: string;
            validation: string;
            testing: string;
            release: string;
        };
    };
    validationComplete: {
        epicId: string;
        manifest: {
            research: string;
            consensus: string;
            architecture_decision: string;
            specification: string;
            decomposition: string;
            implementation: string;
            validation: string;
            testing: string;
            release: string;
        };
    };
    readyForRelease: {
        epicId: string;
        manifest: {
            research: string;
            consensus: string;
            architecture_decision: string;
            specification: string;
            decomposition: string;
            implementation: string;
            validation: string;
            testing: string;
            release: string;
        };
    };
    releaseComplete: {
        epicId: string;
        manifest: {
            research: string;
            consensus: string;
            architecture_decision: string;
            specification: string;
            decomposition: string;
            implementation: string;
            validation: string;
            testing: string;
            release: string;
        };
    };
};
/**
 * Gate Failure Scenarios
 */
export declare const gateFailures: {
    skipToImplementation: {
        epicId: string;
        targetStage: string;
        currentManifest: null;
        expectedResult: {
            passed: boolean;
            missingPrerequisites: string[];
            exitCode: number;
        };
    };
    consensusWithoutResearch: {
        epicId: string;
        targetStage: string;
        currentManifest: {
            research: string;
        };
        expectedResult: {
            passed: boolean;
            missingPrerequisites: string[];
            exitCode: number;
        };
    };
    decompositionWithoutSpec: {
        epicId: string;
        targetStage: string;
        currentManifest: {
            research: string;
            consensus: string;
            specification: string;
        };
        expectedResult: {
            passed: boolean;
            missingPrerequisites: string[];
            exitCode: number;
        };
    };
    validationWithoutImplementation: {
        epicId: string;
        targetStage: string;
        currentManifest: {
            research: string;
            consensus: string;
            specification: string;
            decomposition: string;
            implementation: string;
        };
        expectedResult: {
            passed: boolean;
            missingPrerequisites: string[];
            exitCode: number;
        };
    };
    releaseWithoutTesting: {
        epicId: string;
        targetStage: string;
        currentManifest: {
            research: string;
            consensus: string;
            specification: string;
            decomposition: string;
            implementation: string;
            validation: string;
            testing: string;
        };
        expectedResult: {
            passed: boolean;
            missingPrerequisites: string[];
            exitCode: number;
        };
    };
};
/**
 * Gate Success Scenarios
 */
export declare const gateSuccesses: {
    researchToConsensus: {
        epicId: string;
        targetStage: string;
        currentManifest: {
            research: string;
        };
        expectedResult: {
            passed: boolean;
            missingPrerequisites: never[];
        };
    };
    withSkippedStage: {
        epicId: string;
        targetStage: string;
        currentManifest: {
            research: string;
            consensus: string;
            architecture_decision: string;
        };
        expectedResult: {
            passed: boolean;
            missingPrerequisites: never[];
        };
    };
    completeRCASDToImplementation: {
        epicId: string;
        targetStage: string;
        currentManifest: {
            research: string;
            consensus: string;
            architecture_decision: string;
            specification: string;
            decomposition: string;
        };
        expectedResult: {
            passed: boolean;
            missingPrerequisites: never[];
        };
    };
    readyForRelease: {
        epicId: string;
        targetStage: string;
        currentManifest: {
            research: string;
            consensus: string;
            architecture_decision: string;
            specification: string;
            decomposition: string;
            implementation: string;
            validation: string;
            testing: string;
        };
        expectedResult: {
            passed: boolean;
            missingPrerequisites: never[];
        };
    };
};
/**
 * Enforcement Mode Scenarios
 */
export declare const enforcementModes: {
    strict: {
        mode: string;
        gateFailure: {
            epicId: string;
            targetStage: string;
            currentManifest: null;
            expectedResult: {
                passed: boolean;
                missingPrerequisites: string[];
                exitCode: number;
            };
        };
        expectedBehavior: string;
    };
    advisory: {
        mode: string;
        gateFailure: {
            epicId: string;
            targetStage: string;
            currentManifest: null;
            expectedResult: {
                passed: boolean;
                missingPrerequisites: string[];
                exitCode: number;
            };
        };
        expectedBehavior: string;
    };
    off: {
        mode: string;
        gateFailure: {
            epicId: string;
            targetStage: string;
            currentManifest: null;
            expectedResult: {
                passed: boolean;
                missingPrerequisites: string[];
                exitCode: number;
            };
        };
        expectedBehavior: string;
    };
};
/**
 * Gate Bypass Scenarios (emergency use only)
 */
export declare const bypassScenarios: {
    configBypass: {
        epicId: string;
        targetStage: string;
        currentManifest: null;
        config: {
            lifecycleEnforcement: {
                mode: string;
            };
        };
        expectedResult: {
            passed: boolean;
            bypassUsed: boolean;
        };
    };
    stageSkip: {
        epicId: string;
        targetStage: string;
        currentManifest: {
            research: string;
            consensus: string;
        };
        config: {
            lifecycleEnforcement: {
                mode: string;
                allowSkip: string[];
            };
        };
        expectedResult: {
            passed: boolean;
        };
    };
};
/**
 * Combined lifecycle scenario export
 */
export declare const lifecycleScenarios: {
    rcasd: {
        noRCASD: {
            epicId: string;
            manifest: null;
        };
        researchOnly: {
            epicId: string;
            manifest: {
                research: string;
                consensus: string;
                specification: string;
                decomposition: string;
            };
        };
        researchAndConsensus: {
            epicId: string;
            manifest: {
                research: string;
                consensus: string;
                architecture_decision: string;
                specification: string;
                decomposition: string;
            };
        };
        upToSpecification: {
            epicId: string;
            manifest: {
                research: string;
                consensus: string;
                architecture_decision: string;
                specification: string;
                decomposition: string;
            };
        };
        completeRCASD: {
            epicId: string;
            manifest: {
                research: string;
                consensus: string;
                architecture_decision: string;
                specification: string;
                decomposition: string;
            };
        };
        consensusSkipped: {
            epicId: string;
            manifest: {
                research: string;
                consensus: string;
                architecture_decision: string;
                specification: string;
                decomposition: string;
            };
        };
        specificationFailed: {
            epicId: string;
            manifest: {
                research: string;
                consensus: string;
                architecture_decision: string;
                specification: string;
                decomposition: string;
            };
        };
    };
    ivtr: {
        implementationOnly: {
            epicId: string;
            manifest: {
                research: string;
                consensus: string;
                architecture_decision: string;
                specification: string;
                decomposition: string;
                implementation: string;
                validation: string;
                testing: string;
                release: string;
            };
        };
        validationComplete: {
            epicId: string;
            manifest: {
                research: string;
                consensus: string;
                architecture_decision: string;
                specification: string;
                decomposition: string;
                implementation: string;
                validation: string;
                testing: string;
                release: string;
            };
        };
        readyForRelease: {
            epicId: string;
            manifest: {
                research: string;
                consensus: string;
                architecture_decision: string;
                specification: string;
                decomposition: string;
                implementation: string;
                validation: string;
                testing: string;
                release: string;
            };
        };
        releaseComplete: {
            epicId: string;
            manifest: {
                research: string;
                consensus: string;
                architecture_decision: string;
                specification: string;
                decomposition: string;
                implementation: string;
                validation: string;
                testing: string;
                release: string;
            };
        };
    };
    failures: {
        skipToImplementation: {
            epicId: string;
            targetStage: string;
            currentManifest: null;
            expectedResult: {
                passed: boolean;
                missingPrerequisites: string[];
                exitCode: number;
            };
        };
        consensusWithoutResearch: {
            epicId: string;
            targetStage: string;
            currentManifest: {
                research: string;
            };
            expectedResult: {
                passed: boolean;
                missingPrerequisites: string[];
                exitCode: number;
            };
        };
        decompositionWithoutSpec: {
            epicId: string;
            targetStage: string;
            currentManifest: {
                research: string;
                consensus: string;
                specification: string;
            };
            expectedResult: {
                passed: boolean;
                missingPrerequisites: string[];
                exitCode: number;
            };
        };
        validationWithoutImplementation: {
            epicId: string;
            targetStage: string;
            currentManifest: {
                research: string;
                consensus: string;
                specification: string;
                decomposition: string;
                implementation: string;
            };
            expectedResult: {
                passed: boolean;
                missingPrerequisites: string[];
                exitCode: number;
            };
        };
        releaseWithoutTesting: {
            epicId: string;
            targetStage: string;
            currentManifest: {
                research: string;
                consensus: string;
                specification: string;
                decomposition: string;
                implementation: string;
                validation: string;
                testing: string;
            };
            expectedResult: {
                passed: boolean;
                missingPrerequisites: string[];
                exitCode: number;
            };
        };
    };
    successes: {
        researchToConsensus: {
            epicId: string;
            targetStage: string;
            currentManifest: {
                research: string;
            };
            expectedResult: {
                passed: boolean;
                missingPrerequisites: never[];
            };
        };
        withSkippedStage: {
            epicId: string;
            targetStage: string;
            currentManifest: {
                research: string;
                consensus: string;
                architecture_decision: string;
            };
            expectedResult: {
                passed: boolean;
                missingPrerequisites: never[];
            };
        };
        completeRCASDToImplementation: {
            epicId: string;
            targetStage: string;
            currentManifest: {
                research: string;
                consensus: string;
                architecture_decision: string;
                specification: string;
                decomposition: string;
            };
            expectedResult: {
                passed: boolean;
                missingPrerequisites: never[];
            };
        };
        readyForRelease: {
            epicId: string;
            targetStage: string;
            currentManifest: {
                research: string;
                consensus: string;
                architecture_decision: string;
                specification: string;
                decomposition: string;
                implementation: string;
                validation: string;
                testing: string;
            };
            expectedResult: {
                passed: boolean;
                missingPrerequisites: never[];
            };
        };
    };
    modes: {
        strict: {
            mode: string;
            gateFailure: {
                epicId: string;
                targetStage: string;
                currentManifest: null;
                expectedResult: {
                    passed: boolean;
                    missingPrerequisites: string[];
                    exitCode: number;
                };
            };
            expectedBehavior: string;
        };
        advisory: {
            mode: string;
            gateFailure: {
                epicId: string;
                targetStage: string;
                currentManifest: null;
                expectedResult: {
                    passed: boolean;
                    missingPrerequisites: string[];
                    exitCode: number;
                };
            };
            expectedBehavior: string;
        };
        off: {
            mode: string;
            gateFailure: {
                epicId: string;
                targetStage: string;
                currentManifest: null;
                expectedResult: {
                    passed: boolean;
                    missingPrerequisites: string[];
                    exitCode: number;
                };
            };
            expectedBehavior: string;
        };
    };
    bypasses: {
        configBypass: {
            epicId: string;
            targetStage: string;
            currentManifest: null;
            config: {
                lifecycleEnforcement: {
                    mode: string;
                };
            };
            expectedResult: {
                passed: boolean;
                bypassUsed: boolean;
            };
        };
        stageSkip: {
            epicId: string;
            targetStage: string;
            currentManifest: {
                research: string;
                consensus: string;
            };
            config: {
                lifecycleEnforcement: {
                    mode: string;
                    allowSkip: string[];
                };
            };
            expectedResult: {
                passed: boolean;
            };
        };
    };
};
//# sourceMappingURL=lifecycle-scenarios.d.ts.map
/**
 * Validate Engine — re-export shim.
 *
 * All business logic has been migrated to `@cleocode/core/validation/engine-ops`
 * (ENG-MIG-7 / T1574). This file is a pure re-export shim kept to avoid
 * breaking existing imports in tests and internal tooling.
 *
 * @task T1574 — ENG-MIG-7
 * @epic T1566
 */

export type {
  GateVerifyParams,
  GateVerifyResult,
  ProtocolValidationParams,
} from '@cleocode/core/internal';
// Legacy validate-ops wrapper exports — still used by lib/engine.ts
export {
  coreBatchValidate as validateBatchValidate,
  coreCoherenceCheck as validateCoherenceCheck,
  coreComplianceRecord as validateComplianceRecord,
  coreComplianceSummary as validateComplianceSummary,
  coreComplianceViolations as validateComplianceViolations,
  coreTestCoverage as validateTestCoverage,
  coreTestRun as validateTestRun,
  coreTestStatus as validateTestStatus,
  coreValidateManifest as validateManifest,
  coreValidateOutput as validateOutput,
  coreValidateProtocol as validateProtocol,
  coreValidateSchema as validateSchemaOp,
  coreValidateTask as validateTask,
  validateGateVerify,
  validateProtocolArchitectureDecision,
  validateProtocolArtifactPublish,
  validateProtocolConsensus,
  validateProtocolContribution,
  validateProtocolDecomposition,
  validateProtocolImplementation,
  validateProtocolProvenance,
  validateProtocolRelease,
  validateProtocolResearch,
  validateProtocolSpecification,
  validateProtocolTesting,
  validateProtocolValidation,
} from '@cleocode/core/internal';

/**
 * Data Safety Central - Unit Tests
 *
 * Tests the centralized safety manager that wraps all data operations
 * with sequence validation, write verification, and checkpointing.
 *
 * Coverage:
 * - safeSaveTaskFile: sequence check -> write -> verify -> checkpoint
 * - safeSaveSessions: write -> verify -> checkpoint
 * - safeSaveArchive: write -> verify -> checkpoint
 * - safeAppendLog: write -> checkpoint (no verification)
 * - runDataIntegrityCheck: comprehensive validation
 * - getSafetyStats / resetSafetyStats: statistics tracking
 * - enableSafety / disableSafety: runtime toggle
 *
 * @task T4741
 * @epic T4732
 */
export {};
//# sourceMappingURL=data-safety-central.test.d.ts.map
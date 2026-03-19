/**
 * Regression test: lifecycle resume flow schema contract.
 *
 * Guards against T4809 regression where the lifecycle resume flow in
 * src/core/lifecycle/resume.ts queries columns from the SQLite schema
 * defined in src/store/schema.ts. If schema columns are renamed, removed,
 * or have their enum values changed, these tests will catch the mismatch.
 *
 * This test is purely structural — it validates that the Drizzle schema
 * tables export the exact column shapes resume.ts depends on. No database
 * is needed.
 *
 * @task T4809
 */
export {};
//# sourceMappingURL=resume-schema-contract.test.d.ts.map

/**
 * Session Context Safety Integration Tests
 *
 * Engine-level tests verifying:
 * - session.find returns minimal records (no heavy fields)
 * - session.list enforces default limit=10 with canonical page metadata
 * - session.list respects explicit limits
 * - session.find filters by status and scope
 * - Budget enforcement prevents unbounded queries
 *
 * @task T5122
 */
export {};
//# sourceMappingURL=session-safety.test.d.ts.map
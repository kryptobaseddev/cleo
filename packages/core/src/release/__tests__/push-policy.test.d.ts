/**
 * Tests for release push policy configuration.
 *
 * Tests config-driven push behavior without requiring a real git remote.
 * The pushRelease() function reads config.release.push and enforces:
 * - enabled: whether push is allowed by default
 * - requireCleanTree: whether working tree must be clean
 * - allowedBranches: which branches can be pushed from
 * - remote: which remote to use
 *
 * @task T4276
 */
export {};
//# sourceMappingURL=push-policy.test.d.ts.map

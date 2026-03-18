/**
 * Tests for agent protocol guard on release.push.
 *
 * When running in agent context (CLEO_SESSION_ID or CLAUDE_AGENT_TYPE set),
 * release.push must require a manifest entry for the version. This prevents
 * agents from bypassing provenance tracking via direct git push.
 *
 * @task T4279
 */
export {};
//# sourceMappingURL=release-push-guard.test.d.ts.map
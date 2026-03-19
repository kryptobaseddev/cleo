/**
 * Regression test: cliError signature compatibility.
 *
 * Guards against T4808 regression where the cliError function signature
 * in src/cli/renderers/index.ts diverged from the call sites in:
 *   - src/dispatch/adapters/cli.ts (dispatchFromCli error path)
 *   - src/cli/commands/add.ts (add command error path)
 *
 * If the signature changes incompatibly, these tests will fail at
 * compile-time (via tsc --noEmit) or at runtime (via vitest).
 *
 * @task T4808
 */
export {};
//# sourceMappingURL=cli-error-signature.test.d.ts.map

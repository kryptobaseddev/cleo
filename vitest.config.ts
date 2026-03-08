import { defineConfig } from "vitest/config";

process.env.NODE_NO_WARNINGS ??= "1";

// Tests excluded in CI due to spawn-heavy CLI execution (~5-9 min on Windows).
// Run locally with: npx vitest run --config vitest.config.ts (no SKIP_SLOW_TESTS)
// Or explicitly: npx vitest run src/mcp/gateways/__tests__/mutate.integration.test.ts
const SLOW_TESTS = [
  "src/mcp/gateways/__tests__/mutate.integration.test.ts",
  "src/mcp/__tests__/e2e/error-handling.test.ts",
];

const excluded = process.env.CI === "true" ? [...SLOW_TESTS] : [];

/**
 * Vitest configuration for CLEO V2
 * @epic T4454
 */
export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: [
            "node_modules",
            "dist",
            "src/**/*.integration.test.ts",
            "src/**/*e2e*.test.ts",
            "src/mcp/__tests__/e2e/**/*.test.ts",
            ...excluded,
          ],
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["src/**/*.integration.test.ts", "tests/integration/**/*.test.ts"],
          exclude: ["node_modules", "dist", ...excluded],
          sequence: { groupOrder: 2 },
        },
      },
      {
        extends: true,
        test: {
          name: "e2e",
          include: [
            "tests/e2e/**/*.test.ts",
            "src/**/*e2e*.test.ts",
            "src/mcp/__tests__/e2e/**/*.test.ts",
          ],
          exclude: ["node_modules", "dist", ...excluded],
          testTimeout: 60_000,
          sequence: { groupOrder: 3 },
        },
      },
    ],
  },
  resolve: {
    alias: {
      "node:sqlite": "node:sqlite",
    },
  },
});

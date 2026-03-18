import { defineConfig } from 'vitest/config';
export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: [
            'packages/*/src/**/*.test.ts',
            'packages/*/src/**/__tests__/*.test.ts',
        ],
        exclude: ['node_modules', 'dist', '**/node_modules/**'],
        // Path aliases matching tsconfig — resolve workspace packages to source
        // TypeScript so Vitest can import them without a build step.
        alias: {
            '@cleocode/contracts': new URL('./packages/contracts/src/index.ts', import.meta.url).pathname,
            '@cleocode/core/internal': new URL('./packages/core/src/internal.ts', import.meta.url).pathname,
            '@cleocode/core': new URL('./packages/core/src/index.ts', import.meta.url).pathname,
            '@cleocode/adapters': new URL('./packages/adapters/src/index.ts', import.meta.url).pathname,
        },
    },
});
//# sourceMappingURL=vitest.config.js.map
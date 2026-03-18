import { defineConfig } from 'drizzle-kit';
export default defineConfig({
    schema: './packages/core/src/store/brain-schema.ts',
    out: './migrations/drizzle-brain',
    dialect: 'sqlite',
});
//# sourceMappingURL=drizzle-brain.config.js.map
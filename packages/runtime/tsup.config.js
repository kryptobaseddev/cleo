import { defineConfig } from "tsup";
export default defineConfig({
    entry: {
        index: "src/index.ts",
    },
    format: ["esm"],
    target: "node20",
    dts: {
        compilerOptions: {
            composite: false,
        },
    },
    clean: true,
    sourcemap: true,
});
//# sourceMappingURL=tsup.config.js.map
import { defineConfig } from "tsup";
export default defineConfig({
    entry: {
        cli: "src/cli.ts",
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
    splitting: true,
    sourcemap: true,
});
//# sourceMappingURL=tsup.config.js.map
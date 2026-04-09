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
      // tsup (via rollup-plugin-dts) injects a baseUrl into its internal
      // tsconfig, which TypeScript 6 flags as TS5101 (deprecated). We
      // silence the deprecation until the tsup/rollup-plugin-dts chain
      // catches up with TS 6+.
      ignoreDeprecations: "6.0",
    },
  },
  clean: true,
  splitting: true,
  sourcemap: true,
});

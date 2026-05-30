import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "daemon/index": "src/daemon/index.ts",
    "gateway/index": "src/gateway/index.ts",
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

import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "daemon/index": "src/daemon/index.ts",
    "gateway/index": "src/gateway/index.ts",
    "gateway/mcp/index": "src/gateway/mcp/index.ts",
    "gateway/rpc/index": "src/gateway/rpc/index.ts",
    "gateway/http/index": "src/gateway/http/index.ts",
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

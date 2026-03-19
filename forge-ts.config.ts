import type { ForgeConfig } from "@forge-ts/core";

/**
 * forge-ts configuration for CLEO documentation generation.
 * 
 * Enforces TSDoc coverage as a build gate and generates all documentation
 * artifacts from source code in one pass.
 */
export default {
  rootDir: ".",
  outDir: "./docs/generated",
  enforce: {
    enabled: true,
    minVisibility: "public",
    strict: false,
    rules: {
      // Core contracts need full documentation
      "require-example": "error",
      "require-package-doc": "error",
      "require-param": "error",
      "require-returns": "error",
      // Warnings for optional documentation
      "require-member-doc": "warn",
    },
  },
  gen: {
    formats: ["markdown", "mdx"],
    llmsTxt: true,
    llmsFullTxt: true,
    ssgTarget: "mintlify",
    includePrivate: false,
  },
  packages: [
    {
      name: "@cleocode/contracts",
      entry: "./packages/contracts/src/index.ts",
      outDir: "./docs/generated/contracts",
    },
    {
      name: "@cleocode/core",
      entry: "./packages/core/src/index.ts",
      outDir: "./docs/generated/core",
    },
    {
      name: "@cleocode/adapters",
      entry: "./packages/adapters/src/index.ts",
      outDir: "./docs/generated/adapters",
    },
    {
      name: "@cleocode/cleo",
      entry: "./packages/cleo/src/index.ts",
      outDir: "./docs/generated/cleo",
    },
  ],
} satisfies Partial<ForgeConfig>;

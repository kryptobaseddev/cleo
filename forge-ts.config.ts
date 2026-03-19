/**
 * forge-ts configuration for CLEO documentation generation.
 * 
 * Enforces TSDoc coverage as a build gate and generates all documentation
 * artifacts from source code in one pass.
 */
export default {
  rootDir: ".",
  tsconfig: "./tsconfig.json",
  outDir: "./docs/generated",
  enforce: {
    enabled: true,
    minVisibility: "public",
    strict: false,
    rules: {
      "require-example": "error",
      "require-package-doc": "error",
      "require-param": "error",
      "require-returns": "error",
      "require-class-member-doc": "warn",
      "require-interface-member-doc": "warn",
    },
  },
  gen: {
    formats: ["markdown", "mdx"],
    llmsTxt: true,
    ssgTarget: "mintlify",
  },
  project: {
    packageName: "@cleocode/monorepo",
  },
};

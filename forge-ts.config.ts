/**
 * forge-ts configuration for CLEO documentation generation.
 *
 * Enforces TSDoc coverage as a build gate and generates all documentation
 * artifacts from source code in one pass.
 *
 * rootDir points to packages/core so that forge-ts scans Core source files
 * for @example doctest blocks. The tsconfig is the core package's own
 * tsconfig which has explicit strictNullChecks/noImplicitAny (required by
 * forge-ts E009 guard).
 */
export default {
  rootDir: "./packages/core",
  tsconfig: "./packages/core/tsconfig.json",
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

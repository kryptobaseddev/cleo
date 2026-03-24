import type { ForgeConfig } from "@forge-ts/core";

export default {
  rootDir: ".",
  outDir: "./docs/generated",
  enforce: {
    rules: {
      "require-summary": "error",
      "require-param": "error",
      "require-returns": "error",
      "require-example": "error",
      "require-package-doc": "warn",
      "require-class-member-doc": "error",
      "require-interface-member-doc": "error",
      "require-remarks": "error",
      "require-default-value": "warn",
      "require-type-param": "error",
      "require-see": "warn",
      "require-tsdoc-syntax": "warn",
      "require-release-tag": "error",
      "require-fresh-guides": "warn",
      "require-guide-coverage": "warn",
    },
  },
} satisfies Partial<ForgeConfig>;

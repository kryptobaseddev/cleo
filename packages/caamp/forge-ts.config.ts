import { type ForgeConfig, Visibility } from "@forge-ts/core";

export default {
  rootDir: ".",
  outDir: "./docs/generated",
  enforce: {
    enabled: true,
    minVisibility: Visibility.Public,
    strict: false,
    rules: {
      "require-summary": "error",
      "require-param": "error",
      "require-returns": "error",
      "require-example": "error",
      "require-package-doc": "warn",
      "require-class-member-doc": "error",
      "require-interface-member-doc": "error",
    },
  },
} satisfies Partial<ForgeConfig>;

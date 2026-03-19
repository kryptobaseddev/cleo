# forge-ts Configuration Reference

## Config File Resolution

forge-ts looks for configuration in this order:
1. `forge-ts.config.ts` in the project root
2. `forge-ts.config.js` in the project root
3. `"forge-ts"` key in `package.json`
4. Built-in defaults

## Full Configuration

```typescript
import type { ForgeConfig } from "@forge-ts/core";

export default {
  rootDir: ".",
  tsconfig: "./tsconfig.json",
  outDir: "./docs/generated",

  enforce: {
    enabled: true,
    // "public" | "beta" | "internal"
    minVisibility: "public",
    strict: false,
    rules: {
      "require-summary": "error",           // E001
      "require-param": "error",             // E002
      "require-returns": "error",           // E003
      "require-example": "error",           // E004
      "require-package-doc": "warn",        // E005
      "require-class-member-doc": "error",  // E006
      "require-interface-member-doc": "error", // E007
    },
  },

  doctest: {
    enabled: true,
    cacheDir: ".cache/doctest",
  },

  api: {
    enabled: true,
    openapi: true,
    openapiPath: "./docs/generated/api/openapi.json",
  },

  gen: {
    enabled: true,
    formats: ["markdown"],      // "markdown" | "mdx"
    llmsTxt: true,
    readmeSync: false,
    ssgTarget: "mintlify",      // "mintlify" | "docusaurus" | "nextra" | "vitepress"
  },

  // Auto-detected from package.json if not set
  project: {
    repository: "https://github.com/user/repo",
    homepage: "https://example.com",
    packageName: "@scope/package-name",
  },
} satisfies Partial<ForgeConfig>;
```

## Defaults

| Option | Default |
|--------|---------|
| `enforce.enabled` | `true` |
| `enforce.minVisibility` | `"public"` |
| `enforce.strict` | `false` |
| `doctest.enabled` | `true` |
| `api.enabled` | `false` |
| `gen.enabled` | `true` |
| `gen.llmsTxt` | `true` |
| `gen.ssgTarget` | Mintlify (default adapter) |

## Project Metadata

Auto-populated from `package.json`:
- `repository` from `repository.url`
- `homepage` from `homepage`
- `packageName` from `name`

Used in generated documentation links, install commands, and SSG configs.

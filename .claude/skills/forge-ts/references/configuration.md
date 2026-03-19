# forge-ts Configuration Reference

## Config File Resolution

forge-ts looks for configuration in this order:
1. `forge-ts.config.ts` in the project root
2. `forge-ts.config.js` in the project root
3. `"forge-ts"` key in `package.json`
4. Built-in defaults

Unknown keys produce a warning to stderr and in the JSON envelope
(`result._warnings`). They are not rejected — config loading is lenient.

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
    enabled: false,
    openapi: false,
    openapiPath: "./docs/generated/api/openapi.json",
  },

  gen: {
    enabled: true,
    formats: ["markdown"],      // "markdown" | "mdx"
    llmsTxt: true,
    readmeSync: false,
    ssgTarget: "mintlify",      // "mintlify" | "docusaurus" | "nextra" | "vitepress"
  },

  skill: {
    enabled: true,              // defaults to gen.llmsTxt value
    customSections: [],
    extraGotchas: [],
  },

  // Auto-detected from package.json if not set
  project: {
    repository: "https://github.com/user/repo",
    homepage: "https://example.com",
    packageName: "@scope/package-name",
    description: "Short description",
    version: "1.0.0",
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
| `gen.ssgTarget` | `undefined` (Mintlify used as default adapter) |
| `skill.enabled` | follows `gen.llmsTxt` |

## Project Metadata

Auto-populated from `package.json`:
- `repository` from `repository.url` (git+https normalized)
- `homepage` from `homepage`
- `packageName` from `name`
- `description` from `description`
- `version` from `version`
- `bin` from `bin` (CLI detection for script generation)
- `scripts` from `scripts`
- `keywords` from `keywords`

Used in generated documentation links, install commands, SSG configs,
and skill package content.

## Skill Configuration

See [skill-config.md](skill-config.md) for detailed skill package
configuration including custom sections and extra gotchas.

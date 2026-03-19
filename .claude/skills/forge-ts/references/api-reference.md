# forge-ts Programmatic API

## Table of Contents

- [Core Functions](#core-functions)
- [Visibility](#visibility)
- [Key Types](#key-types)
- [Enforcer](#enforcer)
- [DocTest](#doctest)
- [API Generator](#api-generator)
- [Site Generator](#site-generator)
- [SSG Adapters](#ssg-adapters)

## Core Functions

### defaultConfig

```typescript
import { defaultConfig } from "@forge-ts/core";
const config = defaultConfig("/path/to/project");
// Returns ForgeConfig with sensible defaults
```

### loadConfig

```typescript
import { loadConfig } from "@forge-ts/core";
const config = await loadConfig("/path/to/project");
// Resolves: config.ts → config.js → package.json → defaults
```

### walkProject

```typescript
import { walkProject } from "@forge-ts/core";
const symbols: ForgeSymbol[] = walkProject(config);
// Extracts all exported symbols with TSDoc from the AST
```

## Visibility

```typescript
import { Visibility, resolveVisibility, meetsVisibility, filterByVisibility } from "@forge-ts/core";

// Enum: Public > Beta > Internal > Private
resolveVisibility({ internal: [] });  // Visibility.Internal
meetsVisibility(Visibility.Public, Visibility.Public);  // true
meetsVisibility(Visibility.Internal, Visibility.Public); // false

const publicOnly = filterByVisibility(symbols, Visibility.Public);
```

## Key Types

| Type | Description |
|------|-------------|
| `ForgeConfig` | Full configuration (loaded from config file or defaults) |
| `ForgeSymbol` | Extracted symbol with TSDoc, visibility, parameters, examples |
| `ForgeResult` | Compilation pass result |
| `ForgeError` | Diagnostic error with file, line, rule code, suggestedFix |
| `ForgeWarning` | Diagnostic warning |
| `RuleSeverity` | `"error"` \| `"warn"` \| `"off"` |
| `EnforceRules` | Per-rule severity map (E001-E007 codes) |
| `OpenAPISchemaObject` | OpenAPI 3.2 schema object |

## Enforcer

```typescript
import { enforce } from "@forge-ts/enforcer";
const result = enforce(symbols, config.enforce);
// result.errors: ForgeError[] with suggestedFix
// result.warnings: ForgeWarning[]
```

## DocTest

```typescript
import { extractTests, runTests } from "@forge-ts/doctest";
const tests = extractTests(symbols);  // Extract @example blocks
const results = await runTests(tests); // Execute via node:test
```

## API Generator

```typescript
import { generateOpenAPI } from "@forge-ts/api";
const spec = generateOpenAPI(symbols, config);
// OpenAPI 3.2.0 spec — paths from @route tags
```

## Site Generator

```typescript
import { generateSite } from "@forge-ts/gen";
const files = await generateSite(symbols, config);
// Returns: { path: string; content: string }[]
// Includes: MDX pages, llms.txt, SKILL.md, SSG nav config
```

## SSG Adapters

```typescript
import { getAdapter, type SSGAdapter } from "@forge-ts/gen";

const adapter: SSGAdapter = getAdapter("mintlify");
// Also: "docusaurus", "nextra", "vitepress"
// Throws if target not registered

// SSGAdapter interface:
// - generateNav(symbols, config): navigation config
// - generateConfigFiles(symbols, config): SSGConfigFile[]
// - getPageExtension(): ".mdx" | ".md"
```

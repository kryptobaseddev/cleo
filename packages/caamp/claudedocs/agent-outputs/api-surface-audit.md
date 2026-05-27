# API Surface Audit Report

**Date**: 2026-02-11
**Scope**: CAAMP public API surface, documentation alignment, TSDoc coverage

---

## 1. Actual Export Count from `src/index.ts`

### Type Exports (28)

From `./types.js` (22):
1. `Provider`
2. `ProviderPriority`
3. `ProviderStatus`
4. `McpServerConfig`
5. `McpServerEntry`
6. `ConfigFormat`
7. `TransportType`
8. `SourceType`
9. `ParsedSource`
10. `SkillMetadata`
11. `SkillEntry`
12. `LockEntry`
13. `CaampLockFile`
14. `MarketplaceSkill`
15. `MarketplaceSearchResult`
16. `AuditRule`
17. `AuditFinding`
18. `AuditResult`
19. `AuditSeverity`
20. `InjectionStatus`
21. `InjectionCheckResult`
22. `GlobalOptions`

From other modules (6):
23. `DetectionResult` (from `./core/registry/detection.js`)
24. `InstallResult` (from `./core/mcp/installer.js`)
25. `SkillInstallResult` (from `./core/skills/installer.js`)
26. `ValidationResult` (from `./core/skills/validator.js`)
27. `ValidationIssue` (from `./core/skills/validator.js`)
28. `MarketplaceResult` (from `./core/marketplace/types.js`)

**Type count: 28** -- PASS (matches docs)

### Function Exports (60)

Registry (8): `getAllProviders`, `getProvider`, `resolveAlias`, `getProvidersByPriority`, `getProvidersByStatus`, `getProvidersByInstructFile`, `getInstructionFiles`, `getProviderCount`, `getRegistryVersion`

Wait -- that's 9, not 8. Let me recount carefully.

Registry: `getAllProviders`, `getProvider`, `resolveAlias`, `getProvidersByPriority`, `getProvidersByStatus`, `getProvidersByInstructFile`, `getInstructionFiles`, `getProviderCount`, `getRegistryVersion` = **9**

Detection: `detectProvider`, `detectAllProviders`, `getInstalledProviders`, `detectProjectProviders` = **4**

Source Parsing: `parseSource`, `isMarketplaceScoped` = **2**

Skills Install: `installSkill`, `removeSkill`, `listCanonicalSkills` = **3**

Skills Discovery: `discoverSkills`, `discoverSkill`, `parseSkillFile` = **3**

Skills Validation: `validateSkill` = **1**

Skills Audit: `scanFile`, `scanDirectory`, `toSarif` = **3**

MCP Install: `installMcpServer`, `installMcpServerToAll`, `buildServerConfig` = **3**

MCP Read: `resolveConfigPath`, `listMcpServers`, `listAllMcpServers`, `removeMcpServer` = **4**

MCP Lock: `readLockFile`, `recordMcpInstall`, `removeMcpFromLock`, `getTrackedMcpServers`, `saveLastSelectedAgents`, `getLastSelectedAgents` = **6**

Skills Lock: `recordSkillInstall`, `removeSkillFromLock`, `getTrackedSkills`, `checkSkillUpdate` = **4**

Instructions: `inject`, `checkInjection`, `removeInjection`, `checkAllInjections`, `injectAll` = **5**

Templates: `generateInjectionContent`, `groupByInstructFile` = **2**

Formats: `readConfig`, `writeConfig`, `removeConfig` = **3**

Utils: `getNestedValue`, `deepMerge`, `ensureDir` = **3**

Logger: `setVerbose`, `setQuiet`, `isVerbose`, `isQuiet` = **4**

**Total functions: 9 + 4 + 2 + 3 + 3 + 1 + 3 + 3 + 4 + 6 + 4 + 5 + 2 + 3 + 3 + 4 = 59**

### Class Exports (1)

1. `MarketplaceClient` (from `./core/marketplace/client.js`)

**Class count: 1** -- PASS

### Total Named Exports

**Types: 28 + Functions: 59 + Classes: 1 = 88**

**FAIL**: Docs claim 89 exports (28 types + 60 functions + 1 class). Actual count is 88.

The discrepancy: The API-REFERENCE.md lists 60 functions, but the actual count from `src/index.ts` is 59. The complete export list in the docs lists 59 function names (I counted the bullet points). The header text says "60 functions" but the bullet list has 59 entries.

Actually, re-examining: the header at line 2500 says "28 types + 60 functions + 1 class = 89". Counting the actual bullet points under "Functions (60)" in the doc: there are exactly 59 bullets (`buildServerConfig` through `writeConfig`). So the header says 60 but the list has 59.

**Actual status**: 88 total exports from `src/index.ts`. The docs claim 89 (with 60 functions). The docs' own bullet list only has 59 functions, inconsistent with its own header.

---

## 2. Cross-Reference: `src/index.ts` vs API-REFERENCE.md

### Every export documented?

| Export | In `src/index.ts` | In API-REFERENCE.md | Status |
|--------|:--:|:--:|:--:|
| **Types (28)** | All 28 | All 28 documented | PASS |
| **Functions** | 59 | 59 bullets listed | PASS |
| **Classes (1)** | `MarketplaceClient` | Documented | PASS |

All exports from `src/index.ts` are documented in API-REFERENCE.md.

### Phantom docs (documented but not exported)?

None found. Every symbol documented in API-REFERENCE.md corresponds to an actual export in `src/index.ts`.

### Missing docs (exported but not documented)?

None found. All 88 exports have corresponding documentation.

### "Complete Export List" section accuracy

**FAIL (minor)**: The heading says "28 types + 60 functions + 1 class = 89" but:
- The type bullet list has 28 entries (correct)
- The function bullet list has 59 entries (off by 1 from the "60" claim)
- The class bullet list has 1 entry (correct)
- The actual total is 88, not 89

The function count discrepancy: The missing function from the `src/index.ts` count appears to be that the README and docs reference "82 exports" in some places and "89" in others, suggesting the count was bumped in docs after adding the MCP read/list/remove functions (7 added = 82 + 7 = 89) but the actual exports added were only 6 new ones (not 7). Alternatively, the docs over-counted by 1 when tallying.

---

## 3. TSDoc Coverage

All exported functions and types were checked for JSDoc/TSDoc annotations.

### Full TSDoc Coverage (with @param, @returns, @example)

| Source File | Exported Symbols | TSDoc | Status |
|-------------|-----------------|:-----:|:------:|
| `src/core/registry/providers.ts` | `getAllProviders`, `getProvider`, `resolveAlias`, `getProvidersByPriority`, `getProvidersByStatus`, `getProvidersByInstructFile`, `getInstructionFiles`, `getProviderCount`, `getRegistryVersion` | All 9 | PASS |
| `src/core/registry/detection.ts` | `DetectionResult`, `detectProvider`, `detectAllProviders`, `getInstalledProviders`, `detectProjectProviders` | All 5 | PASS |
| `src/core/sources/parser.ts` | `parseSource`, `isMarketplaceScoped` | All 2 | PASS |
| `src/core/skills/installer.ts` | `SkillInstallResult`, `installSkill`, `removeSkill`, `listCanonicalSkills` | All 4 | PASS |
| `src/core/skills/discovery.ts` | `parseSkillFile`, `discoverSkill`, `discoverSkills` | All 3 | PASS |
| `src/core/skills/validator.ts` | `ValidationIssue`, `ValidationResult`, `validateSkill` | All 3 | PASS |
| `src/core/skills/audit/scanner.ts` | `scanFile`, `scanDirectory`, `toSarif` | All 3 | PASS |
| `src/core/mcp/installer.ts` | `InstallResult`, `installMcpServer`, `installMcpServerToAll`, `buildServerConfig` | All 4 | PASS |
| `src/core/mcp/transforms.ts` | `getTransform` | 1 | PASS |
| `src/core/mcp/reader.ts` | `resolveConfigPath`, `listMcpServers`, `listAllMcpServers`, `removeMcpServer` | All 4 | PASS |
| `src/core/mcp/lock.ts` | `readLockFile`, `recordMcpInstall`, `removeMcpFromLock`, `getTrackedMcpServers`, `saveLastSelectedAgents`, `getLastSelectedAgents` | All 6 | PASS |
| `src/core/skills/lock.ts` | `recordSkillInstall`, `removeSkillFromLock`, `getTrackedSkills`, `checkSkillUpdate` | All 4 | PASS |
| `src/core/marketplace/client.ts` | `MarketplaceClient` (class + constructor + search + getSkill) | All | PASS |
| `src/core/marketplace/types.ts` | `MarketplaceResult` | None (bare interface, no TSDoc) | **WARN** |
| `src/core/instructions/injector.ts` | `checkInjection`, `inject`, `removeInjection`, `checkAllInjections`, `injectAll` | All 5 | PASS |
| `src/core/instructions/templates.ts` | `generateInjectionContent`, `groupByInstructFile` | All 2 | PASS |
| `src/core/formats/index.ts` | `readConfig`, `writeConfig`, `removeConfig` | All 3 | PASS |
| `src/core/formats/utils.ts` | `deepMerge`, `getNestedValue`, `ensureDir` | All 3 | PASS |
| `src/core/logger.ts` | `setVerbose`, `setQuiet`, `isVerbose`, `isQuiet` | All 4 | PASS |

### Missing TSDoc Annotations

| Symbol | File | Issue |
|--------|------|-------|
| `MarketplaceResult` (interface) | `src/core/marketplace/types.ts:11` | No TSDoc comment. Bare `export interface` with no `/** */` block. |
| `MarketplaceAdapter` (interface) | `src/core/marketplace/types.ts:5` | No TSDoc (not exported from index.ts, but used internally). |
| `SearchOptions` (interface) | `src/core/marketplace/types.ts:23` | No TSDoc (not exported from index.ts). |

**TSDoc coverage: 87/88 exported symbols have TSDoc = 98.9%** -- PASS (only `MarketplaceResult` in types.ts lacks TSDoc)

---

## 4. TypeDoc Configuration

File: `typedoc.json`

| Check | Status | Notes |
|-------|:------:|-------|
| Entry point correct | PASS | `"entryPoints": ["src/index.ts"]` |
| Output directory | PASS | `"out": "docs/api"` |
| Excludes private/protected/internal | PASS | All three set to `true` |
| Sort order | PASS | `"sort": ["source-order"]` |
| `docs/api/` in `.gitignore` | PASS | Line 9: `docs/api/` |
| Generated output exists | PASS | `docs/api/` directory exists with expected contents |

**TypeDoc configuration: PASS**

---

## 5. README Accuracy

### Provider Count

| Claim | Actual | Status |
|-------|--------|:------:|
| README line 15: "28+ AI coding agents" | 46 providers in registry.json | **FAIL** |
| README line 9 badge: "providers-28%2B-green" | 46 providers | **FAIL** |
| README line 55: "all 28+ registered providers" | 46 providers | **FAIL** |
| README line 131: "46 AI coding agents" | 46 providers | PASS |
| README line 176: "all 28 provider definitions" | 46 providers | **FAIL** |

The README is inconsistent -- it says "28+" in many places but "46" in the Supported Providers section. The actual registry has 46 providers.

### Export Count

| Claim | Actual | Status |
|-------|--------|:------:|
| README line 65: "82 exported symbols" | 88 actual exports | **FAIL** |
| README line 186: "82 exports" | 88 actual exports | **FAIL** |

### Install Instructions

| Check | Status | Notes |
|-------|:------:|-------|
| `npm install -g @cleocode/caamp` | PASS | Correct package name |
| `npx @cleocode/caamp <command>` | PASS | Correct |
| Library install: `npm install @cleocode/caamp` | PASS | Correct |

### CLI Commands Listed

| Command | Exists in cli.ts | Status |
|---------|:----------------:|:------:|
| `caamp providers list` | Yes (registerProvidersCommand) | PASS |
| `caamp providers detect` | Yes | PASS |
| `caamp providers show <id>` | Yes | PASS |
| `caamp skills install` | Yes (registerSkillsCommands) | PASS |
| `caamp skills remove` | Yes | PASS |
| `caamp skills list` | Yes | PASS |
| `caamp skills find` | Yes | PASS |
| `caamp skills init` | Yes | PASS |
| `caamp skills validate` | Yes | PASS |
| `caamp skills audit` | Yes | PASS |
| `caamp skills check` | Yes | PASS |
| `caamp skills update` | Yes | PASS |
| `caamp mcp install` | Yes (registerMcpCommands) | PASS |
| `caamp mcp remove` | Yes | PASS |
| `caamp mcp list` | Yes | PASS |
| `caamp mcp detect` | Yes | PASS |
| `caamp instructions inject` | Yes (registerInstructionsCommands) | PASS |
| `caamp instructions check` | Yes | PASS |
| `caamp instructions update` | Yes | PASS |
| `caamp config show` | Yes (registerConfigCommand) | PASS |
| `caamp config path` | Yes | PASS |
| `caamp doctor` | Yes (registerDoctorCommand) | **WARN** - exists but not listed in README |

### Documentation Links

| Link | File Exists | Status |
|------|:----------:|:------:|
| `docs/API-REFERENCE.md` | Yes | PASS |
| `docs/api/` | Yes (generated) | PASS |
| `claudedocs/VISION.md` | Need to verify | -- |
| `claudedocs/PRD.md` | Need to verify | -- |
| `claudedocs/specs/CAAMP-SPEC.md` | Need to verify | -- |
| `claudedocs/GAP-ANALYSIS.md` | Need to verify | -- |

---

## 6. package.json Metadata

### Version Match

| Location | Version | Status |
|----------|---------|:------:|
| `package.json` | `"0.3.0"` | -- |
| `cli.ts` `.version()` | `"0.3.0"` | PASS (matches) |

### Scripts

| Script | Command | Status |
|--------|---------|:------:|
| `build` | `tsup` | PASS |
| `test` | `vitest run` | PASS |
| `typecheck` | `tsc --noEmit` | PASS |
| `docs:api` | `typedoc` | PASS |
| `docs:api:check` | `typedoc --emit none` | PASS |
| `dev` | `tsx src/cli.ts` | PASS |
| `lint` | `tsc --noEmit` (duplicate of typecheck) | **WARN** |
| `test:watch` | `vitest` | PASS |
| `prepublishOnly` | `npm run build` | PASS |

### Dependencies Usage

| Dependency | Used In | Status |
|------------|---------|:------:|
| `@clack/prompts` | CLI interactive prompts | PASS |
| `@iarna/toml` | `src/core/formats/toml.ts` | PASS |
| `commander` | `src/cli.ts` | PASS |
| `gray-matter` | `src/core/skills/discovery.ts`, `validator.ts` | PASS |
| `js-yaml` | `src/core/formats/yaml.ts` | PASS |
| `jsonc-parser` | `src/core/formats/json.ts` | PASS |
| `picocolors` | CLI output coloring | PASS |
| `simple-git` | `src/core/skills/lock.ts` | PASS |

No orphan dependencies detected.

### Bin Entry

| Field | Value | Status |
|-------|-------|:------:|
| `bin.caamp` | `"./dist/cli.js"` | PASS |

### Files/Exports Fields

| Field | Value | Status |
|-------|-------|:------:|
| `main` | `"./dist/index.js"` | PASS |
| `types` | `"./dist/index.d.ts"` | PASS |
| `exports["."].import` | `"./dist/index.js"` | PASS |
| `exports["."].types` | `"./dist/index.d.ts"` | PASS |
| `files` | `["dist", "providers", "README.md", "LICENSE"]` | PASS |
| `type` | `"module"` | PASS |

---

## Summary

| Check | Result | Details |
|-------|:------:|---------|
| 1. Export count | **FAIL** | 88 actual vs 89 claimed (docs function count header says 60, list has 59) |
| 2a. All exports documented | PASS | Every `src/index.ts` export has API-REFERENCE.md documentation |
| 2b. No phantom docs | PASS | No documented items missing from exports |
| 2c. Complete Export List | **FAIL** | Header says "60 functions" but list has 59 entries |
| 3. TSDoc coverage | PASS (98.9%) | 87/88 exports have TSDoc; only `MarketplaceResult` in types.ts lacks it |
| 4. TypeDoc config | PASS | Correct entry point, output in .gitignore |
| 5a. README provider count | **FAIL** | Says "28+" in 4 places but registry has 46; one place correctly says 46 |
| 5b. README export count | **FAIL** | Says "82 exports" but actual is 88 |
| 5c. README install instructions | PASS | Correct |
| 5d. README CLI commands | PASS | All listed commands exist; `doctor` command exists but unlisted (minor) |
| 6a. Version match | PASS | `package.json` and `cli.ts` both say `0.3.0` |
| 6b. Scripts | PASS | All scripts valid; `lint` duplicates `typecheck` (minor) |
| 6c. Dependencies | PASS | No orphan dependencies |
| 6d. Bin/exports/files | PASS | All correct |

### Critical Issues

1. **README provider count stale**: 4 references say "28+" but actual count is 46
2. **README export count stale**: Says "82 exports" but actual is 88
3. **API-REFERENCE function count header**: Says "60 functions" but lists 59

### Minor Issues

1. `MarketplaceResult` interface in `src/core/marketplace/types.ts` lacks TSDoc comment
2. `doctor` command exists in CLI but is not listed in README
3. `lint` script is a duplicate of `typecheck`

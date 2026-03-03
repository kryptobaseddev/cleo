# T5238: CAAMP Skills Precedence Integration - Design Document

## Phase 3A: Design and Planning (Updated for CAAMP 1.6.0)

**Team**: Gamma  
**Date**: 2026-03-03  
**Status**: Design Complete - Ready for Implementation  
**CAAMP Version**: 1.6.0+  

---

## 1. Executive Summary

This design integrates CLEO's skill operations with **CAAMP's native Skills Precedence system** (shipped in v1.6.0). Instead of maintaining a custom precedence registry, CLEO delegates to CAAMP's `ProviderSkillsCapability` API.

### Current Problem
- Skills use "first match wins" discovery without respecting provider policies
- No integration with CAAMP's provider-neutral skill resolution
- Skill installation doesn't use CAAMP's `getEffectiveSkillsPaths()` API

### Proposed Solution
- **Remove custom registry** - Use CAAMP's built-in precedence system
- **Delegate to CAAMP** - Use `getEffectiveSkillsPaths()` for path resolution
- **Filter by precedence** - Use `getProvidersBySkillsPrecedence()` for provider selection
- **Precedence-aware operations** - All `tools.skill` operations respect CAAMP precedence

---

## 2. CAAMP 1.6.0 Integration Model

### 2.1 CAAMP Types (Exact)

```typescript
// From @cleocode/caamp@1.6.0

type SkillsPrecedence = 
  | "vendor-only" 
  | "agents-canonical" 
  | "agents-first" 
  | "agents-supported" 
  | "vendor-global-agents-project";

interface ProviderSkillsCapability {
  precedence: SkillsPrecedence;
  agentsGlobalPath: string | null;
  agentsProjectPath: string | null;
}

// CAAMP Functions:
function getProvidersBySkillsPrecedence(
  precedence: SkillsPrecedence
): Provider[];

function getEffectiveSkillsPaths(
  provider: Provider, 
  scope: PathScope, 
  projectDir?: string
): Array<{path: string; source: string; scope: string}>;

function buildSkillsMap(): Array<{
  providerId: string
  toolName: string
  precedence: SkillsPrecedence
  paths: {global: string | null; project: string | null}
}>;
```

### 2.2 Precedence Modes (CAAMP Canonical)

| Mode | Description | Example Providers |
|------|-------------|-------------------|
| `vendor-only` | Only use vendor paths, ignore .agents | claude-code, windsurf, kimi-coding |
| `agents-canonical` | .agents is canonical, vendor is legacy | codex-cli |
| `agents-first` | .agents takes precedence over vendor | gemini-cli |
| `agents-supported` | Both paths equally, version decides | github-copilot, opencode |
| `vendor-global-agents-project` | Global=vendor, Project=.agents | cursor, antigravity |

### 2.3 CLEO Integration Types

```typescript
// src/core/skills/types.ts - CLEO-specific additions

import type { 
  SkillsPrecedence, 
  ProviderSkillsCapability 
} from '@cleocode/caamp';

/** Re-export CAAMP types for CLEO usage */
export type { SkillsPrecedence, ProviderSkillsCapability };

/** Skill source location (simplified from CAAMP's source strings) */
export type SkillSource = 
  | 'vendor-global'      // ~/.{provider}/skills
  | 'vendor-project'     // ./{provider}/skills
  | 'agents-global'      // ~/.agents/skills
  | 'agents-project'     // ./.agents/skills
  | 'marketplace';       // Cache/downloaded

/** Path resolution result from CAAMP */
export interface SkillPathResolution {
  skillName: string;
  resolvedPath: string | null;
  source: SkillSource | null;
  scope: 'global' | 'project';
  precedence: SkillsPrecedence;
  alternatives: Array<{
    path: string;
    source: SkillSource;
    scope: string;
  }>;
}

/** Provider skill configuration from CAAMP */
export interface ProviderSkillConfig {
  providerId: string;
  precedence: SkillsPrecedence;
  globalPaths: string[];
  projectPaths: string[];
  canReadAgents: boolean;
}
```

---

## 3. CAAMP API Usage Patterns

### 3.1 Path Resolution with `getEffectiveSkillsPaths()`

```typescript
// src/core/skills/skill-paths.ts

import { 
  getEffectiveSkillsPaths,
  getProvidersBySkillsPrecedence,
  type Provider 
} from '@cleocode/caamp';

/**
 * Resolve skill path using CAAMP's precedence system
 */
export async function resolveSkillPath(
  skillName: string,
  provider: Provider,
  scope: 'global' | 'project',
  projectDir?: string
): Promise<SkillPathResolution> {
  // 1. Get all effective paths from CAAMP
  const effectivePaths = getEffectiveSkillsPaths(provider, scope, projectDir);
  
  // 2. Find skill in resolved paths (in precedence order)
  for (const entry of effectivePaths) {
    const skillPath = join(entry.path, skillName);
    if (await fileExists(skillPath)) {
      return {
        skillName,
        resolvedPath: skillPath,
        source: classifySource(entry.source),
        scope: entry.scope as 'global' | 'project',
        precedence: provider.skillsCapability.precedence,
        alternatives: effectivePaths
          .filter(e => e.path !== entry.path)
          .map(e => ({
            path: join(e.path, skillName),
            source: classifySource(e.source),
            scope: e.scope
          }))
      };
    }
  }
  
  // 3. Not found - return with null path
  return {
    skillName,
    resolvedPath: null,
    source: null,
    scope,
    precedence: provider.skillsCapability.precedence,
    alternatives: effectivePaths.map(e => ({
      path: join(e.path, skillName),
      source: classifySource(e.source),
      scope: e.scope
    }))
  };
}

/**
 * Get all skills using CAAMP precedence filtering
 */
export async function discoverSkillsWithPrecedence(
  precedence: SkillsPrecedence,
  scope: 'global' | 'project',
  projectDir?: string
): Promise<SkillPathResolution[]> {
  // 1. Filter providers by precedence mode
  const providers = getProvidersBySkillsPrecedence(precedence);
  
  // 2. Discover skills from each provider
  const allSkills: SkillPathResolution[] = [];
  
  for (const provider of providers) {
    const paths = getEffectiveSkillsPaths(provider, scope, projectDir);
    
    for (const entry of paths) {
      const skills = await scanDirectory(entry.path);
      for (const skillName of skills) {
        const resolved = await resolveSkillPath(
          skillName, 
          provider, 
          scope, 
          projectDir
        );
        if (resolved.resolvedPath) {
          allSkills.push(resolved);
        }
      }
    }
  }
  
  return allSkills;
}

/**
 * Helper: Classify CAAMP source string to SkillSource
 */
function classifySource(source: string): SkillSource {
  if (source.includes('vendor-global')) return 'vendor-global';
  if (source.includes('vendor-project')) return 'vendor-project';
  if (source.includes('agents-global')) return 'agents-global';
  if (source.includes('agents-project')) return 'agents-project';
  if (source.includes('marketplace')) return 'marketplace';
  return 'vendor-global'; // default
}
```

### 3.2 Provider Filtering with `getProvidersBySkillsPrecedence()`

```typescript
// src/core/skills/providers.ts

import { 
  getProvidersBySkillsPrecedence,
  buildSkillsMap 
} from '@cleocode/caamp';

/**
 * Get providers supporting a specific precedence mode
 */
export function getProvidersForMode(
  precedence: SkillsPrecedence
): ProviderSkillConfig[] {
  const providers = getProvidersBySkillsPrecedence(precedence);
  
  return providers.map(p => ({
    providerId: p.id,
    precedence: p.skillsCapability.precedence,
    globalPaths: p.skillsCapability.agentsGlobalPath 
      ? [p.skillsCapability.agentsGlobalPath]
      : [],
    projectPaths: p.skillsCapability.agentsProjectPath
      ? [p.skillsCapability.agentsProjectPath]
      : [],
    canReadAgents: p.skillsCapability.agentsGlobalPath !== null ||
                   p.skillsCapability.agentsProjectPath !== null
  }));
}

/**
 * Build complete skills map across all providers
 */
export function getAllSkillsWithPrecedence(): Array<{
  providerId: string;
  toolName: string;
  precedence: SkillsPrecedence;
  paths: { global: string | null; project: string | null };
}> {
  return buildSkillsMap();
}

/**
 * Check if provider can use .agents paths
 */
export function canUseAgentsPaths(
  provider: Provider
): boolean {
  const cap = provider.skillsCapability;
  return cap.agentsGlobalPath !== null || cap.agentsProjectPath !== null;
}
```

---

## 4. Updated Tools Operations

### 4.1 Query Operations

#### `tools.skill.precedence.show`

**Purpose**: Display current precedence configuration from CAAMP

**Implementation**:
```typescript
// src/dispatch/domains/tools.ts

import { buildSkillsMap } from '@cleocode/caamp';

export async function toolsSkillPrecedenceShow(params: {
  providerId?: string;
  format?: 'table' | 'json' | 'detailed';
}) {
  const skillsMap = buildSkillsMap();
  
  if (params.providerId) {
    const providerConfig = skillsMap.find(
      s => s.providerId === params.providerId
    );
    return {
      provider: providerConfig,
      precedence: providerConfig?.precedence,
      paths: providerConfig?.paths
    };
  }
  
  return {
    providers: skillsMap,
    summary: {
      total: skillsMap.length,
      byPrecedence: groupByPrecedence(skillsMap)
    }
  };
}
```

**CLI Equivalent**: `cleo skills precedence show [--provider <id>]`

---

#### `tools.skill.precedence.resolve`

**Purpose**: Preview skill resolution for a provider using CAAMP paths

**Implementation**:
```typescript
export async function toolsSkillPrecedenceResolve(params: {
  skillName: string;
  providerId: string;
  scope: 'global' | 'project';
  projectDir?: string;
}) {
  const provider = await getProviderById(params.providerId);
  const resolution = await resolveSkillPath(
    params.skillName,
    provider,
    params.scope,
    params.projectDir
  );
  
  return {
    skillName: params.skillName,
    providerId: params.providerId,
    precedence: resolution.precedence,
    resolved: resolution.resolvedPath,
    source: resolution.source,
    alternatives: resolution.alternatives,
    caampPaths: getEffectiveSkillsPaths(
      provider, 
      params.scope, 
      params.projectDir
    )
  };
}
```

**CLI Equivalent**: `cleo skills precedence resolve <skill> --provider <id>`

---

### 4.2 Discovery Operations

#### `tools.skill.discover`

**Purpose**: Discover skills using CAAMP precedence filtering

**Implementation**:
```typescript
export async function toolsSkillDiscover(params: {
  precedence?: SkillsPrecedence;
  scope?: 'global' | 'project';
  projectDir?: string;
}) {
  const precedence = params.precedence || 'agents-supported';
  const scope = params.scope || 'project';
  
  // Use CAAMP filtering
  const skills = await discoverSkillsWithPrecedence(
    precedence,
    scope,
    params.projectDir
  );
  
  return {
    precedence,
    scope,
    count: skills.length,
    skills: skills.map(s => ({
      name: s.skillName,
      path: s.resolvedPath,
      source: s.source,
      provider: s.precedence // Actually need to track provider
    }))
  };
}
```

---

## 5. Precedence-Aware Installation

### 5.1 Installation Target Selection

```typescript
// src/core/skills/install.ts

import { 
  getEffectiveSkillsPaths,
  type Provider 
} from '@cleocode/caamp';

/**
 * Determine install location based on CAAMP precedence
 */
export function determineInstallLocation(
  provider: Provider,
  scope: 'global' | 'project',
  projectDir?: string
): string {
  const paths = getEffectiveSkillsPaths(provider, scope, projectDir);
  
  // Return the first (highest precedence) path
  if (paths.length === 0) {
    throw new Error(`No valid skill paths for provider ${provider.id}`);
  }
  
  return paths[0].path;
}

/**
 * Install skill respecting CAAMP precedence
 */
export async function installSkill(
  skillName: string,
  source: string,
  provider: Provider,
  scope: 'global' | 'project',
  options?: { projectDir?: string; force?: boolean }
): Promise<{
  success: boolean;
  installedTo: string;
  precedence: SkillsPrecedence;
  warnings: string[];
}> {
  // 1. Determine target location using CAAMP
  const targetDir = determineInstallLocation(
    provider, 
    scope, 
    options?.projectDir
  );
  const targetPath = join(targetDir, skillName);
  
  // 2. Check for existing installations
  const warnings: string[] = [];
  const allPaths = getEffectiveSkillsPaths(
    provider, 
    scope, 
    options?.projectDir
  );
  
  for (const entry of allPaths.slice(1)) {
    const alternativePath = join(entry.path, skillName);
    if (await fileExists(alternativePath)) {
      warnings.push(
        `Skill also exists in ${entry.source} (${entry.path})`
      );
    }
  }
  
  // 3. Install to target
  await copySkill(source, targetPath);
  
  return {
    success: true,
    installedTo: targetPath,
    precedence: provider.skillsCapability.precedence,
    warnings
  };
}
```

### 5.2 Installation Flow

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Get provider from CAAMP                                   │
├─────────────────────────────────────────────────────────────┤
│ 2. Call getEffectiveSkillsPaths(provider, scope)            │
├─────────────────────────────────────────────────────────────┤
│ 3. Use first path as install target                         │
├─────────────────────────────────────────────────────────────┤
│ 4. Check other paths for conflicts                          │
├─────────────────────────────────────────────────────────────┤
│ 5. Install to target path                                   │
├─────────────────────────────────────────────────────────────┤
│ 6. Return with precedence info and warnings                 │
└─────────────────────────────────────────────────────────────┘
```

---

## 6. Files to Create/Modify

### 6.1 New Files

| File | Purpose |
|------|---------|
| `src/core/skills/caamp-integration.ts` | CAAMP API wrappers and integration |
| `src/core/skills/__tests__/caamp-integration.test.ts` | Unit tests for CAAMP integration |

### 6.2 Modified Files

| File | Changes |
|------|---------|
| `src/core/skills/types.ts` | Import and re-export CAAMP types |
| `src/core/skills/discovery.ts` | Use `getEffectiveSkillsPaths()` |
| `src/core/skills/skill-paths.ts` | Use CAAMP for path resolution |
| `src/core/skills/install.ts` | Use CAAMP for install target selection |
| `src/dispatch/domains/tools.ts` | Update precedence operations |
| `src/cli/commands/skills.ts` | Update CLI for CAAMP integration |

### 6.3 Dependencies

```json
{
  "dependencies": {
    "@cleocode/caamp": "^1.6.0"
  }
}
```

---

## 7. Test Plan

### 7.1 Unit Tests

```typescript
// src/core/skills/__tests__/caamp-integration.test.ts

describe('CAAMP Skills Integration (T5238)', () => {
  describe('getEffectiveSkillsPaths()', () => {
    it('should return paths in precedence order for vendor-only');
    it('should include .agents paths for agents-canonical');
    it('should order agents-first correctly');
    it('should handle vendor-global-agents-project scope');
  });
  
  describe('getProvidersBySkillsPrecedence()', () => {
    it('should filter providers by precedence mode');
    it('should return empty array for unknown precedence');
    it('should include all matching providers');
  });
  
  describe('resolveSkillPath()', () => {
    it('should resolve to first existing skill in precedence order');
    it('should return null when skill not found');
    it('should include alternatives when skill found');
  });
  
  describe('determineInstallLocation()', () => {
    it('should return first path from getEffectiveSkillsPaths');
    it('should throw when no paths available');
  });
  
  describe('installSkill()', () => {
    it('should install to CAAMP-resolved path');
    it('should warn about existing skills in other paths');
    it('should respect provider precedence mode');
  });
});
```

### 7.2 Integration Tests

| Test Case | CAAMP Function Used |
|-----------|---------------------|
| Install skill in vendor-only mode | `getEffectiveSkillsPaths()` |
| Install skill in agents-first mode | `getEffectiveSkillsPaths()` |
| Filter providers by precedence | `getProvidersBySkillsPrecedence()` |
| Build complete skills map | `buildSkillsMap()` |
| Cross-provider skill discovery | `getProvidersBySkillsPrecedence()` + `getEffectiveSkillsPaths()` |

### 7.3 E2E Tests

```bash
# Test with CAAMP integration
cleo skills precedence show --provider claude-code
# Should show: precedence="vendor-only", paths from CAAMP

cleo skills precedence resolve ct-test-skill --provider gemini-cli
# Should show: resolved path based on agents-first precedence

cleo skills install ct-test-skill --provider cursor --scope global
# Should install to ~/.cursor/skills (vendor-global-agents-project)
```

---

## 8. Migration and Backwards Compatibility

### 8.1 Migration Strategy

1. **Add CAAMP dependency**: Add `@cleocode/caamp@^1.6.0` to package.json
2. **Replace custom logic**: Remove custom precedence registry code
3. **Delegate to CAAMP**: Update all path resolution to use CAAMP APIs
4. **Keep CLI compatibility**: CLI commands remain unchanged internally

### 8.2 Backwards Compatibility

- All existing skill installations continue to work
- CLI commands remain unchanged (internal implementation changes)
- CAAMP 1.6.0 is backward compatible with existing provider configs
- Fallback to CAAMP defaults if no explicit configuration

---

## 9. Success Criteria

- [x] Design uses CAAMP 1.6.0 exact type names
- [x] Shows `getEffectiveSkillsPaths()` usage for resolution
- [x] Shows `getProvidersBySkillsPrecedence()` usage for filtering
- [x] No custom precedence registry - delegates to CAAMP
- [x] Focuses on CLEO integration with CAAMP system
- [ ] Implementation uses `@cleocode/caamp@^1.6.0`
- [ ] All `tools.skill` operations use CAAMP precedence
- [ ] 100% unit test coverage for CAAMP integration
- [ ] Integration tests pass with real CAAMP APIs

---

## Appendix A: CAAMP Skills Precedence Reference

From `@cleocode/caamp` provider configurations:

| Provider | Precedence | agentsGlobalPath | agentsProjectPath |
|----------|------------|------------------|-------------------|
| claude-code | vendor-only | null | null |
| codex-cli | agents-canonical | ~/.agents/skills | ./.agents/skills |
| gemini-cli | agents-first | ~/.agents/skills | ./.agents/skills |
| cursor | vendor-global-agents-project | null | ./.agents/skills |
| github-copilot | agents-supported | ~/.agents/skills | ./.agents/skills |
| windsurf | vendor-only | null | null |
| opencode | agents-supported | ~/.agents/skills | ./.agents/skills |
| kimi-coding | vendor-only | null | null |
| antigravity | vendor-global-agents-project | null | ./.agents/skills |

---

## Appendix B: CAAMP API Reference

### `getProvidersBySkillsPrecedence(precedence)`

Returns all providers configured with the specified precedence mode.

**Parameters**:
- `precedence: SkillsPrecedence` - The precedence mode to filter by

**Returns**: `Provider[]` - Array of matching providers

### `getEffectiveSkillsPaths(provider, scope, projectDir?)`

Returns skill paths in order of precedence for a provider.

**Parameters**:
- `provider: Provider` - The provider to get paths for
- `scope: PathScope` - 'global' or 'project'
- `projectDir?: string` - Project directory (required for project scope)

**Returns**: `Array<{path: string; source: string; scope: string}>`

### `buildSkillsMap()`

Returns complete skills configuration across all providers.

**Returns**: `Array<{providerId, toolName, precedence, paths}>`

---

**End of Design Document**

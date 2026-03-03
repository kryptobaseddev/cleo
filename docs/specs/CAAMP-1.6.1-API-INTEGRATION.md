# CAAMP 1.6.1 API Integration in CLEO

## Overview
CLEO fully integrates all 11 CAAMP provider capability API functions for dynamic provider querying.

## API Function Usage Matrix

| Function | Status | CLEO Location | Purpose |
|----------|--------|---------------|---------|
| getProviderCapabilities | ✅ | src/core/skills/precedence-integration.ts | Get full capabilities object |
| getProvider | ✅ | src/core/caamp/adapter.ts | Get provider by ID |
| getProvidersByHookEvent | ✅ | src/core/hooks/provider-hooks.ts | Filter providers by hook support |
| getProvidersBySkillsPrecedence | ✅ | src/core/skills/precedence-integration.ts | Filter by precedence mode |
| getSpawnCapableProviders | ✅ | src/core/spawn/adapter-registry.ts | Get all spawn-capable providers |
| getProvidersBySpawnCapability | ✅ | src/core/spawn/adapter-registry.ts | Filter by specific spawn capability |
| providerSupports | ✅ | src/core/caamp/capability-check.ts | Check capability on provider object |
| providerSupportsById | ✅ | src/core/caamp/capability-check.ts | Check capability by provider ID |
| getCommonHookEvents | ✅ | src/core/hooks/provider-hooks.ts | Find common hooks across providers |
| getEffectiveSkillsPaths | ✅ | src/core/skills/precedence-integration.ts | Get effective skill paths |
| buildSkillsMap | ✅ | src/core/skills/precedence-integration.ts | Build complete skills map |

## Usage Examples

### 1. Spawn Capability Check
```typescript
import { providerSupportsById } from '@cleocode/caamp';

if (providerSupportsById('claude-code', 'spawn.supportsSubagents')) {
  // Use spawn adapter
}
```
Used in: src/core/spawn/adapters/claude-code-adapter.ts

### 2. Hook Provider Query
```typescript
import { getProvidersByHookEvent } from '@cleocode/caamp';

const providers = getProvidersByHookEvent('onToolComplete');
// Returns providers supporting this hook
```
Used in: src/core/hooks/provider-hooks.ts

### 3. Skills Precedence
```typescript
import { getProvidersBySkillsPrecedence } from '@cleocode/caamp';

const agentsFirst = getProvidersBySkillsPrecedence('agents-first');
```
Used in: src/core/skills/precedence-integration.ts

## New Operations Added

| Operation | Domain | Purpose |
|-----------|--------|---------|
| orchestrate.spawn.execute | orchestrate | Execute subagent spawn |
| tools.provider.hooks | tools | Query providers by hook support |
| tools.provider.supports | tools | Check provider capability |
| tools.skill.precedence.show | tools | Show precedence mapping |
| tools.skill.precedence.resolve | tools | Resolve paths for provider |
| tools.skill.spawn.providers | tools | List spawn-capable providers |

## Files Changed

- src/core/spawn/adapter-registry.ts
- src/core/spawn/adapters/claude-code-adapter.ts
- src/core/hooks/provider-hooks.ts
- src/core/hooks/types.ts
- src/core/caamp/capability-check.ts
- src/core/skills/precedence-integration.ts
- src/dispatch/engines/orchestrate-engine.ts
- src/dispatch/engines/hooks-engine.ts
- src/dispatch/domains/tools.ts
- src/dispatch/registry.ts
- src/mcp/__mocks__/@cleocode/caamp.ts

## Verification

All 11 API functions are now used in production code.
Coverage: 11/11 (100%)

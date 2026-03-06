# Build Configuration System

## Overview

CLEO uses a **build-time configuration system** to inject compile-time constants derived from `package.json`. This ensures a single source of truth (SSoT) for package metadata and prevents hardcoded values from diverging.

## Architecture

```
package.json (SSoT)
    ↓
dev/generate-build-config.js (build script)
    ↓
src/config/build-config.ts (auto-generated)
    ↓
Imported by source code at compile time
```

## Files

| File | Purpose | Generated |
|------|---------|-----------|
| `package.json` | Single source of truth for all metadata | No |
| `dev/generate-build-config.js` | Build script that reads package.json and generates TypeScript | No |
| `src/config/build-config.ts` | Auto-generated TypeScript with typed constants | **Yes** |
| `build.mjs` | Runs generate-build-config.js before esbuild | No |

## Build Process

When you run `npm run build`:

1. `build.mjs` executes first
2. `dev/generate-build-config.js` runs and creates `src/config/build-config.ts`
3. esbuild compiles TypeScript, including the generated config
4. Output goes to `dist/`

**Important**: `src/config/build-config.ts` is auto-generated and should NOT be committed to git. It's regenerated on every build.

## Usage in Code

```typescript
import { BUILD_CONFIG } from '../config/build-config.js';

// Access repository info
const repo = BUILD_CONFIG.repository.fullName; // "kryptobaseddev/cleo"
const version = BUILD_CONFIG.version; // "2026.3.14"

// Access template paths
const issueTemplatesDir = BUILD_CONFIG.templates.issueTemplatesDir;
```

## Configuration Values

### Current Build Config

```typescript
{
  name: string;           // Package name from package.json
  version: string;        // Package version from package.json
  description: string;    // Package description from package.json
  repository: {
    owner: string;        // Parsed from repository.url
    name: string;         // Parsed from repository.url
    fullName: string;     // "owner/name"
    url: string;          // Full repository URL
    issuesUrl: string;    // GitHub issues URL
  };
  buildDate: string;      // ISO timestamp of build
  templates: {
    issueTemplatesDir: string; // Path to issue templates
  };
}
```

## Adding New Build-Time Constants

To add a new compile-time constant:

1. **Add to package.json** (if it's metadata):
   ```json
   {
     "customField": "value"
   }
   ```

2. **Update `dev/generate-build-config.js`**:
   ```javascript
   const buildConfig = {
     // ... existing fields
     customField: packageJson.customField,
   };
   ```

3. **Use in source code**:
   ```typescript
   import { BUILD_CONFIG } from '../config/build-config.js';
   const value = BUILD_CONFIG.customField;
   ```

## For Contributors

### Building the Project

```bash
npm run build
```

This automatically generates `src/config/build-config.ts` before compilation.

### Troubleshooting

**Error: Cannot find module '../config/build-config.js'**

This means the build config wasn't generated. Run:
```bash
node dev/generate-build-config.js
npm run build
```

**Issue: Build config values are stale**

The build config is generated once at the start of the build. If you change package.json, rebuild:
```bash
npm run build
```

## Migration from Hardcoded Values

If you find hardcoded values that should use build config:

1. Replace the hardcoded value with `BUILD_CONFIG` import
2. Remove any local constants
3. Update tests if needed

Example:
```typescript
// Before
const CLEO_REPO = 'kryptobaseddev/cleo';

// After
import { BUILD_CONFIG } from '../../config/build-config.js';
const CLEO_REPO = BUILD_CONFIG.repository.fullName;
```

## TypeScript Types

The generated file includes type exports:

```typescript
export type BuildConfig = typeof BUILD_CONFIG;
export type RepositoryConfig = BuildConfig['repository'];
```

Use these for type-safe access to nested configuration.

## Future Enhancements

Potential additions to build config:
- Environment-specific values (dev/prod)
- Feature flags
- Plugin configurations
- Build metadata (git commit hash, CI build number)

## References

- `dev/generate-build-config.js` - Build script
- `build.mjs` - Build orchestration
- `src/config/build-config.ts` - Generated output (not in repo)
- `package.json` - Source of truth

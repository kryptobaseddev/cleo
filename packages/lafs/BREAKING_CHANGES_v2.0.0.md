# Breaking Changes: LAFS v1.2.3 → v2.0.0

This document details all breaking changes when upgrading from LAFS v1.2.3 to v2.0.0.

## Overview

Version 2.0.0 introduces full A2A (Agent-to-Agent) Protocol v1.0+ compliance. This represents a significant architectural alignment with the A2A specification for agent interoperability.

## Critical Changes

### 1. Discovery Endpoint Path Changed

**OLD:** `/.well-known/lafs.json`

**NEW:** `/.well-known/agent-card.json`

**Impact:** HIGH - All clients using the discovery endpoint must update their URLs.

**Migration:**
```typescript
// OLD (v1.2.3)
const response = await fetch('/.well-known/lafs.json');

// NEW (v2.0.0)
const response = await fetch('/.well-known/agent-card.json');
```

**Backward Compatibility:** The legacy endpoint `/.well-known/lafs.json` continues to work but:
- Returns deprecation headers
- Logs warnings on the server
- Will be removed in v3.0.0
- Sunset date: December 31, 2025

### 2. Discovery Document Format (Agent Card)

**OLD Format (DiscoveryDocument):**
```json
{
  "$schema": "https://lafs.dev/schemas/v1/discovery.schema.json",
  "lafs_version": "1.2.3",
  "service": {
    "name": "my-service",
    "version": "1.0.0",
    "description": "..."
  },
  "capabilities": [
    {
      "name": "processor",
      "version": "1.0.0",
      "operations": ["process"],
      "description": "..."
    }
  ],
  "endpoints": {
    "envelope": "/api/v1/envelope",
    "context": "/api/v1/context",
    "discovery": "/.well-known/lafs.json"
  }
}
```

**NEW Format (AgentCard - A2A v1.0):**
```json
{
  "$schema": "https://lafs.dev/schemas/v1/agent-card.schema.json",
  "name": "my-agent",
  "description": "...",
  "version": "1.0.0",
  "url": "https://api.example.com",
  "provider": {
    "organization": "My Org",
    "url": "https://example.com"
  },
  "capabilities": {
    "streaming": true,
    "pushNotifications": false,
    "extendedAgentCard": false,
    "extensions": []
  },
  "defaultInputModes": ["application/json"],
  "defaultOutputModes": ["application/json"],
  "skills": [
    {
      "id": "processor",
      "name": "Processor",
      "description": "...",
      "tags": ["process", "validate"],
      "examples": ["Process this data"]
    }
  ]
}
```

**Impact:** HIGH - Complete restructuring of discovery configuration.

**Migration:**
```typescript
// OLD middleware configuration
app.use(discoveryMiddleware({
  service: {
    name: "my-service",
    version: "1.0.0",
    description: "..."
  },
  capabilities: [...],
  endpoints: {
    envelope: "/api/v1/envelope",
    context: "/api/v1/context"
  }
}));

// NEW middleware configuration
app.use(discoveryMiddleware({
  agent: {
    name: "my-agent",
    description: "...",
    version: "1.0.0",
    url: "https://api.example.com",
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extensions: []
    },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [...]
  }
}));
```

**Backward Compatibility:** The middleware automatically migrates legacy configs with deprecation warnings.

### 3. Type Renames

| Old Type (v1.2.3) | New Type (v2.0.0) | Status |
|-------------------|-------------------|--------|
| `DiscoveryDocument` | `AgentCard` | ✅ Available (deprecated) |
| `ServiceConfig` | `AgentCard` (partial) | ✅ Available (deprecated) |
| `Capability` | `AgentSkill` | ✅ Available (deprecated) |
| `EndpointConfig` | N/A (removed) | ❌ Removed |
| `DiscoveryConfig` | `DiscoveryConfig` (updated) | ✅ Updated |

**Impact:** MEDIUM - TypeScript users need to update type references.

**Migration:**
```typescript
// OLD
import type { DiscoveryDocument, Capability } from '@cleocode/lafs';

// NEW
import type { AgentCard, AgentSkill } from '@cleocode/lafs';
```

### 4. Package Exports

**NEW Export Path:**
```typescript
// A2A integration now available at:
import { discoveryMiddleware } from '@cleocode/lafs/a2a';

// Or:
import { discoveryMiddleware } from '@cleocode/lafs/discovery';
```

## API Changes

### Discovery Middleware Options

**NEW Options:**
- `path`: Primary endpoint path (default: `/.well-known/agent-card.json`)
- `legacyPath`: Legacy endpoint path (default: `/.well-known/lafs.json`)
- `enableLegacyPath`: Enable legacy support (default: `true`)

## Migration Guide

### Step 1: Update Discovery Endpoint URL

Update all clients to use the new endpoint:
```bash
# Find all occurrences
grep -r "lafs.json" your-project/

# Replace with new endpoint
sed -i 's/lafs\.json/agent-card.json/g' your-files
```

### Step 2: Update Server Configuration

```typescript
// Before
import { discoveryMiddleware } from '@cleocode/lafs';

app.use(discoveryMiddleware({
  service: { name: "...", version: "..." },
  capabilities: [...],
  endpoints: { envelope: "...", context: "..." }
}));

// After
import { discoveryMiddleware } from '@cleocode/lafs/discovery';

app.use(discoveryMiddleware({
  agent: {
    name: "...",
    description: "...",
    version: "...",
    url: "https://...",
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: []
    },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [...]
  }
}));
```

### Step 3: Update TypeScript Types

```typescript
// Before
const doc: DiscoveryDocument = await fetchDiscovery();

// After
const card: AgentCard = await fetchAgentCard();
```

### Step 4: Test Integration

1. Verify new endpoint returns correct format
2. Check legacy endpoint still works (with warnings)
3. Validate all A2A clients can discover your agent

## Deprecation Timeline

- **v2.0.0 (Current):** Legacy support with deprecation warnings
- **v2.x.x:** Continued legacy support
- **v3.0.0:** Legacy support removed (Sunset: December 31, 2025)

## A2A Protocol Compliance

v2.0.0 introduces full A2A Protocol v1.0+ support:

- ✅ Agent Card format (A2A spec compliant)
- ✅ Discovery at `/.well-known/agent-card.json`
- ✅ Task lifecycle management
- ✅ Extensions support
- ✅ Streaming operations
- ✅ Protocol bindings (JSON-RPC, HTTP+JSON, gRPC)

See `specs/external/` for A2A specification documents.

## Questions?

- Review A2A specification: `specs/external/specification.md`
- Check migration examples: `examples/a2a-migration/`
- Open an issue: https://github.com/kryptobaseddev/lafs/issues

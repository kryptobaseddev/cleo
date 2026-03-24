# LAFS Agent Discovery Protocol v1

**Status:** Draft  
**Version:** 1.0.0  
**Last Updated:** 2026-02-16

---

## 1. Overview

The LAFS Agent Discovery Protocol enables LLM agents to auto-discover LAFS support without human configuration. It provides a machine-readable manifest at a well-known location that advertises capabilities, versions, and endpoints.

### 1.1 Design Principles

1. **Zero-config discovery** — Agents detect LAFS support via standardized endpoint
2. **Single-request resolution** — All discovery information in one response
3. **Agent-centric design** — Optimized for programmatic consumption, not human reading
4. **Cache-friendly** — Aggressive caching with efficient invalidation
5. **Extensible** — Vendor extensions via namespaced fields

---

## 2. Discovery Endpoint

### 2.1 Well-Known Location

The discovery document MUST be served at:

```
/.well-known/lafs.json
```

This follows RFC 5785 for well-known URIs. The path is fixed and MUST NOT vary by deployment.

### 2.2 HTTP Method

- **GET** — Retrieve discovery document
- **HEAD** — Check existence and cache status only

### 2.3 Content Negotiation

The server MUST support:

| Accept Header | Response Format |
|---------------|-----------------|
| `application/json` | JSON (default) |
| `*/*` | JSON |

The server MAY support:

| Accept Header | Response Format |
|---------------|-----------------|
| `application/yaml` | YAML representation |

---

## 3. Discovery Response Schema

### 3.1 JSON Schema

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://lafs.dev/schemas/v1/discovery.schema.json",
  "title": "LAFS Discovery Document v1",
  "type": "object",
  "required": [
    "$schema",
    "lafs_version",
    "service",
    "capabilities",
    "endpoints"
  ],
  "properties": {
    "$schema": {
      "type": "string",
      "const": "https://lafs.dev/schemas/v1/discovery.schema.json"
    },
    "lafs_version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+$",
      "description": "LAFS protocol version supported (SemVer)"
    },
    "service": {
      "type": "object",
      "required": ["name", "version"],
      "properties": {
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128,
          "description": "Service identifier (e.g., 'my-api', 'cleo-tasks')"
        },
        "version": {
          "type": "string",
          "pattern": "^\\d+\\.\\d+\\.\\d+$",
          "description": "Service implementation version (SemVer)"
        },
        "description": {
          "type": "string",
          "maxLength": 512,
          "description": "Brief service description"
        },
        "provider": {
          "type": "object",
          "properties": {
            "name": { "type": "string" },
            "url": { "type": "string", "format": "uri" }
          }
        }
      }
    },
    "capabilities": {
      "type": "object",
      "required": ["protocol", "features"],
      "properties": {
        "protocol": {
          "type": "object",
          "required": ["versions_supported", "version_negotiation"],
          "properties": {
            "versions_supported": {
              "type": "array",
              "items": {
                "type": "string",
                "pattern": "^\\d+\\.\\d+\\.\\d+$"
              },
              "minItems": 1,
              "description": "All LAFS versions this service supports"
            },
            "version_negotiation": {
              "type": "string",
              "enum": ["header", "query", "content-type", "none"],
              "description": "How to request specific LAFS version"
            }
          }
        },
        "features": {
          "type": "object",
          "required": ["mvi_levels", "pagination_modes", "strict_mode"],
          "properties": {
            "mvi_levels": {
              "type": "array",
              "items": {
                "type": "string",
                "enum": ["minimal", "standard", "full", "custom"]
              },
              "minItems": 1,
              "description": "Supported MVI disclosure levels"
            },
            "pagination_modes": {
              "type": "array",
              "items": {
                "type": "string",
                "enum": ["cursor", "offset", "none"]
              },
              "minItems": 1,
              "description": "Supported pagination modes"
            },
            "strict_mode": {
              "type": "boolean",
              "description": "Whether strict mode is supported"
            },
            "context_ledger": {
              "type": "boolean",
              "description": "Whether context ledger is supported"
            },
            "field_selection": {
              "type": "boolean",
              "description": "Whether _fields parameter is supported"
            },
            "expansion": {
              "type": "boolean",
              "description": "Whether _expand parameter is supported"
            },
            "budgets": {
              "type": "object",
              "description": "Budget/compute limit support",
              "properties": {
                "supported": { "type": "boolean" },
                "types": {
                  "type": "array",
                  "items": {
                    "type": "string",
                    "enum": ["token", "time", "compute"]
                  }
                }
              }
            }
          }
        }
      }
    },
    "endpoints": {
      "type": "object",
      "required": ["base_url", "envelope_endpoint"],
      "properties": {
        "base_url": {
          "type": "string",
          "format": "uri",
          "description": "Base URL for all LAFS endpoints"
        },
        "envelope_endpoint": {
          "type": "string",
          "description": "Path to primary envelope endpoint (relative to base_url)"
        },
        "operations": {
          "type": "object",
          "description": "Map of operation names to endpoint paths",
          "additionalProperties": {
            "type": "string"
          }
        },
        "documentation_url": {
          "type": "string",
          "format": "uri",
          "description": "Human-readable documentation URL"
        }
      }
    },
    "caching": {
      "type": "object",
      "properties": {
        "ttl_seconds": {
          "type": "integer",
          "minimum": 0,
          "description": "Recommended cache TTL in seconds"
        },
        "etag": {
          "type": "string",
          "description": "Entity tag for cache validation"
        },
        "immutable": {
          "type": "boolean",
          "description": "If true, document won't change without version bump"
        }
      }
    },
    "security": {
      "type": "object",
      "properties": {
        "discovery_public": {
          "type": "boolean",
          "description": "Whether discovery endpoint is publicly accessible"
        },
        "auth_required": {
          "type": "boolean",
          "description": "Whether API calls require authentication"
        },
        "schemes": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["type"],
            "properties": {
              "type": {
                "type": "string",
                "enum": ["apiKey", "http", "oauth2", "openIdConnect", "none"]
              },
              "description": { "type": "string" }
            }
          }
        }
      }
    },
    "_extensions": {
      "type": "object",
      "description": "Vendor extensions. Keys SHOULD use x- prefix.",
      "additionalProperties": true
    }
  }
}
```

### 3.2 Minimal Example

```json
{
  "$schema": "https://lafs.dev/schemas/v1/discovery.schema.json",
  "lafs_version": "1.0.0",
  "service": {
    "name": "task-service",
    "version": "2.3.1"
  },
  "capabilities": {
    "protocol": {
      "versions_supported": ["1.0.0"],
      "version_negotiation": "header"
    },
    "features": {
      "mvi_levels": ["minimal", "standard", "full"],
      "pagination_modes": ["cursor", "offset"],
      "strict_mode": true,
      "context_ledger": true,
      "field_selection": true,
      "expansion": true,
      "budgets": {
        "supported": true,
        "types": ["token"]
      }
    }
  },
  "endpoints": {
    "base_url": "https://api.example.com",
    "envelope_endpoint": "/v1/lafs"
  },
  "caching": {
    "ttl_seconds": 3600,
    "immutable": false
  }
}
```

### 3.3 Full Example

```json
{
  "$schema": "https://lafs.dev/schemas/v1/discovery.schema.json",
  "lafs_version": "1.0.0",
  "service": {
    "name": "cleo-task-platform",
    "version": "3.0.0",
    "description": "Multi-agent task management platform with LAFS support",
    "provider": {
      "name": "CLEO Labs",
      "url": "https://cleo.dev"
    }
  },
  "capabilities": {
    "protocol": {
      "versions_supported": ["1.0.0", "0.5.0"],
      "version_negotiation": "header"
    },
    "features": {
      "mvi_levels": ["minimal", "standard", "full", "custom"],
      "pagination_modes": ["cursor", "offset", "none"],
      "strict_mode": true,
      "context_ledger": true,
      "field_selection": true,
      "expansion": true,
      "budgets": {
        "supported": true,
        "types": ["token", "time"]
      }
    }
  },
  "endpoints": {
    "base_url": "https://tasks.cleo.dev",
    "envelope_endpoint": "/api/v1/envelope",
    "operations": {
      "tasks.list": "/api/v1/tasks",
      "tasks.get": "/api/v1/tasks/{id}",
      "tasks.create": "/api/v1/tasks",
      "tasks.update": "/api/v1/tasks/{id}",
      "tasks.delete": "/api/v1/tasks/{id}",
      "context.get": "/api/v1/context/{id}",
      "context.update": "/api/v1/context/{id}"
    },
    "documentation_url": "https://docs.cleo.dev/lafs"
  },
  "caching": {
    "ttl_seconds": 86400,
    "etag": "W/\"3.0.0-abc123\"",
    "immutable": true
  },
  "security": {
    "discovery_public": true,
    "auth_required": true,
    "schemes": [
      {
        "type": "apiKey",
        "description": "API key in X-API-Key header"
      },
      {
        "type": "oauth2",
        "description": "OAuth 2.0 with client credentials flow"
      }
    ]
  },
  "_extensions": {
    "x-cleo-rate-limit": "1000/hour",
    "x-cleo-support": "https://support.cleo.dev"
  }
}
```

---

## 4. Discovery Flow

### 4.1 Standard Discovery Flow

```
┌─────────────┐                                    ┌─────────────────┐
│   Agent     │                                    │  LAFS Service   │
└──────┬──────┘                                    └────────┬────────┘
       │                                                    │
       │  1. GET /.well-known/lafs.json                     │
       │  ───────────────────────────────────────────────>  │
       │  Accept: application/json                          │
       │                                                    │
       │  2. Discovery Response                             │
       │  <───────────────────────────────────────────────  │
       │  200 OK                                            │
       │  Content-Type: application/json                    │
       │  ETag: "abc123"                                    │
       │  Cache-Control: max-age=3600                       │
       │                                                    │
       │  { lafs_version, capabilities, endpoints }         │
       │                                                    │
       │  3. Negotiate version (if needed)                  │
       │  ───────────────────────────────────────────────>  │
       │  X-LAFS-Version: 1.0.0                             │
       │                                                    │
       │  4. Use LAFS endpoints                             │
       │  ───────────────────────────────────────────────>  │
       │  Standard LAFS envelope request                    │
       │                                                    │
```

### 4.2 Cache Validation Flow

```
┌─────────────┐                                    ┌─────────────────┐
│   Agent     │                                    │  LAFS Service   │
└──────┬──────┘                                    └────────┬────────┘
       │                                                    │
       │  1. GET /.well-known/lafs.json                     │
       │  ───────────────────────────────────────────────>  │
       │  If-None-Match: "abc123"                           │
       │                                                    │
       │  2. Cache Hit (No Change)                          │
       │  <───────────────────────────────────────────────  │
       │  304 Not Modified                                  │
       │                                                    │
       │  OR Cache Miss (Changed)                           │
       │  <───────────────────────────────────────────────  │
       │  200 OK + New discovery document                   │
       │  ETag: "def456"                                    │
```

---

## 5. Version Negotiation

### 5.1 Dual Version Model

LAFS uses a dual version model:

| Field | Purpose | Example |
|-------|---------|---------|
| `lafs_version` | LAFS protocol version | `1.0.0` |
| `service.version` | Service implementation version | `2.3.1` |

This separation allows:
- Service updates without protocol changes
- Protocol upgrades independent of service releases
- Clear compatibility matrix

### 5.2 Negotiation Methods

The discovery document advertises negotiation method in `capabilities.protocol.version_negotiation`:

#### 5.2.1 Header Negotiation (Recommended)

```http
GET /api/v1/tasks
X-LAFS-Version: 1.0.0
```

Server responds with:
```http
200 OK
X-LAFS-Version: 1.0.0
Content-Type: application/json

{ /* LAFS envelope */ }
```

#### 5.2.2 Query Parameter Negotiation

```http
GET /api/v1/tasks?lafs_version=1.0.0
```

#### 5.2.3 Content-Type Negotiation

```http
GET /api/v1/tasks
Accept: application/vnd.lafs.v1+json
```

#### 5.2.4 No Negotiation

Service supports only one version. Version mismatch returns:

```json
{
  "success": false,
  "error": {
    "code": "E_PROTOCOL_UNSUPPORTED_VERSION",
    "message": "LAFS version 2.0.0 not supported",
    "category": "CONTRACT",
    "retryable": false,
    "retryAfterMs": null,
    "details": {
      "requested": "2.0.0",
      "supported": ["1.0.0"]
    }
  }
}
```

### 5.3 Version Selection Algorithm

Agents SHOULD use this algorithm to select version:

```python
def select_version(supported_versions: list[str], preferred: str) -> str:
    """
    Select highest mutually compatible version.
    
    Args:
        supported_versions: Versions service supports (from discovery)
        preferred: Agent's preferred version
    
    Returns:
        Selected version string
    
    Raises:
        VersionMismatchError: If no compatible version found
    """
    # Sort by semver descending
    sorted_service = sorted(supported_versions, key=semver, reverse=True)
    
    # Find highest version <= preferred (backward compatible)
    for version in sorted_service:
        if semver_compatible(version, preferred):
            return version
    
    # If preferred is lower than all service versions,
    # use lowest service version (best backward compat)
    if semver(preferred) < semver(sorted_service[-1]):
        return sorted_service[-1]
    
    raise VersionMismatchError(
        f"No compatible LAFS version. Service: {supported_versions}, "
        f"Agent prefers: {preferred}"
    )
```

---

## 6. Capability Advertisement

### 6.1 Capability Structure

Capabilities are organized hierarchically:

```
capabilities/
├── protocol/
│   ├── versions_supported    # Array of SemVer strings
│   └── version_negotiation   # Method: header/query/content-type/none
└── features/
    ├── mvi_levels            # Disclosure levels supported
    ├── pagination_modes      # cursor/offset/none
    ├── strict_mode           # Boolean
    ├── context_ledger        # Boolean
    ├── field_selection       # Boolean (_fields param)
    ├── expansion             # Boolean (_expand param)
    └── budgets/              # Compute limit support
        ├── supported         # Boolean
        └── types             # [token, time, compute]
```

### 6.2 Capability Detection Pattern

Agents MUST check capabilities before using features:

```typescript
interface CapabilityChecker {
  supportsMviLevel(level: MviLevel): boolean;
  supportsPagination(mode: PaginationMode): boolean;
  supportsStrictMode(): boolean;
  supportsContextLedger(): boolean;
  supportsFieldSelection(): boolean;
  supportsExpansion(): boolean;
  supportsBudget(type?: BudgetType): boolean;
}

class LafsDiscovery implements CapabilityChecker {
  constructor(private discovery: DiscoveryDocument) {}

  supportsMviLevel(level: string): boolean {
    return this.discovery.capabilities.features.mvi_levels.includes(level);
  }

  supportsPagination(mode: string): boolean {
    return this.discovery.capabilities.features.pagination_modes.includes(mode);
  }

  supportsStrictMode(): boolean {
    return this.discovery.capabilities.features.strict_mode;
  }

  // ... etc
}
```

### 6.3 Feature Requirements

| Feature | Required | Default |
|---------|----------|---------|
| `mvi_levels` | YES | `["standard"]` |
| `pagination_modes` | YES | `["none"]` |
| `strict_mode` | NO | `false` |
| `context_ledger` | NO | `false` |
| `field_selection` | NO | `false` |
| `expansion` | NO | `false` |
| `budgets.supported` | NO | `false` |

---

## 7. Caching Strategy

### 7.1 HTTP Cache Headers

Servers SHOULD provide these headers:

| Header | Purpose | Example |
|--------|---------|---------|
| `ETag` | Entity tag for validation | `W/"1.0.0-abc123"` |
| `Cache-Control` | Cache directives | `max-age=3600, public` |
| `Last-Modified` | Modification time | `Mon, 16 Feb 2026 12:00:00 GMT` |
| `Vary` | Cache key variation | `Accept` |

### 7.2 Cache TTL Recommendations

| Deployment Type | TTL | Rationale |
|-----------------|-----|-----------|
| Development | 60s | Rapid iteration |
| Staging | 300s | Moderate stability |
| Production (dynamic) | 3600s | Hourly refresh |
| Production (static) | 86400s | Daily refresh |
| Immutable | 31536000s | Never changes without URL change |

### 7.3 Cache Invalidation

#### 7.3.1 ETag Validation

```http
GET /.well-known/lafs.json
If-None-Match: "abc123"

304 Not Modified  # Cache is fresh
```

#### 7.3.2 Force Refresh

Agents MAY force refresh by omitting `If-None-Match`:

```http
GET /.well-known/lafs.json
# No If-None-Match header

200 OK  # Always returns fresh document
```

### 7.4 Agent-Side Caching

Agents SHOULD implement:

```typescript
interface DiscoveryCache {
  get(url: string): DiscoveryDocument | null;
  set(url: string, doc: DiscoveryDocument, ttl: number): void;
  invalidate(url: string): void;
}

class LafsAgent {
  private cache: DiscoveryCache;
  
  async discover(baseUrl: string): Promise<DiscoveryDocument> {
    const discoveryUrl = `${baseUrl}/.well-known/lafs.json`;
    
    // Check cache first
    const cached = this.cache.get(discoveryUrl);
    if (cached) {
      // Validate with server
      const response = await fetch(discoveryUrl, {
        headers: { 'If-None-Match': cached.caching.etag }
      });
      
      if (response.status === 304) {
        return cached;  // Cache hit
      }
      
      // Cache miss, store new
      const doc = await response.json();
      this.cache.set(
        discoveryUrl, 
        doc, 
        doc.caching.ttl_seconds * 1000
      );
      return doc;
    }
    
    // No cache, fetch fresh
    const response = await fetch(discoveryUrl);
    const doc = await response.json();
    this.cache.set(discoveryUrl, doc, doc.caching.ttl_seconds * 1000);
    return doc;
  }
}
```

### 7.5 Immutable Discovery

When `caching.immutable: true`, agents MAY cache indefinitely:

- Document won't change without `lafs_version` bump
- Service updates that don't change capabilities are invisible
- Use strong ETag validation on version changes only

---

## 8. Security Considerations

### 8.1 Discovery Accessibility

| Setting | Use Case | Implications |
|---------|----------|--------------|
| `discovery_public: true` | Public APIs, open services | Anyone can discover capabilities |
| `discovery_public: false` | Private APIs, enterprise | Discovery requires auth |

### 8.2 Authentication for Discovery

When `discovery_public: false`:

```http
GET /.well-known/lafs.json
Authorization: Bearer {token}

200 OK  # Authenticated discovery
```

Without valid auth:

```http
401 Unauthorized
WWW-Authenticate: Bearer
```

### 8.3 Information Disclosure

Discovery documents reveal:
- Service version (attack surface fingerprinting)
- Supported features (capability enumeration)
- Endpoint structure (API mapping)

Mitigations:
- Omit patch version: `2.3.x` instead of `2.3.1`
- Use `description` field carefully
- Consider rate limiting on discovery endpoint

### 8.4 Transport Security

- Discovery MUST be served over HTTPS in production
- TLS 1.2+ required
- HSTS recommended

### 8.5 CORS

For browser-based agents:

```http
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, HEAD
Access-Control-Allow-Headers: Accept, Authorization
```

---

## 9. Example Requests and Responses

### 9.1 Basic Discovery

**Request:**
```http
GET /.well-known/lafs.json HTTP/1.1
Host: api.example.com
Accept: application/json
```

**Response:**
```http
HTTP/1.1 200 OK
Content-Type: application/json
ETag: "v1-abc123"
Cache-Control: max-age=3600, public
Last-Modified: Mon, 16 Feb 2026 10:00:00 GMT
Content-Length: 892

{
  "$schema": "https://lafs.dev/schemas/v1/discovery.schema.json",
  "lafs_version": "1.0.0",
  "service": {
    "name": "example-api",
    "version": "1.0.0"
  },
  "capabilities": {
    "protocol": {
      "versions_supported": ["1.0.0"],
      "version_negotiation": "header"
    },
    "features": {
      "mvi_levels": ["standard", "full"],
      "pagination_modes": ["cursor"],
      "strict_mode": true,
      "context_ledger": false,
      "field_selection": true,
      "expansion": false,
      "budgets": {
        "supported": false,
        "types": []
      }
    }
  },
  "endpoints": {
    "base_url": "https://api.example.com",
    "envelope_endpoint": "/lafs/v1"
  },
  "caching": {
    "ttl_seconds": 3600,
    "etag": "v1-abc123",
    "immutable": false
  },
  "security": {
    "discovery_public": true,
    "auth_required": true,
    "schemes": [
      {
        "type": "apiKey",
        "description": "API key in X-API-Key header"
      }
    ]
  }
}
```

### 9.2 Cache Validation

**Request:**
```http
GET /.well-known/lafs.json HTTP/1.1
Host: api.example.com
Accept: application/json
If-None-Match: "v1-abc123"
```

**Response (Not Modified):**
```http
HTTP/1.1 304 Not Modified
ETag: "v1-abc123"
Cache-Control: max-age=3600, public
```

### 9.3 HEAD Request

**Request:**
```http
HEAD /.well-known/lafs.json HTTP/1.1
Host: api.example.com
```

**Response:**
```http
HTTP/1.1 200 OK
Content-Type: application/json
ETag: "v1-abc123"
Cache-Control: max-age=3600, public
Content-Length: 892
```

### 9.4 Version Negotiation Request

**Request:**
```http
GET /lafs/v1/tasks HTTP/1.1
Host: api.example.com
X-LAFS-Version: 1.0.0
X-API-Key: secret_key_here
Accept: application/json
```

**Response:**
```http
HTTP/1.1 200 OK
Content-Type: application/json
X-LAFS-Version: 1.0.0

{
  "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
  "_meta": {
    "specVersion": "1.0.0",
    "schemaVersion": "1.0.0",
    "timestamp": "2026-02-16T12:00:00Z",
    "operation": "tasks.list",
    "requestId": "req_abc123",
    "transport": "http",
    "strict": true,
    "mvi": "standard",
    "contextVersion": 0
  },
  "success": true,
  "result": {
    "items": []
  },
  "page": {
    "mode": "cursor",
    "nextCursor": null,
    "hasMore": false
  }
}
```

### 9.5 Unsupported Version Error

**Request:**
```http
GET /lafs/v1/tasks HTTP/1.1
Host: api.example.com
X-LAFS-Version: 2.0.0
```

**Response:**
```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
  "_meta": {
    "specVersion": "1.0.0",
    "schemaVersion": "1.0.0",
    "timestamp": "2026-02-16T12:00:00Z",
    "operation": "tasks.list",
    "requestId": "req_def456",
    "transport": "http",
    "strict": true,
    "mvi": "standard",
    "contextVersion": 0
  },
  "success": false,
  "error": {
    "code": "E_PROTOCOL_UNSUPPORTED_VERSION",
    "message": "LAFS version 2.0.0 is not supported",
    "category": "CONTRACT",
    "retryable": false,
    "retryAfterMs": null,
    "details": {
      "requested_version": "2.0.0",
      "supported_versions": ["1.0.0", "0.5.0"]
    }
  }
}
```

---

## 10. Implementation Guidelines

### 10.1 Server Implementation

```typescript
// Express.js example
import express from 'express';
import { readFileSync } from 'fs';

const app = express();

// Discovery document (could be generated or static)
const discoveryDoc = {
  $schema: "https://lafs.dev/schemas/v1/discovery.schema.json",
  lafs_version: "1.0.0",
  service: {
    name: "my-service",
    version: process.env.SERVICE_VERSION || "1.0.0"
  },
  capabilities: {
    protocol: {
      versions_supported: ["1.0.0"],
      version_negotiation: "header"
    },
    features: {
      mvi_levels: ["minimal", "standard", "full"],
      pagination_modes: ["cursor", "offset"],
      strict_mode: true,
      context_ledger: true,
      field_selection: true,
      expansion: true,
      budgets: {
        supported: true,
        types: ["token"]
      }
    }
  },
  endpoints: {
    base_url: process.env.API_BASE_URL,
    envelope_endpoint: "/v1/lafs"
  },
  caching: {
    ttl_seconds: 3600,
    immutable: false
  }
};

app.get('/.well-known/lafs.json', (req, res) => {
  const etag = `"${discoveryDoc.lafs_version}-${hash(discoveryDoc)}"`;
  
  // Check If-None-Match
  if (req.headers['if-none-match'] === etag) {
    return res.status(304).end();
  }
  
  res.set({
    'Content-Type': 'application/json',
    'ETag': etag,
    'Cache-Control': 'max-age=3600, public',
    'Vary': 'Accept'
  });
  
  res.json(discoveryDoc);
});
```

### 10.2 Client Implementation

```typescript
class LafsDiscoveryClient {
  private cache = new Map<string, { doc: any; expires: number }>();
  
  async discover(baseUrl: string): Promise<DiscoveryDocument> {
    const url = new URL('/.well-known/lafs.json', baseUrl).toString();
    
    // Check cache
    const cached = this.cache.get(url);
    if (cached && cached.expires > Date.now()) {
      return cached.doc;
    }
    
    // Fetch with cache validation
    const headers: Record<string, string> = {
      'Accept': 'application/json'
    };
    
    if (cached?.doc?.caching?.etag) {
      headers['If-None-Match'] = cached.doc.caching.etag;
    }
    
    const response = await fetch(url, { headers });
    
    if (response.status === 304 && cached) {
      // Update expiry
      cached.expires = Date.now() + (cached.doc.caching?.ttl_seconds || 3600) * 1000;
      return cached.doc;
    }
    
    if (!response.ok) {
      throw new Error(`Discovery failed: ${response.status}`);
    }
    
    const doc = await response.json();
    
    // Store in cache
    const ttl = doc.caching?.ttl_seconds || 3600;
    this.cache.set(url, {
      doc,
      expires: Date.now() + ttl * 1000
    });
    
    return doc;
  }
  
  // Capability helpers
  supportsMviLevel(doc: DiscoveryDocument, level: string): boolean {
    return doc.capabilities.features.mvi_levels.includes(level);
  }
  
  supportsPagination(doc: DiscoveryDocument, mode: string): boolean {
    return doc.capabilities.features.pagination_modes.includes(mode);
  }
  
  getEndpoint(doc: DiscoveryDocument, operation?: string): string {
    const base = doc.endpoints.base_url;
    if (operation && doc.endpoints.operations?.[operation]) {
      return `${base}${doc.endpoints.operations[operation]}`;
    }
    return `${base}${doc.endpoints.envelope_endpoint}`;
  }
}
```

---

## 11. Error Handling

### 11.1 Discovery Errors

| Error | HTTP Status | Description |
|-------|-------------|-------------|
| `E_DISCOVERY_NOT_FOUND` | 404 | Discovery endpoint not available |
| `E_DISCOVERY_INVALID` | 500 | Discovery document invalid |
| `E_DISCOVERY_UNAUTHORIZED` | 401 | Auth required for discovery |

### 11.2 Version Errors

| Error | HTTP Status | Description |
|-------|-------------|-------------|
| `E_PROTOCOL_UNSUPPORTED_VERSION` | 400 | Requested LAFS version not supported |
| `E_PROTOCOL_VERSION_REQUIRED` | 400 | Version negotiation required but not provided |

---

## 12. Future Considerations

### 12.1 Potential Extensions

- **Multi-tenant discovery** — Per-tenant capability variations
- **Service mesh integration** — Istio/Linkerd service discovery
- **GraphQL federation** — Subgraph capability advertisement
- **WebSocket upgrade** — Real-time capability negotiation

### 12.2 Version Evolution

Discovery protocol versioning:
- Minor versions: Add optional fields (backward compatible)
- Major versions: Structural changes (new endpoint or Accept header)

---

## 13. References

- [LAFS Specification](../../lafs.md)
- [RFC 5785: Defining Well-Known Uniform Resource Identifiers](https://tools.ietf.org/html/rfc5785)
- [RFC 7232: HTTP Conditional Requests](https://tools.ietf.org/html/rfc7232)
- [A2A Agent Card Specification](https://a2a-protocol.org/latest/specification/#agent-discovery)
- [Semantic Versioning 2.0.0](https://semver.org/)

---

## Appendix A: Discovery Document JSON Schema

The canonical JSON Schema for discovery documents is available at:

```
https://lafs.dev/schemas/v1/discovery.schema.json
```

---

## Appendix B: Changelog

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-02-16 | Initial release |

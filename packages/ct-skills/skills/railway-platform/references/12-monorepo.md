# Monorepo Deployment Patterns

Railway supports two distinct monorepo deployment strategies. Choosing the correct approach is critical for successful builds.

## Quick Decision

| Question | Answer | Approach |
|----------|--------|----------|
| Do apps import shared code? | Yes | **Custom Commands** |
| Are apps completely independent? | Yes | **Root Directory** |
| Using pnpm/yarn workspaces? | Yes | **Custom Commands** |
| Using Turborepo/Nx? | Yes | **Custom Commands** |

## Strategy 1: Root Directory (Isolated Monorepo)

**Use when:** Apps are completely independent, no shared code between them.

**How it works:** Only the specified directory's code is available during build.

**Example structure:**
```
├── frontend/          # React app
│   ├── package.json   # Standalone
│   └── src/
└── backend/           # Python API
    ├── requirements.txt
    └── main.py
```

**Configuration:**
```json
{
  "services": {
    "frontend-service-id": {
      "rootDirectory": "/frontend"
    },
    "backend-service-id": {
      "rootDirectory": "/backend"
    }
  }
}
```

## Strategy 2: Custom Commands (Shared Monorepo)

**Use when:** Apps share code from common packages or use workspace tools.

**How it works:** Full repo is available, commands filter to specific packages.

**Example structure:**
```
├── package.json           # Root workspace config
├── packages/
│   ├── frontend/          # Imports from shared
│   ├── backend/           # Imports from shared
│   └── shared/            # Shared utilities
├── pnpm-workspace.yaml
└── turbo.json
```

**Configuration:**

### pnpm Workspaces
```json
{
  "services": {
    "frontend-service-id": {
      "build": {
        "buildCommand": "pnpm --filter frontend build"
      },
      "deploy": {
        "startCommand": "pnpm --filter frontend start"
      },
      "source": {
        "watchPatterns": [
          "/packages/frontend/**",
          "/packages/shared/**"
        ]
      }
    }
  }
}
```

### npm Workspaces
```json
{
  "services": {
    "backend-service-id": {
      "build": {
        "buildCommand": "npm run build --workspace=packages/backend"
      },
      "deploy": {
        "startCommand": "npm run start --workspace=packages/backend"
      }
    }
  }
}
```

### Yarn Workspaces
```json
{
  "services": {
    "backend-service-id": {
      "build": {
        "buildCommand": "yarn workspace backend build"
      },
      "deploy": {
        "startCommand": "yarn workspace backend start"
      }
    }
  }
}
```

### Turborepo
```json
{
  "services": {
    "frontend-service-id": {
      "build": {
        "buildCommand": "turbo run build --filter=frontend"
      },
      "deploy": {
        "startCommand": "turbo run start --filter=frontend"
      },
      "source": {
        "watchPatterns": [
          "/apps/frontend/**",
          "/packages/**"
        ]
      }
    }
  }
}
```

## Watch Paths

Prevent unnecessary rebuilds by setting watch patterns.

**Critical:** Include shared packages that services depend on.

```json
{
  "services": {
    "frontend-service-id": {
      "source": {
        "watchPatterns": [
          "/packages/frontend/**",
          "/packages/shared/**",
          "/packages/ui/**"
        ]
      }
    },
    "backend-service-id": {
      "source": {
        "watchPatterns": [
          "/packages/backend/**",
          "/packages/shared/**",
          "/packages/db/**"
        ]
      }
    }
  }
}
```

**Pattern format:** Gitignore-style patterns
- `/packages/frontend/**` - All files in frontend
- `!**/*.md` - Ignore markdown changes

## Common Mistakes

### Mistake 1: Root Directory with Shared Code

**Wrong:**
```json
{
  "services": {
    "backend": {
      "rootDirectory": "/packages/backend"
    }
  }
}
```
**Result:** Build fails - shared package not accessible.

**Right:**
```json
{
  "services": {
    "backend": {
      "build": {
        "buildCommand": "pnpm --filter backend build"
      },
      "deploy": {
        "startCommand": "pnpm --filter backend start"
      }
    }
  }
}
```

### Mistake 2: Missing Shared Package in Watch Paths

**Wrong:**
```json
{
  "services": {
    "backend": {
      "source": {
        "watchPatterns": ["/packages/backend/**"]
      }
    }
  }
}
```
**Result:** Changes to shared package don't trigger backend rebuild.

**Right:**
```json
{
  "source": {
    "watchPatterns": [
      "/packages/backend/**",
      "/packages/shared/**"
    ]
  }
}
```

## Detection

### Check for Isolated Monorepo
```bash
# Apps have separate package.json
# No imports between directories
# No workspace config at root
ls apps/*/package.json | wc -l  # Multiple package.json
! test -f package.json || ! grep -q workspaces package.json
```

### Check for Shared Monorepo
```bash
# Has workspace indicators
[[ -f pnpm-workspace.yaml ]] || [[ -f turbo.json ]] || [[ -f nx.json ]] || grep -q workspaces package.json

# Or imports from sibling packages
grep -r "@myapp/shared" packages/
```

## Examples

### Complete Microservices Setup

```json
{
  "services": {
    "gateway": {
      "variables": {
        "AUTH_SERVICE": {"value": "http://auth.railway.internal:8080"},
        "USER_SERVICE": {"value": "http://users.railway.internal:8080"},
        "ORDER_SERVICE": {"value": "http://orders.railway.internal:8080"}
      }
    },
    "auth": {
      "variables": {
        "DATABASE_URL": {"value": "${{AuthDB.DATABASE_URL}}"},
        "REDIS_URL": {"value": "${{Redis.REDIS_URL}}"}
      }
    },
    "users": {
      "variables": {
        "DATABASE_URL": {"value": "${{UsersDB.DATABASE_URL}}"},
        "AUTH_URL": {"value": "http://auth.railway.internal:8080"}
      }
    }
  }
}
```

## Summary

| Aspect | Root Directory | Custom Commands |
|--------|---------------|-----------------|
| **Code isolation** | Each service sees only its directory | All services see full repo |
| **Shared packages** | Not supported | Fully supported |
| **Build speed** | Faster (less context) | Slower (full repo) |
| **Workspace tools** | Not compatible | Required |
| **Watch paths** | Optional | Essential |

**Golden rule:** If apps import from each other or use workspace tools, use Custom Commands. If completely independent, use Root Directory.

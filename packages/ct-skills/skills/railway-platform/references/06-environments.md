# Environment Configuration

Manage variables, build settings, deploy settings, and service configuration.

## Environment Variables

### Set Variable

```bash
railway variables set KEY=value
```

### Set Multiple Variables

```bash
railway variables set KEY1=value1 KEY2=value2
```

### List Variables

```bash
railway variables --json
```

Shows rendered (resolved) values.

### Delete Variable

```bash
railway variables delete KEY
```

### Raw Editor

For bulk changes, use dashboard Variables tab → "Raw Editor".

## Advanced Configuration

### Query Current Config

```bash
source _shared/scripts/railway-api.sh

ENV_ID=$(get_environment_id)

railway_api '
  query envConfig($environmentId: String!) {
    environment(id: $environmentId) {
      id
      config(decryptVariables: false)
    }
    environmentStagedChanges(environmentId: $environmentId) {
      id
      patch(decryptVariables: false)
    }
  }
' "{\"environmentId\": \"$ENV_ID\"}"
```

### Stage Changes

```bash
SERVICE_ID=$(get_service_id)

railway_api '
  mutation stageChanges($environmentId: String!, $input: EnvironmentConfig!) {
    environmentStageChanges(environmentId: $environmentId, input: $input, merge: true) {
      id
    }
  }
' "{\"environmentId\": \"$ENV_ID\", \"input\": {\"services\": {\"$SERVICE_ID\": {\"variables\": {\"API_KEY\": {\"value\": \"secret\", \"encrypted\": true}}}}}}"
```

### Apply Staged Changes

```bash
railway_api '
  mutation commitStaged($environmentId: String!, $message: String) {
    environmentPatchCommitStaged(environmentId: $environmentId, commitMessage: $message)
  }
' "{\"environmentId\": \"$ENV_ID\", \"message\": \"Add API_KEY variable\"}"
```

## Build Configuration

### Custom Build Command

```json
{
  "services": {
    "my-service": {
      "build": {
        "buildCommand": "npm run build:production"
      }
    }
  }
}
```

### Custom Start Command

```json
{
  "services": {
    "my-service": {
      "deploy": {
        "startCommand": "node dist/server.js"
      }
    }
  }
}
```

### Root Directory

For subdirectory deployment:

```json
{
  "services": {
    "frontend": {
      "rootDirectory": "/frontend"
    }
  }
}
```

### Watch Paths

Control which file changes trigger rebuilds:

```json
{
  "services": {
    "backend": {
      "source": {
        "watchPatterns": [
          "/backend/**",
          "/shared/**"
        ]
      }
    }
  }
}
```

## Deploy Configuration

### Health Checks

```json
{
  "services": {
    "api": {
      "deploy": {
        "healthcheck": {
          "enabled": true,
          "path": "/health",
          "port": 8080
        }
      }
    }
  }
}
```

### Replicas

```json
{
  "services": {
    "api": {
      "deploy": {
        "multiRegionConfig": {
          "us-west1": {
            "numReplicas": 2
          },
          "us-east1": {
            "numReplicas": 2
          }
        }
      }
    }
  }
}
```

### Restart Policy

```json
{
  "services": {
    "worker": {
      "deploy": {
        "restartPolicy": {
          "type": "ON_FAILURE",
          "maxRetries": 3
        }
      }
    }
  }
}
```

## Variable References

Reference variables from other services:

```json
{
  "services": {
    "backend": {
      "variables": {
        "DATABASE_URL": {
          "value": "${{Postgres.DATABASE_URL}}"
        }
      }
    }
  }
}
```

See [12-monorepo.md](12-monorepo.md) for variable reference syntax details.

## Complete Configuration Example

```json
{
  "services": {
    "api": {
      "build": {
        "buildCommand": "npm run build",
        "builder": "NIXPACKS"
      },
      "deploy": {
        "startCommand": "npm start",
        "healthcheck": {
          "enabled": true,
          "path": "/health"
        },
        "multiRegionConfig": {
          "us-west1": {"numReplicas": 2}
        }
      },
      "variables": {
        "NODE_ENV": {"value": "production"},
        "DATABASE_URL": {"value": "${{Postgres.DATABASE_URL}}"}
      },
      "source": {
        "watchPatterns": ["/api/**", "/shared/**"]
      }
    }
  }
}
```

## Next Steps

- [12-monorepo.md](12-monorepo.md) - Monorepo configuration
- [08-volumes.md](08-volumes.md) - Persistent storage
- [07-domains.md](07-domains.md) - Domain configuration

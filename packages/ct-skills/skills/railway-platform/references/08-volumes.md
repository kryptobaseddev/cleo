# Persistent Volumes

Railway volumes provide persistent storage that survives deployments and restarts.

## When to Use Volumes

**Use volumes for:**
- Database data persistence
- File uploads and user content
- Logs that must survive restarts
- Configuration files that change at runtime
- Cache directories that should persist

**Don't use volumes for:**
- Temporary files (use /tmp)
- Build artifacts
- Static assets (serve from CDN)
- Source code

## Volume Types

### Standard Volume

General purpose persistent storage:
- Mount at any path
- Survives deployments
- Tied to service and region
- Backed up automatically

### High-Availability Volume (Pro+)

Replicated across multiple zones:
- Higher durability
- Automatic failover
- Available on Pro and Enterprise plans

## Creating Volumes

### Via CLI

```bash
# Create volume
railway volume add --service my-service

# List volumes
railway volume list --service my-service

# Delete volume
railway volume delete <volume-id>
```

### Via Environment Config

```json
{
  "services": {
    "my-service": {
      "volumes": {
        "my-volume": {
          "mountPath": "/data"
        }
      }
    }
  }
}
```

## Mount Points

### Common Patterns

**Database data:**
```json
{
  "volumes": {
    "postgres-data": {
      "mountPath": "/var/lib/postgresql/data"
    }
  }
}
```

**File uploads:**
```json
{
  "volumes": {
    "uploads": {
      "mountPath": "/app/uploads"
    }
  }
}
```

**Logs:**
```json
{
  "volumes": {
    "app-logs": {
      "mountPath": "/app/logs"
    }
  }
}
```

### Mount Path Requirements

- Must be absolute path (starts with /)
- Cannot mount over system directories (/bin, /etc, etc.)
- Service must have permission to write to path
- Single volume can only mount to one path per service

## Database Volumes

### PostgreSQL with Volume

Railway's Postgres template automatically creates a volume. For custom setup:

```json
{
  "services": {
    "postgres": {
      "source": {
        "image": "postgres:15"
      },
      "volumes": {
        "postgres-data": {
          "mountPath": "/var/lib/postgresql/data"
        }
      },
      "variables": {
        "POSTGRES_DB": {"value": "mydb"},
        "POSTGRES_USER": {"value": "user"},
        "POSTGRES_PASSWORD": {"value": "password", "encrypted": true}
      }
    }
  }
}
```

### MongoDB with Volume

```json
{
  "services": {
    "mongo": {
      "source": {
        "image": "mongo:7"
      },
      "volumes": {
        "mongo-data": {
          "mountPath": "/data/db"
        }
      }
    }
  }
}
```

### MySQL with Volume

```json
{
  "services": {
    "mysql": {
      "source": {
        "image": "mysql:8"
      },
      "volumes": {
        "mysql-data": {
          "mountPath": "/var/lib/mysql"
        }
      }
    }
  }
}
```

## Application Volumes

### File Upload Service

```json
{
  "services": {
    "api": {
      "volumes": {
        "uploads": {
          "mountPath": "/app/public/uploads"
        }
      },
      "variables": {
        "UPLOAD_DIR": {"value": "/app/public/uploads"}
      }
    }
  }
}
```

**In your application:**
```javascript
// Node.js
const uploadDir = process.env.UPLOAD_DIR || './uploads';

// Python
import os
upload_dir = os.environ.get('UPLOAD_DIR', './uploads')
```

### Cache Directory

```json
{
  "services": {
    "worker": {
      "volumes": {
        "cache": {
          "mountPath": "/app/cache"
        }
      }
    }
  }
}
```

## Volume Sizing

### Default Sizes

- **Trial/Hobby:** Up to plan limits
- **Pro:** Configurable up to 100GB
- **Enterprise:** Custom limits

### Monitor Usage

```bash
# Check volume usage
railway metrics --service my-service
```

**Metrics to watch:**
- `DISK_USAGE_GB` - Current usage
- Volume approaching limit warnings

### Resize Volumes

Currently, volumes cannot be resized directly. To increase:

1. Create new larger volume
2. Copy data to new volume
3. Update service to use new volume
4. Delete old volume

## Volume Backup & Restore

### Automatic Backups

Railway automatically backs up volumes:
- Daily snapshots
- Kept for 7 days (Pro+)
- Point-in-time recovery

### Manual Backup

```bash
# Create snapshot (via API)
# See railway-api.sh for GraphQL mutations
```

### Restore from Backup

Contact Railway support for restore assistance or use API:

```bash
# Restore volume (via API)
```

## Multi-Region Considerations

### Volume Region Lock

Volumes are tied to a specific region:
- Created in service's primary region
- Cannot be mounted across regions
- Service must deploy to volume's region

### Regional Deployment

```json
{
  "services": {
    "database": {
      "volumes": {
        "data": {
          "mountPath": "/data"
        }
      },
      "deploy": {
        "multiRegionConfig": {
          "us-west1": {
            "numReplicas": 1
          }
        }
      }
    }
  }
}
```

## Railway Metal Volumes

### Stateful Railway Metal

Available March 2025 for Railway Metal regions:
- NVMe SSD storage
- Faster I/O performance
- Available for all plan types

### Migration

Volumes on Railway Metal:
- Created automatically for new services
- Existing volumes migrated gradually
- No action required

**See railway-metal reference for migration details.**

## Best Practices

### 1. Use Descriptive Names

**Good:**
```json
{
  "volumes": {
    "postgres-production-data": {
      "mountPath": "/var/lib/postgresql/data"
    }
  }
}
```

**Bad:**
```json
{
  "volumes": {
    "vol1": {
      "mountPath": "/data"
    }
  }
}
```

### 2. Mount at Standard Paths

Use conventional mount points:
- `/var/lib/<service>` for databases
- `/app/data` or `/app/uploads` for applications
- `/var/log/<app>` for logs

### 3. Separate Concerns

Use multiple volumes for different data:
```json
{
  "volumes": {
    "uploads": {"mountPath": "/app/uploads"},
    "logs": {"mountPath": "/app/logs"},
    "cache": {"mountPath": "/app/cache"}
  }
}
```

### 4. Environment Variables

Expose volume paths via environment variables:
```json
{
  "variables": {
    "DATA_DIR": {"value": "/app/data"},
    "LOG_DIR": {"value": "/app/logs"}
  }
}
```

### 5. Handle Missing Volumes Gracefully

**Application code:**
```javascript
// Create directory if doesn't exist
const fs = require('fs');
const uploadDir = process.env.UPLOAD_DIR;
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
```

## Troubleshooting

### Volume Not Mounting

**Symptom:** Data not persisting between deploys

**Check:**
1. Volume created and attached to service
2. Mount path is correct
3. Service writing to correct path
4. Check `railway status --json` for volume info

**Debug:**
```bash
# SSH into container
railway ssh

# Check mount
ls -la /your/mount/path
df -h

# Verify writes
 echo "test" > /your/mount/path/test.txt
```

### Permission Denied

**Symptom:** Cannot write to volume

**Fix:**
1. Ensure mount path is writable
2. Check user permissions in container
3. Use absolute paths

**Dockerfile fix:**
```dockerfile
RUN mkdir -p /app/data && chown -R app:app /app/data
```

### Out of Space

**Symptom:** Write failures, disk full errors

**Solution:**
1. Check current usage: `railway metrics`
2. Clean up unnecessary files
3. Contact support to increase limit (Pro+)

### Cross-Region Issues

**Symptom:** Volume not accessible

**Cause:** Service deployed to different region than volume

**Fix:** Deploy service to volume's region or create new volume in target region.

## Examples

### Complete Database Setup

```json
{
  "services": {
    "postgres": {
      "source": {
        "image": "postgres:15-alpine"
      },
      "volumes": {
        "postgres-data": {
          "mountPath": "/var/lib/postgresql/data"
        }
      },
      "variables": {
        "POSTGRES_DB": {"value": "appdb"},
        "POSTGRES_USER": {"value": "appuser"},
        "POSTGRES_PASSWORD": {"value": "changeme", "encrypted": true},
        "PGDATA": {"value": "/var/lib/postgresql/data/pgdata"}
      }
    }
  }
}
```

### File Storage Service

```json
{
  "services": {
    "file-api": {
      "volumes": {
        "uploads": {
          "mountPath": "/data/uploads"
        }
      },
      "variables": {
        "STORAGE_PATH": {"value": "/data/uploads"},
        "MAX_FILE_SIZE": {"value": "10485760"}
      }
    }
  }
}
```

**Express.js handler:**
```javascript
const express = require('express');
const multer = require('multer');
const path = require('path');

const uploadDir = process.env.STORAGE_PATH || './uploads';

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({ storage });

app.post('/upload', upload.single('file'), (req, res) => {
  res.json({ url: `/files/${req.file.filename}` });
});
```

## Summary

| Aspect | Details |
|--------|---------|
| **Use case** | Persistent data, uploads, databases |
| **Survives** | Deployments, restarts, service updates |
| **Tied to** | Service and region |
| **Backup** | Automatic daily snapshots |
| **Size** | Up to plan limits |
| **Regions** | Must match service region |

**Key point:** Volumes persist data across deployments. Use for anything that must survive service restarts.

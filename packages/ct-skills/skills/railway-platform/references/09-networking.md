# Private Networking

Railway's private networking enables secure service-to-service communication without exposing traffic to the public internet.

## Overview

**Benefits:**
- No egress charges for internal traffic
- Enhanced security (traffic never leaves Railway network)
- Automatic service discovery
- Simple hostname-based addressing

**Limitations:**
- Services must be in same project and environment
- Frontend apps in browser cannot access private network
- Regional - services in different regions use public networking

## How It Works

### Private Domains

Each service gets a private domain:
```
<service-name>.railway.internal
```

**Example:**
- Service named `api` → `api.railway.internal`
- Service named `backend` → `backend.railway.internal`

### Environment Variables

Railway provides these networking variables:

| Variable | Value Example | Use Case |
|----------|---------------|----------|
| `RAILWAY_PRIVATE_DOMAIN` | `abc123.railway.internal` | Internal addressing |
| `RAILWAY_PRIVATE_FQDN` | `api.abc123.railway.internal` | Full domain name |

## Connecting Services

### Backend-to-Backend

```
┌─────────────┐      Private Network       ┌─────────────┐
│   Frontend  │  ═══════════════════════►  │     API     │
│   (Browser) │      (Not possible)        │  (Internal) │
└─────────────┘                            └──────┬──────┘
                                                  │
                                                  │ Private
                                                  │ Network
                                                  ▼
                                          ┌─────────────┐
                                          │  Database   │
                                          │  (Internal) │
                                          └─────────────┘
```

**Frontend → API:** Must use public domain
**API → Database:** Uses private networking

### Configuration Example

```json
{
  "services": {
    "api": {
      "variables": {
        "DATABASE_URL": {
          "value": "${{Postgres.DATABASE_URL}}"
        }
      }
    },
    "frontend": {
      "variables": {
        "API_URL": {
          "value": "https://${{API.RAILWAY_PUBLIC_DOMAIN}}"
        }
      }
    }
  }
}
```

### Service Discovery Pattern

```javascript
// In your application
const services = {
  api: process.env.API_URL || `http://api.railway.internal`,
  cache: process.env.REDIS_URL || `redis://redis.railway.internal:6379`,
  db: process.env.DATABASE_URL
};

// Make internal request
const response = await fetch(`${services.api}/internal/health`);
```

## Use Cases

### Microservices Architecture

```json
{
  "services": {
    "gateway": {
      "variables": {
        "USERS_SERVICE": {"value": "http://users.railway.internal"},
        "ORDERS_SERVICE": {"value": "http://orders.railway.internal"},
        "INVENTORY_SERVICE": {"value": "http://inventory.railway.internal"}
      }
    },
    "users": {
      "variables": {
        "DATABASE_URL": {"value": "${{UsersDB.DATABASE_URL}}"}
      }
    },
    "orders": {
      "variables": {
        "DATABASE_URL": {"value": "${{OrdersDB.DATABASE_URL}}"},
        "USERS_API": {"value": "http://users.railway.internal"}
      }
    }
  }
}
```

### API + Worker Pattern

```json
{
  "services": {
    "api": {
      "variables": {
        "REDIS_URL": {"value": "${{Redis.REDIS_URL}}"},
        "DATABASE_URL": {"value": "${{Postgres.DATABASE_URL}}"}
      }
    },
    "worker": {
      "variables": {
        "REDIS_URL": {"value": "${{Redis.REDIS_URL}}"},
        "DATABASE_URL": {"value": "${{Postgres.DATABASE_URL}}"},
        "API_URL": {"value": "http://api.railway.internal"}
      }
    }
  }
}
```

**Worker fetches jobs from Redis, calls API for processing:**
```javascript
// worker.js
const Queue = require('bull');
const queue = new Queue('jobs', process.env.REDIS_URL);

queue.process(async (job) => {
  // Call API for processing
  const response = await fetch(`${process.env.API_URL}/process`, {
    method: 'POST',
    body: JSON.stringify(job.data)
  });
  return response.json();
});
```

## TCP Proxy

For external access to internal services:

### Enable TCP Proxy

```json
{
  "services": {
    "postgres": {
      "networking": {
        "tcpProxy": {
          "enabled": true,
          "port": 5432
        }
      }
    }
  }
}
```

### Connection URL

With TCP proxy enabled:
```
${{Postgres.DATABASE_PUBLIC_URL}}
```

**Warning:** TCP proxy exposes service to internet. Use strong authentication.

## Networking Architecture

### Regional Networking

Services in same region:
```
┌──────────────┐         ┌──────────────┐
│  Service A   │◄───────►│  Service B   │
│  us-west1    │ Private │  us-west1    │
└──────────────┘         └──────────────┘
```

Services in different regions:
```
┌──────────────┐         Public         ┌──────────────┐
│  Service A   │◄──────────────────────►│  Service B   │
│  us-west1    │   (Egress charges)     │  us-east1    │
└──────────────┘                        └──────────────┘
```

**Best practice:** Deploy related services to same region for free internal networking.

### Railway Metal Networking

Railway Metal uses enhanced networking:
- Anycast edge network
- Optimized routing
- Lower latency

Services on Railway Metal in same region still use private networking.

## Security

### Private Network Isolation

Traffic within private network:
- ✅ Encrypted in transit
- ✅ Isolated from other projects
- ✅ Not exposed to internet
- ✅ No egress charges

### Frontend Considerations

**Never expose private domains to frontend:**

**Bad (frontend code):**
```javascript
// This won't work - browser can't access private network
const apiUrl = 'http://api.railway.internal';
```

**Good (frontend code):**
```javascript
// Use public domain
const apiUrl = 'https://api.up.railway.app';
```

### Database Security

**Recommended:**
```json
{
  "services": {
    "database": {
      "networking": {
        "tcpProxy": {
          "enabled": false  // Keep private
        }
      }
    }
  }
}
```

Only enable TCP proxy when external access is absolutely required.

## Troubleshooting

### Cannot Connect to Private Domain

**Symptoms:**
- `connection refused`
- `getaddrinfo ENOTFOUND`
- Timeout errors

**Checklist:**

1. **Same project and environment:**
```bash
railway status --json
# Verify both services show same project and environment
```

2. **Service is deployed:**
```bash
railway service status --json
# Check deployment status is SUCCESS
```

3. **Correct domain format:**
```
# Good
http://api.railway.internal

# Bad (missing protocol)
api.railway.internal

# Bad (wrong suffix)
api.railway.app
```

4. **Port is correct:**
```
# HTTP services
http://api.railway.internal:8080

# Default HTTP port (80) not used internally
```

### Connection Timeout

**Causes:**
- Service crashed
- Service not listening on correct port
- Health check failing

**Debug:**
```bash
# Check service health
railway service status

# View logs
railway logs --lines 100

# SSH to debug
railway ssh
```

### Cross-Region Issues

**Symptom:** High latency or connection issues between services

**Cause:** Services in different regions use public networking

**Solutions:**
1. Deploy services to same region
2. Accept latency/cost trade-off
3. Use CDN for static assets

### DNS Resolution Failures

**Test DNS:**
```bash
# From within container
railway ssh

# Check resolution
nslookup api.railway.internal
dig api.railway.internal
```

## Best Practices

### 1. Use Environment Variables

Don't hardcode private domains:

**Good:**
```javascript
const apiUrl = process.env.API_URL || 'http://api.railway.internal';
```

**Bad:**
```javascript
const apiUrl = 'http://api.railway.internal'; // Hardcoded
```

### 2. Health Checks for Dependencies

Verify connections at startup:

```javascript
async function checkDependencies() {
  const deps = [
    { name: 'API', url: process.env.API_URL + '/health' },
    { name: 'Redis', url: process.env.REDIS_URL }
  ];
  
  for (const dep of deps) {
    try {
      await fetch(dep.url);
      console.log(`✓ ${dep.name} is reachable`);
    } catch (error) {
      console.error(`✗ ${dep.name} is not reachable:`, error.message);
    }
  }
}
```

### 3. Retry Logic

Handle transient network issues:

```javascript
async function fetchWithRetry(url, options = {}, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}
```

### 4. Circuit Breaker Pattern

Prevent cascading failures:

```javascript
class CircuitBreaker {
  constructor(threshold = 5, timeout = 60000) {
    this.failureCount = 0;
    this.threshold = threshold;
    this.timeout = timeout;
    this.state = 'CLOSED';
  }
  
  async call(fn) {
    if (this.state === 'OPEN') {
      throw new Error('Circuit breaker is OPEN');
    }
    
    try {
      const result = await fn();
      this.success();
      return result;
    } catch (error) {
      this.failure();
      throw error;
    }
  }
  
  success() {
    this.failureCount = 0;
    this.state = 'CLOSED';
  }
  
  failure() {
    this.failureCount++;
    if (this.failureCount >= this.threshold) {
      this.state = 'OPEN';
      setTimeout(() => {
        this.state = 'HALF_OPEN';
      }, this.timeout);
    }
  }
}
```

### 5. Regional Co-location

Deploy related services to same region:

```json
{
  "services": {
    "api": {
      "deploy": {
        "multiRegionConfig": {
          "us-west1": {"numReplicas": 2},
          "us-east1": {"numReplicas": 2}
        }
      }
    },
    "database": {
      "deploy": {
        "multiRegionConfig": {
          "us-west1": {"numReplicas": 1}
        }
      }
    }
  }
}
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
    },
    "orders": {
      "variables": {
        "DATABASE_URL": {"value": "${{OrdersDB.DATABASE_URL}}"},
        "USER_SERVICE": {"value": "http://users.railway.internal:8080"},
        "INVENTORY_SERVICE": {"value": "http://inventory.railway.internal:8080"}
      }
    }
  }
}
```

**Gateway routing:**
```javascript
// gateway/index.js
const express = require('express');
const proxy = require('http-proxy-middleware');

const app = express();

app.use('/auth', proxy({
  target: process.env.AUTH_SERVICE,
  changeOrigin: true
}));

app.use('/users', proxy({
  target: process.env.USER_SERVICE,
  changeOrigin: true
}));

app.use('/orders', proxy({
  target: process.env.ORDER_SERVICE,
  changeOrigin: true
}));

app.listen(process.env.PORT);
```

### Worker Queue Pattern

```javascript
// worker.js
const Queue = require('bull');
const axios = require('axios');

const taskQueue = new Queue('tasks', process.env.REDIS_URL);

const apiClient = axios.create({
  baseURL: process.env.API_URL
});

taskQueue.process(async (job) => {
  console.log(`Processing job ${job.id}:`, job.data);
  
  // Fetch additional data from API
  const user = await apiClient.get(`/users/${job.data.userId}`);
  
  // Process task
  const result = await processTask(job.data, user.data);
  
  // Report completion
  await apiClient.post(`/jobs/${job.id}/complete`, result);
  
  return result;
});

async function processTask(data, user) {
  // Task processing logic
  return { success: true, processedAt: new Date() };
}
```

## Summary

| Feature | Details |
|---------|---------|
| **Domain format** | `service-name.railway.internal` |
| **Cost** | Free (no egress charges) |
| **Scope** | Same project and environment |
| **Security** | Encrypted, isolated from internet |
| **Discovery** | Automatic via service name |
| **Regions** | Same region only for private |

**Key rule:** Private networking is for backend-to-backend only. Frontends must use public domains.

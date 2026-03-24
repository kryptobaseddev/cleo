# LAFS Deployment Guide

**Version:** 1.1.0  
**Last Updated:** 2026-02-16

---

## Overview

This guide covers deploying LAFS in production environments. LAFS can be deployed as:

1. **Standalone REST API** (A2P pattern)
2. **MCP Tool Server** with LAFS envelopes
3. **A2A Agent** using official SDK
4. **Integrated service** in existing applications

---

## Prerequisites

### System Requirements

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| Node.js | 18.x | 20.x LTS |
| Memory | 512MB | 2GB |
| CPU | 1 core | 2+ cores |
| Disk | 100MB | 1GB |

### Dependencies

```bash
# Core package
npm install @cleocode/lafs

# For A2A integration
npm install @a2a-js/sdk

# For monitoring (optional)
npm install prom-client
```

---

## Deployment Patterns

### Pattern 1: Standalone REST API (A2P)

Deploy LAFS as a dedicated API service.

```typescript
// server.ts
import express from 'express';
import { LAFSServer } from '@cleocode/lafs/server';
import { healthCheck } from '@cleocode/lafs/health';

const app = express();
const lafsServer = new LAFSServer({
  enforceBudgets: true,
  defaultMVI: 'standard',
  port: process.env.PORT || 3000
});

// Health check endpoint
app.get('/health', healthCheck(lafsServer));

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  lafsServer.shutdown().then(() => {
    process.exit(0);
  });
});

lafsServer.start();
```

**Dockerfile:**
```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .
RUN npm run build

EXPOSE 3000

USER node

CMD ["node", "dist/server.js"]
```

**docker-compose.yml:**
```yaml
version: '3.8'
services:
  lafs-api:
    build: .
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - PORT=3000
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
    restart: unless-stopped
```

### Pattern 2: MCP Tool Server

Deploy as an MCP (Model Context Protocol) tool server.

```typescript
// mcp-server.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { withBudget } from '@cleocode/lafs';

const server = new Server({
  name: 'lafs-mcp-server',
  version: '1.1.0'
}, {
  capabilities: { tools: {} }
});

server.setRequestHandler(CallToolRequestSchema, 
  withBudget({ maxTokens: 4000 }, async (request) => {
    // Tool implementation
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

### Pattern 3: A2A Agent

Deploy as an A2A-compliant agent.

```typescript
// a2a-agent.ts
import { ClientFactory } from '@a2a-js/sdk/client';
import { withLafsEnvelope } from '@cleocode/lafs/a2a';

const factory = new ClientFactory();
const a2aClient = await factory.createFromUrl(process.env.A2A_ENDPOINT);
const client = withLafsEnvelope(a2aClient, {
  defaultBudget: { maxTokens: 4000 }
});
```

---

## Environment Configuration

### Required Environment Variables

```bash
# Server configuration
PORT=3000
NODE_ENV=production

# LAFS configuration
LAFS_DEFAULT_MVI=standard
LAFS_ENFORCE_BUDGETS=true
LAFS_MAX_TOKENS=4000

# A2A configuration (if using)
A2A_ENDPOINT=https://agent.example.com
A2A_DEFAULT_BUDGET=4000

# Monitoring (optional)
METRICS_PORT=9090
METRICS_ENABLED=true
```

### Configuration File

Create `lafs.config.json`:

```json
{
  "server": {
    "port": 3000,
    "host": "0.0.0.0"
  },
  "lafs": {
    "enforceBudgets": true,
    "defaultMVI": "standard",
    "maxTokens": 4000
  },
  "health": {
    "enabled": true,
    "path": "/health",
    "interval": 30
  },
  "circuitBreaker": {
    "enabled": true,
    "failureThreshold": 5,
    "resetTimeout": 30000
  }
}
```

---

## Health Checks

### Endpoint

LAFS provides a health check endpoint:

```
GET /health
```

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2026-02-16T10:00:00Z",
  "version": "1.1.0",
  "checks": {
    "envelopeValidation": "ok",
    "tokenBudgets": "ok",
    "schemaValidation": "ok"
  },
  "uptime": 3600
}
```

### Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: lafs-api
spec:
  replicas: 3
  template:
    spec:
      containers:
      - name: lafs
        image: lafs-api:1.1.0
        ports:
        - containerPort: 3000
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 10
          periodSeconds: 30
        readinessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 10
```

---

## Monitoring

### Prometheus Metrics

LAFS exposes Prometheus metrics at `/metrics`:

```typescript
import { register } from 'prom-client';

// Add metrics endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});
```

**Available Metrics:**
- `lafs_envelopes_validated_total` - Total envelopes validated
- `lafs_budget_exceeded_total` - Budget exceeded errors
- `lafs_request_duration_seconds` - Request duration
- `lafs_active_connections` - Active connections

### Logging

```typescript
import { createLogger } from '@cleocode/lafs';

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: 'json'
});

// All LAFS operations are logged
logger.info('LAFS server started', { version: '1.1.0' });
```

---

## Graceful Shutdown

LAFS handles graceful shutdown automatically:

```typescript
import { gracefulShutdown } from '@cleocode/lafs';

// Register shutdown handlers
gracefulShutdown(server, {
  timeout: 30000,  // 30 seconds
  signals: ['SIGTERM', 'SIGINT']
});
```

**Shutdown Sequence:**
1. Stop accepting new connections
2. Wait for active requests to complete (up to timeout)
3. Close database connections
4. Exit process

---

## Circuit Breaker

Protect against cascading failures:

```typescript
import { CircuitBreaker } from '@cleocode/lafs';

const breaker = new CircuitBreaker({
  failureThreshold: 5,
  resetTimeout: 30000,
  halfOpenRequests: 3
});

// Wrap external calls
const result = await breaker.execute(async () => {
  return await externalService.call();
});
```

**States:**
- `CLOSED` - Normal operation
- `OPEN` - Failing fast after threshold
- `HALF_OPEN` - Testing if service recovered

---

## Security Best Practices

### 1. Input Validation

Always validate inputs:

```typescript
import { validateEnvelope } from '@cleocode/lafs';

app.post('/api', (req, res) => {
  const result = validateEnvelope(req.body);
  if (!result.valid) {
    return res.status(400).json({ errors: result.errors });
  }
  // Process valid envelope
});
```

### 2. Token Budgets

Enforce budgets to prevent DoS:

```typescript
const server = new LAFSServer({
  enforceBudgets: true,
  maxTokens: 4000  // Hard limit
});
```

### 3. CORS Configuration

```typescript
import cors from 'cors';

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || [],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
```

---

## Troubleshooting

See [Troubleshooting Guide](./troubleshooting.md) for common issues.

---

## Scaling

### Horizontal Scaling

LAFS is stateless and scales horizontally:

```yaml
# kubernetes-hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: lafs-api
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: lafs-api
  minReplicas: 3
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
```

### Load Balancing

```nginx
# nginx.conf
upstream lafs_backend {
    least_conn;
    server lafs-api-1:3000;
    server lafs-api-2:3000;
    server lafs-api-3:3000;
}

server {
    listen 80;
    location / {
        proxy_pass http://lafs_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

---

## Production Checklist

- [ ] Health check endpoint configured
- [ ] Graceful shutdown implemented
- [ ] Circuit breaker enabled
- [ ] Logging configured
- [ ] Metrics enabled
- [ ] Environment variables set
- [ ] CORS configured
- [ ] Rate limiting enabled
- [ ] SSL/TLS configured
- [ ] Backup strategy defined
- [ ] Runbook created
- [ ] On-call rotation established

---

## Support

- **Documentation:** https://codluv.gitbook.io/lafs/
- **Issues:** https://github.com/kryptobaseddev/lafs/issues
- **Discussions:** GitHub Discussions

---

*Deployment Guide v1.1.0*

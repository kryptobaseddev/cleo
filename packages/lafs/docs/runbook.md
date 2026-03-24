# LAFS Operational Runbook

**Version:** 1.1.0  
**Purpose:** Day-to-day operations for LAFS deployments

---

## Quick Reference

### Service Status

```bash
# Check if service is running
curl http://localhost:3000/health

# Check metrics
curl http://localhost:3000/metrics

# Check version
curl http://localhost:3000/version
```

### Restart Procedures

```bash
# Graceful restart
kill -SIGTERM <pid>

# Force restart (if graceful fails)
kill -SIGKILL <pid>
```

---

## Daily Operations

### Health Monitoring

**Check health endpoint:**
```bash
curl -s http://localhost:3000/health | jq
```

**Expected response:**
```json
{
  "status": "healthy",
  "timestamp": "2026-02-16T10:00:00Z",
  "version": "1.1.0",
  "checks": {
    "envelopeValidation": "ok",
    "tokenBudgets": "ok",
    "schemaValidation": "ok"
  }
}
```

**Alert if:**
- Status is not "healthy"
- Any check returns "error"
- Response time > 5 seconds

### Log Monitoring

**View logs:**
```bash
# Real-time logs
docker logs -f lafs-api

# Search for errors
docker logs lafs-api 2>&1 | grep ERROR

# View last 100 lines
docker logs --tail 100 lafs-api
```

**Key log patterns:**
```
INFO: Request processed successfully
WARN: Budget threshold reached
ERROR: Validation failed
FATAL: Circuit breaker opened
```

### Metrics Review

**Key metrics to monitor:**

| Metric | Warning | Critical |
|--------|---------|----------|
| Request latency (p99) | > 500ms | > 2000ms |
| Error rate | > 1% | > 5% |
| Active connections | > 100 | > 500 |
| Memory usage | > 70% | > 90% |
| Circuit breaker open | - | Any open |

**Query Prometheus:**
```promql
# Request rate
rate(lafs_requests_total[5m])

# Error rate
rate(lafs_errors_total[5m]) / rate(lafs_requests_total[5m])

# Budget exceeded rate
rate(lafs_budget_exceeded_total[5m])
```

---

## Common Procedures

### 1. Scaling Up

**When:** CPU > 70%, latency increasing

**Steps:**
```bash
# Kubernetes
kubectl scale deployment lafs-api --replicas=5

# Docker Compose
docker-compose up -d --scale lafs-api=5

# Verify scaling
curl http://localhost:3000/health
```

### 2. Circuit Breaker Management

**Check circuit breaker status:**
```bash
curl http://localhost:3000/circuit-breakers | jq
```

**Manually reset (emergency only):**
```bash
curl -X POST http://localhost:3000/circuit-breakers/reset
```

**When circuit breaker opens:**
1. Check downstream service health
2. Review error logs
3. Fix root cause
4. Circuit breaker auto-resets after timeout (30s default)

### 3. Budget Configuration Updates

**Update token budgets without restart:**
```bash
# POST new configuration
curl -X POST http://localhost:3000/config/budgets \
  -H "Content-Type: application/json" \
  -d '{
    "defaultMaxTokens": 4000,
    "strictEnforcement": true
  }'
```

### 4. Schema Updates

**Hot-reload schema (zero downtime):**
```bash
# Upload new schema
curl -X POST http://localhost:3000/admin/schemas/reload \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Verify
http://localhost:3000/health
```

---

## Incident Response

### Severity Levels

**SEV 1 - Critical:**
- Complete service outage
- Data corruption
- Security breach

**SEV 2 - High:**
- Degraded performance (>50% error rate)
- Circuit breakers opening across services
- Memory leaks

**SEV 3 - Medium:**
- Elevated error rates (5-50%)
- Increased latency
- Non-critical features failing

**SEV 4 - Low:**
- Warnings in logs
- Minor performance degradation
- Documentation issues

### Response Procedures

**SEV 1 - Service Down:**

1. **Immediate (0-5 min):**
   ```bash
   # Check if process is running
   ps aux | grep lafs
   
   # Check container status
   docker ps | grep lafs
   
   # Check logs for crash
   docker logs lafs-api --tail 100
   ```

2. **Restart service:**
   ```bash
   # Docker
   docker-compose restart lafs-api
   
   # Kubernetes
   kubectl rollout restart deployment/lafs-api
   ```

3. **Verify recovery:**
   ```bash
   # Wait for health check
   for i in {1..30}; do
     curl -s http://localhost:3000/health && break
     sleep 1
   done
   ```

4. **Post-incident:**
   - Capture logs
   - Document timeline
   - Schedule post-mortem

**SEV 2 - High Error Rate:**

1. **Identify source:**
   ```bash
   # Check error distribution
   curl http://localhost:3000/metrics | grep lafs_errors
   
   # Check recent logs
   docker logs lafs-api 2>&1 | grep ERROR | tail -20
   ```

2. **Check circuit breakers:**
   ```bash
   curl http://localhost:3000/circuit-breakers
   ```

3. **Scale if needed:**
   ```bash
   kubectl scale deployment lafs-api --replicas=10
   ```

4. **Monitor recovery:**
   ```bash
   watch -n 5 'curl -s http://localhost:3000/metrics | grep error_rate'
   ```

### Rollback Procedures

**Rollback to previous version:**

```bash
# Kubernetes
kubectl rollout undo deployment/lafs-api

# Docker Compose
docker-compose pull lafs-api:1.0.0
docker-compose up -d

# Verify rollback
curl http://localhost:3000/version
```

---

## Maintenance Windows

### Scheduled Maintenance

**Pre-maintenance:**
```bash
# Enable maintenance mode
curl -X POST http://localhost:3000/admin/maintenance \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"enabled": true, "message": "Scheduled maintenance"}'

# Wait for active requests to complete
curl http://localhost:3000/metrics | grep active_connections
```

**Post-maintenance:**
```bash
# Disable maintenance mode
curl -X POST http://localhost:3000/admin/maintenance \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"enabled": false}'

# Run health checks
./scripts/health-check.sh
```

### Database Maintenance (if applicable)

**Backup before maintenance:**
```bash
# Create backup
curl -X POST http://localhost:3000/admin/backup \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Verify backup
curl http://localhost:3000/admin/backups/latest
```

---

## Performance Tuning

### Identifying Bottlenecks

**High CPU:**
```bash
# Profile CPU usage
node --prof server.js

# Check event loop lag
curl http://localhost:3000/metrics | grep event_loop_lag
```

**High Memory:**
```bash
# Check heap usage
curl http://localhost:3000/metrics | grep heap_used

# Generate heap dump (if configured)
curl -X POST http://localhost:3000/admin/heapdump
```

**High Latency:**
```bash
# Check p99 latency
curl http://localhost:3000/metrics | grep latency_p99

# Review slow requests
docker logs lafs-api | grep "slow_request"
```

### Optimization Checklist

- [ ] Token budgets enforced
- [ ] Circuit breakers configured
- [ ] Connection pooling enabled
- [ ] Compression enabled (gzip/brotli)
- [ ] Caching configured
- [ ] Rate limiting applied
- [ ] Graceful shutdown configured

---

## Backup and Recovery

### Configuration Backup

```bash
# Backup configuration
kubectl get configmap lafs-config -o yaml > config-backup.yaml

# Backup secrets
kubectl get secret lafs-secrets -o yaml > secrets-backup.yaml
```

### Recovery

```bash
# Restore configuration
kubectl apply -f config-backup.yaml

# Rolling restart
kubectl rollout restart deployment/lafs-api
```

---

## Alerting Rules

### Prometheus Alert Rules

```yaml
groups:
- name: lafs
  rules:
  - alert: LAFSHighErrorRate
    expr: rate(lafs_errors_total[5m]) > 0.05
    for: 5m
    labels:
      severity: critical
    annotations:
      summary: "LAFS error rate is high"
      
  - alert: LAFSHighLatency
    expr: histogram_quantile(0.99, rate(lafs_request_duration_seconds_bucket[5m])) > 2
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "LAFS p99 latency is high"
      
  - alert: LAFSServiceDown
    expr: up{job="lafs"} == 0
    for: 1m
    labels:
      severity: critical
    annotations:
      summary: "LAFS service is down"
```

---

## Contact Information

### Escalation Path

1. **On-call Engineer** - Primary response
2. **Team Lead** - SEV 2+ incidents
3. **Engineering Manager** - SEV 1 incidents
4. **CTO** - Business-impacting outages

### Communication Channels

- **Slack:** #lafs-ops
- **PagerDuty:** LAFS Service
- **Email:** lafs-ops@company.com

---

## Appendix

### Useful Commands

```bash
# Check all pods
kubectl get pods -l app=lafs

# Check service endpoints
kubectl get endpoints lafs-api

# Port forward for debugging
kubectl port-forward pod/lafs-api-xxx 3000:3000

# Check resource usage
kubectl top pod -l app=lafs

# View events
kubectl get events --field-selector involvedObject.name=lafs-api
```

### Log Locations

- **Application:** `/var/log/lafs/app.log`
- **Error:** `/var/log/lafs/error.log`
- **Access:** `/var/log/lafs/access.log`

### Version History

See [CHANGELOG.md](../CHANGELOG.md) for version history.

---

*Operational Runbook v1.1.0*

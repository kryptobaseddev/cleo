# Railway Metal

Railway's own cloud infrastructure for improved performance and pricing.

## What is Railway Metal?

Railway Metal is Railway's custom infrastructure:
- **Owned hardware** in datacenters worldwide
- **NVMe SSD storage** for fast I/O
- **Better CPUs** with higher performance per core
- **Improved networking** with anycast edge

## Benefits

| Feature | Improvement |
|---------|-------------|
| **Pricing** | Up to 50% less egress, 40% less storage |
| **Performance** | Faster CPUs, better disk I/O |
| **Regions** | Available to all plans |
| **Reliability** | End-to-end hardware control |
| **Features** | Enables Static IPs, Anycast, HA volumes |

## Migration Timeline

| Date | Milestone |
|------|-----------|
| Dec 2024 | Trial/Hobby services on Railway Metal |
| Jan 2025 | Gradual volume-less migration |
| Feb 2025 | Pro services on Railway Metal |
| Mar 2025 | Stateful (volume) services begin |
| Jul 2025 | Migration complete |

## Checking Your Status

### Is Service on Railway Metal?

```bash
railway status --json | jq '.service'
```

Or check Dashboard:
- Service Settings → Deploy → Regions
- Look for "Metal (New)" tag

### Regional Availability

| Region | Status |
|--------|--------|
| US West (California) | ✅ Active |
| US East (Virginia) | ✅ Active |
| Europe West (Amsterdam) | ✅ Active |
| Southeast Asia (Singapore) | ✅ Active |

## Migration Behavior

### Automatic Migration

Services without volumes are automatically migrated:
- Brief downtime during migration
- Ephemeral storage wiped (expected)
- Rollback available if issues

### With Volumes

Stateful migrations (volumes) began March 2025:
- Volumes migrated to NVMe SSD
- Region must match between service and volume
- No cross-region volume mounts

## Opting In Early

### Manual Migration

```bash
# Go to Service Settings → Deploy → Regions
# Select region with "Metal (New)" tag
```

### Railway CLI

Via environment configuration:

```bash
source _shared/scripts/railway-api.sh

ENV_ID=$(get_environment_id)
SERVICE_ID=$(get_service_id)

# Update to Railway Metal region
railway_api '
  mutation stageChanges($environmentId: String!, $input: EnvironmentConfig!) {
    environmentStageChanges(environmentId: $environmentId, input: $input, merge: true) {
      id
    }
  }
' "{\"environmentId\": \"$ENV_ID\", \"input\": {\"services\": {\"$SERVICE_ID\": {\"deploy\": {\"multiRegionConfig\": {\"us-west1\": {\"numReplicas\": 1}}}}}}}"
```

## Rollback

### Automatic Rollback

If issues after migration:
1. Dashboard shows rollback banner
2. Click "Rollback" to revert

### Manual Rollback

```bash
# Service Settings → Deploy → Regions
# Select region without "Metal" tag
```

## Considerations

### Cross-Region Latency

If database in US West (Oregon) and app in US West (California):
- Increased latency due to physical distance
- Keep related services in same region
- Migrate together when possible

### Metrics Changes

Railway Metal has different metrics sampling:
- CPU may appear higher (more accurate sampling)
- RAM may appear lower
- Not actual usage changes, just better measurement

### Pricing

Automatic discounts applied when 80%+ workloads on Railway Metal:
- Egress: $0.10/GB → $0.05/GB
- Disk: $0.25/GB → $0.15/GB

## Troubleshooting

### Increased Latency

**Cause:** Service and database in different regions.

**Fix:**
```bash
# Check region of each service
railway status --json | jq '.service.region'

# Move to same region
# See migration steps above
```

### Service Issues After Migration

**Immediate fix:**
```bash
# Rollback via dashboard
# Or redeploy
railway redeploy -y
```

**Debug:**
```bash
# Check logs
railway logs --lines 100

# SSH for investigation
railway ssh
```

## Future Features

Railway Metal enables:
- **Static Inbound IPs** - Fixed IP addresses
- **Anycast Edge Network** - Global edge routing
- **High-Availability Volumes** - Multi-zone replication
- **Enhanced Networking** - Direct provider connections

## FAQ

**Q: Is Railway Metal stable?**
A: Yes, ~40,000 deployments running on it.

**Q: Will my service change?**
A: No code changes needed. Just infrastructure.

**Q: Can I stay on GCP?**
A: No, all services migrate to Railway Metal.

**Q: Do I need to do anything?**
A: No for most users. Migration is automatic.

**Q: Will costs change?**
A: Should decrease due to better pricing.

## Next Steps

- [09-networking.md](09-networking.md) - Networking features
- [13-troubleshooting.md](13-troubleshooting.md) - Migration issues

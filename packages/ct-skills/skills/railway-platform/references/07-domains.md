# Domain Management

Add custom domains and configure SSL certificates.

## Railway Domain (Auto-Generated)

### Generate Domain

```bash
railway domain --json
```

Creates `*.up.railway.app` domain automatically.

### Service-Specific Domain

```bash
railway domain --json --service backend
```

## Custom Domain

### Add Domain

```bash
railway domain example.com --json
```

Returns DNS records to configure:

```json
{
  "domain": "example.com",
  "dnsRecords": [
    {
      "type": "CNAME",
      "host": "@",
      "value": "railway.app"
    }
  ]
}
```

### Configure DNS

Add the DNS records to your provider:

**CNAME Record:**
- Type: CNAME
- Host: @ or subdomain
- Value: Provided by Railway

### Verify Domain

Domains are verified automatically once DNS propagates (can take up to 24 hours).

### Wildcard Domains

Railway supports wildcard domains:

```bash
railway domain "*.example.com" --json
```

## Domain Configuration

### Via Environment Config

```bash
source _shared/scripts/railway-api.sh

ENV_ID=$(get_environment_id)
SERVICE_ID=$(get_service_id)

# Add custom domain
railway_api '
  mutation stageChanges($environmentId: String!, $input: EnvironmentConfig!) {
    environmentStageChanges(environmentId: $environmentId, input: $input, merge: true) {
      id
    }
  }
' "{\"environmentId\": \"$ENV_ID\", \"input\": {\"services\": {\"$SERVICE_ID\": {\"networking\": {\"customDomains\": {\"new-domain\": {\"domain\": \"example.com\"}}}}}}}"
```

### Remove Domain

```bash
source _shared/scripts/railway-api.sh

# Remove custom domain
railway_api '
  mutation stageChanges($environmentId: String!, $input: EnvironmentConfig!) {
    environmentStageChanges(environmentId: $environmentId, input: $input, merge: true) {
      id
    }
  }
' "{\"environmentId\": \"$ENV_ID\", \"input\": {\"services\": {\"$SERVICE_ID\": {\"networking\": {\"customDomains\": {\"domain-id\": null}}}}}}"
```

## SSL Certificates

SSL certificates are automatically provisioned and renewed for all domains.

No manual configuration required.

## Port Configuration

Custom domains connect to the same port as Railway domains (your service's exposed port).

## Troubleshooting

### Domain Not Verifying

**Check DNS propagation:**
```bash
nslookup example.com
dig example.com
```

**Check DNS records:**
Ensure CNAME points exactly to the value Railway provided.

### SSL Certificate Issues

Certificates are auto-provisioned. If issues persist:
1. Check domain DNS is correct
2. Wait 24 hours for propagation
3. Contact Railway support

### Domain Already in Use

If domain is used in another project:
1. Remove from old project first
2. Or use different domain/subdomain

## Next Steps

- [09-networking.md](09-networking.md) - Private networking
- [13-troubleshooting.md](13-troubleshooting.md) - Advanced debugging

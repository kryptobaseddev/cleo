# Service Operations

Create, configure, and manage Railway services.

## Create Service

### Empty Service

```bash
railway add --service my-service
```

### From GitHub Repo

```bash
# Create empty service first
railway add --service my-api

# Then configure source (see 06-environments.md)
```

### From Docker Image

```bash
source _shared/scripts/railway-api.sh

PROJECT_ID=$(get_project_id)
ENV_ID=$(get_environment_id)

railway_api '
  mutation serviceCreate($input: ServiceCreateInput!) {
    serviceCreate(input: $input) {
      id
      name
    }
  }
' "{\"input\": {\"projectId\": \"$PROJECT_ID\", \"name\": \"nginx\", \"source\": {\"image\": \"nginx:latest\"}}}"
```

## Service Status

```bash
railway service status --json
```

Shows:
- Service name and ID
- Current deployment status
- Latest deployment info

## Update Service

### Rename Service

```bash
source _shared/scripts/railway-api.sh

SERVICE_ID=$(get_service_id)

railway_api '
  mutation updateService($id: String!, $input: ServiceUpdateInput!) {
    serviceUpdate(id: $id, input: $input) {
      id
      name
    }
  }
' "{\"id\": \"$SERVICE_ID\", \"input\": {\"name\": \"new-name\"}}"
```

### Change Icon

```bash
railway_api '
  mutation updateService($id: String!, $input: ServiceUpdateInput!) {
    serviceUpdate(id: $id, input: $input) {
      id
      icon
    }
  }
' "{\"id\": \"$SERVICE_ID\", \"input\": {\"icon\": \"https://devicons.railway.app/nodejs\"}}"
```

Icon sources:
- Devicons: `https://devicons.railway.app/{name}`
- Custom URL: Any image URL
- Emoji: Direct emoji string

## Link Service

Switch linked service for current directory:

```bash
railway service link
# Interactive selection

# Or specify directly
railway service link my-service
```

## Delete Service

```bash
source _shared/scripts/railway-api.sh

ENV_ID=$(get_environment_id)
SERVICE_ID=$(get_service_id)

# Stage deletion
railway_api '
  mutation stageChanges($environmentId: String!, $input: EnvironmentConfig!) {
    environmentStageChanges(environmentId: $environmentId, input: $input, merge: true) {
      id
    }
  }
' "{\"environmentId\": \"$ENV_ID\", \"input\": {\"services\": {\"$SERVICE_ID\": {\"isDeleted\": true}}}}"

# Apply changes (see 06-environments.md)
```

## Service Types

### Web Service

Default service type:
- Exposes HTTP port
- Public domain assigned
- Health checks enabled

### Worker

Background service:
- No public domain
- Runs continuously
- Good for queue processors

### Cron Job

Scheduled execution:
- Runs on schedule
- Exits after completion
- See [10-cron.md](10-cron.md)

## Next Steps

- [04-deployments.md](04-deployments.md) - Deploy services
- [06-environments.md](06-environments.md) - Configure services
- [05-databases.md](05-databases.md) - Database services

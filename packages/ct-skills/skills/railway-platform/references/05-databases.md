# Databases

Deploy and connect PostgreSQL, Redis, MySQL, and MongoDB.

## Available Databases

| Database | Template Code | Default Variable |
|----------|---------------|------------------|
| PostgreSQL | `postgres` | `DATABASE_URL` |
| Redis | `redis` | `REDIS_URL` |
| MySQL | `mysql` | `MYSQL_URL` |
| MongoDB | `mongodb` | `MONGO_URL` |

## Check for Existing Databases

Before creating, check if database exists:

```bash
source _shared/scripts/railway-api.sh

ENV_ID=$(get_environment_id)

railway_api '
  query environmentConfig($environmentId: String!) {
    environment(id: $environmentId) {
      config(decryptVariables: false)
    }
  }
' "{\"environmentId\": \"$ENV_ID\"}" | jq '.data.environment.config.services | to_entries[] | select(.value.source.image | contains("postgres") or contains("redis") or contains("mysql") or contains("mongo"))'
```

## Deploy Database Template

### Step 1: Get Template

```bash
source _shared/scripts/railway-api.sh

railway_api '
  query template($code: String!) {
    template(code: $code) {
      id
      name
      serializedConfig
    }
  }
' '{"code": "postgres"}'
```

### Step 2: Deploy

```bash
PROJECT_ID=$(get_project_id)
ENV_ID=$(get_environment_id)

# Get workspace ID
WORKSPACE_ID=$(railway_api '
  query getWorkspace($projectId: String!) {
    project(id: $projectId) { workspaceId }
  }
' "{\"projectId\": \"$PROJECT_ID\"}" | jq -r '.data.project.workspaceId')

# Deploy template
railway_api '
  mutation deployTemplate($input: TemplateDeployV2Input!) {
    templateDeployV2(input: $input) {
      projectId
      workflowId
    }
  }
' "{\"input\": {\"templateId\": \"TEMPLATE_ID\", \"serializedConfig\": SERIALIZED_CONFIG, \"projectId\": \"$PROJECT_ID\", \"environmentId\": \"$ENV_ID\", \"workspaceId\": \"$WORKSPACE_ID\"}}"
```

## Connect Service to Database

### Backend Connection

```bash
source _shared/scripts/railway-api.sh

ENV_ID=$(get_environment_id)
SERVICE_ID=$(get_service_id)

# Stage DATABASE_URL variable
railway_api '
  mutation stageChanges($environmentId: String!, $input: EnvironmentConfig!) {
    environmentStageChanges(environmentId: $environmentId, input: $input, merge: true) {
      id
    }
  }
' "{\"environmentId\": \"$ENV_ID\", \"input\": {\"services\": {\"$SERVICE_ID\": {\"variables\": {\"DATABASE_URL\": {\"value\": \"\\${{Postgres.DATABASE_URL}}\"}}}}}}"

# Apply changes
railway_api '
  mutation commitStaged($environmentId: String!, $message: String) {
    environmentPatchCommitStaged(environmentId: $environmentId, commitMessage: $message)
  }
' "{\"environmentId\": \"$ENV_ID\", \"message\": \"Add database connection\"}"
```

### Connection URLs

**PostgreSQL:**
- Private: `${{Postgres.DATABASE_URL}}`
- Public: `${{Postgres.DATABASE_PUBLIC_URL}}` (with TCP proxy)

**Redis:**
- Private: `${{Redis.REDIS_URL}}`
- Public: `${{Redis.REDIS_PUBLIC_URL}}`

**MySQL:**
- Private: `${{MySQL.MYSQL_URL}}`
- Public: `${{MySQL.MYSQL_PUBLIC_URL}}`

**MongoDB:**
- Private: `${{MongoDB.MONGO_URL}}`
- Public: `${{MongoDB.MONGO_PUBLIC_URL}}`

## Database with Volume

Databases created from templates automatically include volumes for persistence.

To verify:
```bash
railway status --json | jq '.services[] | select(.name | test("postgres|redis|mysql|mongo"; "i")) | .volumes'
```

## Complete Example

```bash
# 1. Check if postgres exists
# 2. If not, deploy postgres template
# 3. Get backend service ID
# 4. Wire DATABASE_URL
# 5. Apply changes
# 6. Deploy backend
```

## Next Steps

- [08-volumes.md](08-volumes.md) - Persistent storage details
- [09-networking.md](09-networking.md) - TCP proxy for external access

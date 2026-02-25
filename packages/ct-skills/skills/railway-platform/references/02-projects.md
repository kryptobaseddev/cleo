# Project Management

Manage Railway projects, workspaces, and settings.

## List Projects

```bash
railway list --json
```

Returns all projects across workspaces with essential fields.

## Switch Projects

### Link to Different Project

```bash
railway link -p project-name
```

### Unlink Current Directory

```bash
railway unlink
```

## Project Settings

### Update via API

```bash
source _shared/scripts/railway-api.sh

PROJECT_ID=$(get_project_id)

railway_api '
  mutation updateProject($id: String!, $input: ProjectUpdateInput!) {
    projectUpdate(id: $id, input: $input) {
      name
      prDeploys
      isPublic
    }
  }
' "{\"id\": \"$PROJECT_ID\", \"input\": {\"prDeploys\": true}}"
```

### Available Settings

| Setting | Type | Description |
|---------|------|-------------|
| `name` | String | Project name |
| `description` | String | Project description |
| `isPublic` | Boolean | Public visibility |
| `prDeploys` | Boolean | Deploy PRs to preview environments |
| `botPrEnvironments` | Boolean | Deploy Dependabot/Renovate PRs |

## Workspaces

### List Workspaces

```bash
railway whoami --json | jq '.workspaces'
```

### Create Project in Specific Workspace

```bash
railway init -n my-project --workspace workspace-id
```

## Environments

### Create Environment

```bash
railway environment new staging
```

### Duplicate Environment

```bash
railway environment new staging --duplicate production
```

### Switch Environment

```bash
railway environment staging
```

## PR Deploys

Enable automatic deployment of pull requests:

```bash
# Via API (see above)
# Set prDeploys: true
```

Each PR creates a preview environment with:
- Isolated database (if using templates)
- Unique URL
- Shared variables inherited

## Project Deletion

```bash
railway delete
```

⚠️ Permanent - cannot be undone.

## Next Steps

- [03-services.md](03-services.md) - Create services
- [06-environments.md](06-environments.md) - Environment configuration

#!/usr/bin/env bash
# Railway GraphQL API Helper
# Shared utility for all Railway skills
# Usage: source _shared/scripts/railway-api.sh && railway_api '<query>' ['<variables-json>']
# Or: ${SKILL_ROOT}/_shared/scripts/railway-api.sh '<query>' ['<variables-json>']

set -euo pipefail

RAILWAY_API_ENDPOINT="https://backboard.railway.com/graphql/v2"
RAILWAY_CONFIG_FILE="${HOME}/.railway/config.json"

# Check if jq is installed
check_jq() {
    if ! command -v jq &>/dev/null; then
        echo '{"error": "jq not installed. Install with: brew install jq or apt-get install jq"}' >&2
        return 1
    fi
}

# Get Railway token from config
get_railway_token() {
    if [[ ! -f "$RAILWAY_CONFIG_FILE" ]]; then
        echo '{"error": "Railway config not found. Run: railway login"}' >&2
        return 1
    fi
    
    local token
    token=$(jq -r '.user.token // empty' "$RAILWAY_CONFIG_FILE" 2>/dev/null)
    
    if [[ -z "$token" ]]; then
        echo '{"error": "No Railway token found. Run: railway login"}' >&2
        return 1
    fi
    
    echo "$token"
}

# Make GraphQL API call
# Usage: railway_api '<graphql-query>' ['<variables-json>']
railway_api() {
    local query="${1:-}"
    local variables="${2:-{}}"
    
    # Validate inputs
    if [[ -z "$query" ]]; then
        echo '{"error": "No GraphQL query provided"}' >&2
        return 1
    fi
    
    # Check dependencies
    check_jq || return 1
    
    local token
    token=$(get_railway_token) || return 1
    
    # Build payload
    local payload
    payload=$(jq -n --arg q "$query" --argjson v "$variables" '{query: $q, variables: $v}')
    
    # Make API call
    curl -s -f "$RAILWAY_API_ENDPOINT" \
        -H "Authorization: Bearer $token" \
        -H "Content-Type: application/json" \
        -d "$payload" || {
        echo '{"error": "API request failed"}' >&2
        return 1
    }
}

# Get project context from linked directory
get_project_context() {
    if ! command -v railway &>/dev/null; then
        echo '{"error": "Railway CLI not installed"}' >&2
        return 1
    fi
    
    railway status --json 2>/dev/null || {
        echo '{"error": "No project linked. Run: railway link"}' >&2
        return 1
    }
}

# Extract project ID from context
get_project_id() {
    local context
    context=$(get_project_context) || return 1
    echo "$context" | jq -r '.project.id'
}

# Extract environment ID from context  
get_environment_id() {
    local context
    context=$(get_project_context) || return 1
    echo "$context" | jq -r '.environment.id'
}

# Extract service ID from context
get_service_id() {
    local context
    context=$(get_project_context) || return 1
    echo "$context" | jq -r '.service.id // empty'
}

# Fetch environment configuration
fetch_env_config() {
    local env_id
    env_id=$(get_environment_id) || return 1
    
    local query='
    query environmentConfig($environmentId: String!) {
        environment(id: $environmentId) {
            id
            config(decryptVariables: false)
            serviceInstances {
                edges {
                    node {
                        id
                        serviceId
                    }
                }
            }
        }
    }'
    
    railway_api "$query" "{\"environmentId\": \"$env_id\"}"
}

# Stage environment changes
stage_changes() {
    local env_id="${1:-}"
    local config="${2:-}"
    
    if [[ -z "$env_id" || -z "$config" ]]; then
        echo '{"error": "Environment ID and config required"}' >&2
        return 1
    fi
    
    local query='
    mutation stageEnvironmentChanges(
        $environmentId: String!
        $input: EnvironmentConfig!
        $merge: Boolean
    ) {
        environmentStageChanges(
            environmentId: $environmentId
            input: $input
            merge: $merge
        ) {
            id
        }
    }'
    
    railway_api "$query" "{\"environmentId\": \"$env_id\", \"input\": $config, \"merge\": true}"
}

# Apply staged changes
apply_changes() {
    local env_id="${1:-}"
    local message="${2:-}"
    
    if [[ -z "$env_id" ]]; then
        echo '{"error": "Environment ID required"}' >&2
        return 1
    fi
    
    local query='
    mutation commitStaged($environmentId: String!, $message: String) {
        environmentPatchCommitStaged(
            environmentId: $environmentId
            commitMessage: $message
        )
    }'
    
    railway_api "$query" "{\"environmentId\": \"$env_id\", \"message\": \"$message\"}"
}

# Execute if called directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    railway_api "$@"
fi

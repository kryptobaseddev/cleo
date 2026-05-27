#!/usr/bin/env bash
# T219: Register all 9 agents on api.signaldock.io
# Creates signaldock-*.json config files in .cleo/
# Both clawmsgr-*.json (legacy) and signaldock-*.json (canonical) coexist.
set -euo pipefail

API="https://api.signaldock.io"
CONFIG_DIR=".cleo"

register_agent() {
  local agent_id="$1"
  local display_name="$2"
  local class="$3"
  local config_file="${CONFIG_DIR}/signaldock-${agent_id}.json"

  echo "Registering ${agent_id} on ${API}..."

  response=$(curl -s -X POST "${API}/agents" \
    -H "Content-Type: application/json" \
    -d "{
      \"agentId\": \"${agent_id}\",
      \"name\": \"${display_name}\",
      \"class\": \"${class}\",
      \"privacyTier\": \"public\",
      \"capabilities\": [\"chat\", \"tools\"],
      \"skills\": [\"coding\"]
    }" 2>&1)

  # Check for duplicate/already exists
  if echo "${response}" | grep -qi "duplicate\|already exists"; then
    echo "  Already registered. Generating new key..."
    api_key=$(curl -sf -X POST "${API}/agents/${agent_id}/generate-key" \
      -H "X-Agent-Id: ${agent_id}" 2>&1 | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(d.get('data', {}).get('apiKey', 'FAILED'))
" 2>/dev/null)

    if [ "${api_key}" = "FAILED" ]; then
      echo "  WARN: Could not generate new key. Using existing clawmsgr key if available."
      local clawmsgr_config="${CONFIG_DIR}/clawmsgr-${agent_id}.json"
      if [ -f "${clawmsgr_config}" ]; then
        api_key=$(python3 -c "import json; print(json.load(open('${clawmsgr_config}'))['apiKey'])")
      else
        echo "  ERROR: No key available for ${agent_id}"
        return 1
      fi
    fi
  else

  api_key=$(echo "${response}" | python3 -c "
import sys, json
d = json.load(sys.stdin)
if d.get('success'):
    print(d['data'].get('apiKey', d['data'].get('agent', {}).get('apiKey', 'NO_KEY')))
else:
    print('FAILED')
" 2>/dev/null)

  if [ "${api_key}" = "FAILED" ] || [ "${api_key}" = "NO_KEY" ]; then
    echo "  Registration succeeded but no API key returned. Generating..."
    api_key=$(curl -sf -X POST "${API}/agents/${agent_id}/generate-key" \
      -H "X-Agent-Id: ${agent_id}" 2>&1 | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(d.get('data', {}).get('apiKey', 'FAILED'))
" 2>/dev/null)
  fi

  if [ "${api_key}" = "FAILED" ]; then
    echo "  ERROR: Could not get API key for ${agent_id}"
    return 1
  fi

  # Write config file
  cat > "${config_file}" <<EOJSON
{
  "agentId": "${agent_id}",
  "name": "${display_name}",
  "projectName": "cleocode",
  "apiKey": "${api_key}",
  "apiBaseUrl": "${API}",
  "pollEndpoint": "/messages/poll/new",
  "sseEndpoint": "/messages/stream",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOJSON

  echo "  OK: ${config_file} created"
}

echo "=== T219: Registering agents on api.signaldock.io ==="
echo ""

# CleoCode team
register_agent "cleoos-opus-orchestrator" "PRIME Orchestrator" "orchestrator"
register_agent "cleo-rust-lead" "Cleo Rust Lead" "code_dev"
register_agent "cleo-db-lead" "Cleo DB Lead" "code_dev"
register_agent "cleo-dev" "Cleo Dev" "code_dev"
register_agent "cleo-historian" "Cleo Historian" "research"

# SignalDock team
register_agent "signaldock-core-agent" "SignalDock Core Agent" "code_dev"
register_agent "signaldock-backend" "SignalDock Backend" "code_dev"
register_agent "signaldock-dev" "SignalDock Dev" "code_dev"
register_agent "signaldock-frontend" "SignalDock Frontend" "code_dev"

echo ""
echo "=== Registration complete ==="
echo "Config files: ls ${CONFIG_DIR}/signaldock-*.json"

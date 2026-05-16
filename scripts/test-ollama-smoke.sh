#!/usr/bin/env bash
# test-ollama-smoke.sh — REAL-WORLD smoke test for the Ollama transport.
#
# Checks whether a local Ollama server is running at http://localhost:11434,
# then attempts a direct POST /api/chat call against the first available model.
#
# Exit codes:
#   0  — smoke test passed (Ollama responded with a valid chat completion)
#   1  — Ollama not available (skipped; not a test failure)
#   2  — Ollama available but request failed (actual failure)
#
# Usage:
#   bash scripts/test-ollama-smoke.sh
#   bash scripts/test-ollama-smoke.sh --output .cleo/agent-outputs/T9355-ollama-smoke.md
#
# @task T9355 (Task A — Ollama transport)
# @epic T9354
set -euo pipefail

OLLAMA_BASE="${OLLAMA_HOST:-http://localhost:11434}"
OUTPUT_FILE=""

# Parse --output flag
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      OUTPUT_FILE="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

log() { echo "[ollama-smoke] $*" >&2; }
die() { echo "[ollama-smoke] ERROR: $*" >&2; exit 2; }

write_output() {
  local status="$1"
  local detail="$2"
  if [[ -n "$OUTPUT_FILE" ]]; then
    mkdir -p "$(dirname "$OUTPUT_FILE")"
    cat > "$OUTPUT_FILE" <<EOF
# T9355 Ollama Smoke Test

**Date**: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
**Status**: $status
**Base URL**: $OLLAMA_BASE

## Detail

$detail
EOF
    log "Output written to $OUTPUT_FILE"
  fi
}

# ---------------------------------------------------------------------------
# Step 1: Check if Ollama is running
# ---------------------------------------------------------------------------

log "Checking Ollama at $OLLAMA_BASE ..."

if ! curl -sf --connect-timeout 3 "$OLLAMA_BASE/api/tags" > /tmp/ollama-tags.json 2>/dev/null; then
  log "Ollama is not running at $OLLAMA_BASE — skipping smoke test (exit 1)"
  write_output "SKIPPED" "Ollama is not running at \`$OLLAMA_BASE\`. Start it with \`ollama serve\` and re-run."
  exit 1
fi

log "Ollama is running. Reading available models..."

# ---------------------------------------------------------------------------
# Step 2: Pick a model
# ---------------------------------------------------------------------------

# Try to find llama3 or qwen; fall back to the first available model
PREFERRED_MODELS=("llama3" "qwen" "qwen2" "qwen2.5" "llama3.2" "llama3.1" "phi3")
CHOSEN_MODEL=""

# Extract models using python3 or jq, whichever is available
if command -v jq &>/dev/null; then
  AVAILABLE=$(jq -r '.models[].name' /tmp/ollama-tags.json 2>/dev/null || echo "")
elif command -v python3 &>/dev/null; then
  AVAILABLE=$(python3 -c "
import json, sys
data = json.load(open('/tmp/ollama-tags.json'))
for m in data.get('models', []):
    print(m['name'])
" 2>/dev/null || echo "")
else
  AVAILABLE=""
fi

for pref in "${PREFERRED_MODELS[@]}"; do
  if echo "$AVAILABLE" | grep -qi "^${pref}"; then
    CHOSEN_MODEL=$(echo "$AVAILABLE" | grep -i "^${pref}" | head -1)
    break
  fi
done

# Fall back to the first model available
if [[ -z "$CHOSEN_MODEL" && -n "$AVAILABLE" ]]; then
  CHOSEN_MODEL=$(echo "$AVAILABLE" | head -1)
fi

if [[ -z "$CHOSEN_MODEL" ]]; then
  log "No models available. Pull one with 'ollama pull llama3' — skipping smoke test (exit 1)"
  write_output "SKIPPED" "No models available. Run \`ollama pull llama3\` then re-run this script."
  exit 1
fi

log "Using model: $CHOSEN_MODEL"

# ---------------------------------------------------------------------------
# Step 3: Send a chat completion
# ---------------------------------------------------------------------------

REQUEST_BODY=$(cat <<EOF
{
  "model": "$CHOSEN_MODEL",
  "messages": [{"role": "user", "content": "Reply with exactly: smoke-ok"}],
  "stream": false,
  "options": {"num_predict": 20, "temperature": 0}
}
EOF
)

log "Sending POST $OLLAMA_BASE/api/chat ..."

RESPONSE=$(curl -sf \
  --connect-timeout 10 \
  --max-time 60 \
  -X POST "$OLLAMA_BASE/api/chat" \
  -H "Content-Type: application/json" \
  -d "$REQUEST_BODY" 2>/tmp/ollama-smoke-curl-err.txt) || {
  CURL_ERR=$(cat /tmp/ollama-smoke-curl-err.txt 2>/dev/null || echo "unknown")
  die "curl failed: $CURL_ERR"
}

log "Response received."

# Extract content
if command -v jq &>/dev/null; then
  CONTENT=$(echo "$RESPONSE" | jq -r '.message.content // "null"' 2>/dev/null || echo "parse-error")
elif command -v python3 &>/dev/null; then
  CONTENT=$(python3 -c "
import json, sys
data = json.loads(sys.argv[1])
msg = data.get('message', {})
print(msg.get('content', 'null'))
" "$RESPONSE" 2>/dev/null || echo "parse-error")
else
  CONTENT="[jq/python3 not available — cannot parse response]"
fi

log "Model replied: $CONTENT"

# ---------------------------------------------------------------------------
# Step 4: Report
# ---------------------------------------------------------------------------

if [[ "$CONTENT" == "null" || "$CONTENT" == "parse-error" ]]; then
  write_output "FAIL" "Model returned null or unparseable content.\n\nRaw response:\n\`\`\`json\n$RESPONSE\n\`\`\`"
  die "Model response has no content — check the raw response above"
fi

SUMMARY=$(cat <<EOF
- Model: \`$CHOSEN_MODEL\`
- Endpoint: \`$OLLAMA_BASE/api/chat\`
- Reply: \`$CONTENT\`
- Result: PASS

<details><summary>Raw response</summary>

\`\`\`json
$RESPONSE
\`\`\`
</details>
EOF
)

write_output "PASS" "$SUMMARY"
log "Smoke test PASSED for model $CHOSEN_MODEL"
exit 0

#!/usr/bin/env bash
###CLEO
# command: web
# category: system
# synopsis: Start, stop, or check status of CLEO Web UI server
# relevance: high
# flags: --port,--host,--format
# exits: 0,1
# json-output: true
###END

#####################################################################
# web.sh - Web UI Server Management Command
#
# Manages the CLEO Nexus Web UI server lifecycle:
# - Start the server on a specified port
# - Stop the running server
# - Check server status
# - Open browser to the UI
#
# Usage:
#   cleo web start [--port PORT] [--host HOST]   # Start server
#   cleo web stop                                # Stop server
#   cleo web status                              # Check status
#   cleo web open                                # Open browser
#   cleo web logs                                # Show logs
#
# Options:
#   --port PORT     Server port (default: 3456)
#   --host HOST     Server host (default: 127.0.0.1)
#   --format json   JSON output
#   -h, --help      Show help
#
# The server runs as a background process managed via:
#   PID file: ~/.cleo/web-server.pid
#   Config:   ~/.cleo/web-server.json
#   Logs:     ~/.cleo/logs/web-server.log
#
# Version: 0.1.0
#####################################################################

set -euo pipefail

# Paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"
WEB_SERVER_DIR="${CLEO_HOME}/web-server"
PID_FILE="${CLEO_HOME}/web-server.pid"
CONFIG_FILE="${CLEO_HOME}/web-server.json"
LOG_FILE="${CLEO_HOME}/logs/web-server.log"

# Defaults
DEFAULT_PORT=3456
DEFAULT_HOST="127.0.0.1"

# Source libraries
source "${LIB_DIR}/data/file-ops.sh" 2>/dev/null || true
source "${LIB_DIR}/core/output-format.sh" 2>/dev/null || true
source "${LIB_DIR}/core/exit-codes.sh" 2>/dev/null || true

# Show help
show_help() {
  cat << 'EOF'
CLEO Web UI Server Management

USAGE:
  cleo web <command> [options]

COMMANDS:
  start [--port PORT] [--host HOST]  Start the web server
  stop                               Stop the running server
  status                             Check server status
  open                               Open browser to the UI
  logs                               Show server logs

OPTIONS:
  --port PORT     Server port (default: 3456)
  --host HOST     Server host (default: 127.0.0.1)
  --format json   Output as JSON
  -h, --help      Show this help

EXAMPLES:
  cleo web start                    # Start on default port 3456
  cleo web start --port 8080        # Start on port 8080
  cleo web status                   # Check if running
  cleo web stop                     # Stop the server
  cleo web open                     # Open browser

FILES:
  PID:     ~/.cleo/web-server.pid
  Config:  ~/.cleo/web-server.json
  Logs:    ~/.cleo/logs/web-server.log
EOF
}

# Get server status
get_status() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid=$(cat "$PID_FILE" 2>/dev/null) || pid=""
    
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      # Server is running
      local config='{}'
      if [[ -f "$CONFIG_FILE" ]]; then
        config=$(cat "$CONFIG_FILE")
      fi
      
      local port host
      port=$(echo "$config" | jq -r '.port // "3456"' 2>/dev/null || echo "3456")
      host=$(echo "$config" | jq -r '.host // "127.0.0.1"' 2>/dev/null || echo "127.0.0.1")
      
      echo "{\"running\":true,\"pid\":$pid,\"port\":$port,\"host\":\"$host\",\"url\":\"http://$host:$port\"}"
      return 0
    fi
  fi
  
  echo "{\"running\":false,\"pid\":null,\"port\":null,\"host\":null,\"url\":null}"
  return 0
}

# Start the server
cmd_start() {
  local port="$DEFAULT_PORT"
  local host="$DEFAULT_HOST"
  local format="text"

  # Parse arguments
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --port)
        port="$2"
        shift 2
        ;;
      --host)
        host="$2"
        shift 2
        ;;
      --format)
        format="$2"
        shift 2
        ;;
      *)
        shift
        ;;
    esac
  done

  # Check if already running
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid=$(cat "$PID_FILE" 2>/dev/null) || pid=""
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      if [[ "$format" == "json" ]]; then
        echo "{\"success\":false,\"error\":\"Server already running (PID: $pid)\"}"
      else
        echo "Error: Web server is already running (PID: $pid)" >&2
        echo "Run 'cleo web status' for details" >&2
      fi
      exit 1
    fi
  fi

  # Check if port is available, find next available if not
  if command -v nc >/dev/null 2>&1; then
    local original_port=$port
    while nc -z "$host" "$port" 2>/dev/null; do
      port=$((port + 1))
      if [[ $port -gt 9999 ]]; then
        if [[ "$format" == "json" ]]; then
          echo "{\"success\":false,\"error\":\"No available ports found\"}"
        else
          echo "Error: No available ports found" >&2
        fi
        exit 1
      fi
    done
    if [[ "$port" != "$original_port" && "$format" != "json" ]]; then
      echo "Port $original_port in use, using port $port instead"
    fi
  fi

  # Ensure log directory exists
  mkdir -p "$(dirname "$LOG_FILE")"

  # Save config
  echo "{\"port\":$port,\"host\":\"$host\",\"startedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > "$CONFIG_FILE"

  # Find MCP server
  local MCP_SERVER_DIR=""

  # Check if running in a CLEO project
  if [[ -d ".cleo" ]] && [[ -d "mcp-server" ]]; then
    MCP_SERVER_DIR="$(pwd)/mcp-server"
  elif [[ -n "${CLEO_MCP_SERVER:-}" ]]; then
    MCP_SERVER_DIR="$CLEO_MCP_SERVER"
  elif [[ -d "$HOME/.cleo/mcp-server" ]]; then
    MCP_SERVER_DIR="$HOME/.cleo/mcp-server"
  else
    if [[ "$format" == "json" ]]; then
      echo "{\"success\":false,\"error\":\"MCP server not found. Run from a CLEO project or set CLEO_MCP_SERVER\"}"
    else
      echo "Error: MCP server not found" >&2
      echo "Run from a CLEO project directory or set CLEO_MCP_SERVER environment variable" >&2
    fi
    exit 1
  fi

  # Check if web server is built
  if [[ ! -f "$MCP_SERVER_DIR/dist/web/index.js" ]]; then
    if [[ "$format" != "json" ]]; then
      echo "Building web server..."
    fi
    (cd "$MCP_SERVER_DIR" && npm run build >> "$LOG_FILE" 2>&1) || {
      if [[ "$format" == "json" ]]; then
        echo "{\"success\":false,\"error\":\"Build failed, check logs at $LOG_FILE\"}"
      else
        echo "Error: Build failed. Check logs: $LOG_FILE" >&2
      fi
      exit 1
    }
  fi

  # Start server in background with proper detachment
  cd "$MCP_SERVER_DIR"
  CLEO_WEB_PORT="$port" CLEO_WEB_HOST="$host" \
    nohup node dist/web/index.js >> "$LOG_FILE" 2>&1 &
  local server_pid=$!
  
  # Disown the job so it survives shell exit
  disown "$server_pid" 2>/dev/null || true
  
  # Save PID immediately
  echo "$server_pid" > "$PID_FILE"
  
  # Return to original directory
  cd - > /dev/null 2>&1 || true

  # Show immediate feedback
  if [[ "$format" != "json" ]]; then
    echo "Starting CLEO Nexus Web UI on port $port..."
  fi

  # Wait for server to start
  local attempts=0
  local max_attempts=30

  while [[ $attempts -lt $max_attempts ]]; do
    if curl -s "http://$host:$port/api/health" >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
    ((attempts++))
  done

  if [[ $attempts -eq $max_attempts ]]; then
    kill "$server_pid" 2>/dev/null || true
    rm -f "$PID_FILE"
    if [[ "$format" == "json" ]]; then
      echo "{\"success\":false,\"error\":\"Server failed to start within 15 seconds\"}"
    else
      echo "✗ Error: Server failed to start within 15 seconds" >&2
      echo "  Check logs: $LOG_FILE" >&2
    fi
    exit 1
  fi

  if [[ "$format" == "json" ]]; then
    echo "{\"success\":true,\"pid\":$server_pid,\"port\":$port,\"host\":\"$host\",\"url\":\"http://$host:$port\"}"
  else
    echo "✓ CLEO Nexus Web UI running on port $port"
    echo ""
    echo "  URL:  http://$host:$port"
    echo "  PID:  $server_pid"
    echo ""
    echo "Commands:"
    echo "  cleo web status    # Check status"
    echo "  cleo web open      # Open browser"
    echo "  cleo web stop      # Stop server"
    echo ""
    echo "Opening browser..."
    
    # Auto-open browser
    local url="http://$host:$port"
    if command -v xdg-open >/dev/null 2>&1; then
      xdg-open "$url" >/dev/null 2>&1 &
    elif command -v open >/dev/null 2>&1; then
      open "$url" >/dev/null 2>&1 &
    elif command -v start >/dev/null 2>&1; then
      start "$url" >/dev/null 2>&1 &
    fi
  fi
}

# Stop the server
cmd_stop() {
  local format="${1:-text}"
  
  if [[ ! -f "$PID_FILE" ]]; then
    if [[ "$format" == "json" ]]; then
      echo "{\"success\":false,\"error\":\"Server not running (no PID file)\"}"
    else
      echo "Error: Web server is not running" >&2
    fi
    exit 1
  fi
  
  local pid
  pid=$(cat "$PID_FILE" 2>/dev/null) || pid=""
  
  if [[ -z "$pid" ]]; then
    rm -f "$PID_FILE"
    if [[ "$format" == "json" ]]; then
      echo "{\"success\":false,\"error\":\"PID file empty, cleaning up\"}"
    else
      echo "Error: PID file was empty, cleaned up" >&2
    fi
    exit 1
  fi
  
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$PID_FILE"
    if [[ "$format" == "json" ]]; then
      echo "{\"success\":true,\"message\":\"Server was not running, cleaned up PID file\"}"
    else
      echo "Server was not running (stale PID file removed)"
    fi
    exit 0
  fi
  
  # Try graceful shutdown first
  kill "$pid" 2>/dev/null || true
  
  # Wait for process to exit
  local attempts=0
  while [[ $attempts -lt 10 ]] && kill -0 "$pid" 2>/dev/null; do
    sleep 0.5
    ((attempts++))
  done
  
  # Force kill if still running
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true
  fi
  
  rm -f "$PID_FILE"
  
  if [[ "$format" == "json" ]]; then
    echo "{\"success\":true,\"message\":\"Server stopped\"}"
  else
    echo "✓ CLEO Nexus Web UI stopped"
  fi
}

# Show status
cmd_status() {
  local format="text"

  # Parse arguments
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --format)
        format="$2"
        shift 2
        ;;
      *)
        shift
        ;;
    esac
  done

  local status_json
  status_json=$(get_status)

  if [[ "$format" == "json" ]]; then
    echo "$status_json"
  else
    local running pid port host url
    running=$(echo "$status_json" | jq -r '.running')
    
    if [[ "$running" == "true" ]]; then
      pid=$(echo "$status_json" | jq -r '.pid')
      port=$(echo "$status_json" | jq -r '.port')
      host=$(echo "$status_json" | jq -r '.host')
      url=$(echo "$status_json" | jq -r '.url')
      
      echo "CLEO Web UI is RUNNING"
      echo "  Status:  Active"
      echo "  PID:     $pid"
      echo "  URL:     $url"
      echo "  Host:    $host"
      echo "  Port:    $port"
    else
      echo "CLEO Web UI is STOPPED"
      echo "  Status:  Not running"
      echo ""
      echo "Start with: cleo web start"
    fi
  fi
}

# Open browser
cmd_open() {
  local status_json
  status_json=$(get_status)
  
  local running url
  running=$(echo "$status_json" | jq -r '.running')
  url=$(echo "$status_json" | jq -r '.url')
  
  if [[ "$running" != "true" ]]; then
    echo "Error: Web server is not running" >&2
    echo "Start it with: cleo web start" >&2
    exit 1
  fi
  
  # Try to open browser
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url"
  elif command -v open >/dev/null 2>&1; then
    open "$url"
  elif command -v start >/dev/null 2>&1; then
    start "$url"
  else
    echo "Please open your browser to: $url"
  fi
}

# Show logs
cmd_logs() {
  if [[ -f "$LOG_FILE" ]]; then
    tail -f "$LOG_FILE"
  else
    echo "No log file found at $LOG_FILE"
    exit 1
  fi
}

# Main
main() {
  local command="${1:-}"
  shift 2>/dev/null || true
  
  case "$command" in
    start)
      cmd_start "$@"
      ;;
    stop)
      cmd_stop "$@"
      ;;
    status)
      cmd_status "$@"
      ;;
    open)
      cmd_open "$@"
      ;;
    logs)
      cmd_logs "$@"
      ;;
    -h|--help|help)
      show_help
      exit 0
      ;;
    "")
      echo "Error: No command specified" >&2
      show_help
      exit 1
      ;;
    *)
      echo "Error: Unknown command '$command'" >&2
      show_help
      exit 1
      ;;
  esac
}

main "$@"

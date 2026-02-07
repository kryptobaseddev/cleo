#!/usr/bin/env bash
# CLEO Sandbox Manager - Create and manage testing containers
# Usage: ./sandbox-manager.sh {build|start|stop|destroy|ssh|status|logs|exec}

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CONTAINER_NAME="cleo-sandbox"
IMAGE_NAME="cleo-sandbox:latest"
SSH_PORT="2222"
# Use ~/.cleo/sandbox for SSH keys to avoid filesystem permission issues
SSH_KEY_DIR="${HOME}/.cleo/sandbox/ssh"
SSH_KEY_PATH="${SSH_KEY_DIR}/sandbox_key"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${BLUE}[INFO]${NC} $*"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $*"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $*"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $*"
}

# Generate SSH key pair for sandbox access
generate_ssh_key() {
    mkdir -p "$SSH_KEY_DIR"

    if [[ -f "$SSH_KEY_PATH" ]]; then
        log_info "SSH key already exists at $SSH_KEY_PATH"
        # Verify permissions
        local perms=$(stat -c "%a" "$SSH_KEY_PATH")
        if [[ "$perms" != "600" ]]; then
            log_warning "Fixing SSH key permissions..."
            chmod 600 "$SSH_KEY_PATH"
        fi
        return 0
    fi

    log_info "Generating SSH key pair for sandbox access..."
    ssh-keygen -t ed25519 -f "$SSH_KEY_PATH" -N "" -C "cleo-sandbox-key"
    chmod 600 "$SSH_KEY_PATH"
    chmod 644 "${SSH_KEY_PATH}.pub"
    log_success "SSH key pair generated at $SSH_KEY_PATH"
}

# Build the sandbox container image
build_sandbox() {
    log_info "Building sandbox container image..."

    generate_ssh_key

    podman build \
        -t "$IMAGE_NAME" \
        -f "$SCRIPT_DIR/Containerfile" \
        "$SCRIPT_DIR"

    log_success "Sandbox image built: $IMAGE_NAME"
}

# Start the sandbox container
start_sandbox() {
    # Check if container exists but is stopped
    if podman container exists "$CONTAINER_NAME"; then
        if podman ps -a --filter "name=$CONTAINER_NAME" --format "{{.State}}" | grep -q "running"; then
            log_warning "Sandbox container is already running"
            return 0
        else
            log_info "Starting existing sandbox container..."
            podman start "$CONTAINER_NAME"
            log_success "Sandbox container started"
            return 0
        fi
    fi

    # Check if image exists
    if ! podman image exists "$IMAGE_NAME"; then
        log_info "Sandbox image not found, building..."
        build_sandbox
    fi

    log_info "Creating and starting sandbox container..."

    # Ensure SSH key directory exists
    mkdir -p "$SSH_KEY_DIR"

    # Start container with SSH key mounted
    podman run -d \
        --name "$CONTAINER_NAME" \
        --hostname cleo-sandbox \
        -p "127.0.0.1:${SSH_PORT}:2222" \
        -v "${SSH_KEY_PATH}.pub:/home/testuser/.ssh/authorized_keys:ro,z" \
        "$IMAGE_NAME"

    # Wait for SSH to be ready
    log_info "Waiting for SSH service to be ready..."
    for i in {1..30}; do
        if ssh -o StrictHostKeyChecking=no -o ConnectTimeout=1 -p "$SSH_PORT" -i "$SSH_KEY_PATH" testuser@localhost "exit" 2>/dev/null; then
            break
        fi
        sleep 1
    done

    log_success "Sandbox container started and SSH is ready"
    log_info "Connect with: ./sandbox-manager.sh ssh"
    log_info "Or directly: ssh -p $SSH_PORT -i $SSH_KEY_PATH testuser@localhost"
}

# Stop the sandbox container
stop_sandbox() {
    if ! podman container exists "$CONTAINER_NAME"; then
        log_warning "Sandbox container does not exist"
        return 0
    fi

    if ! podman ps --filter "name=$CONTAINER_NAME" --format "{{.Names}}" | grep -q "$CONTAINER_NAME"; then
        log_warning "Sandbox container is not running"
        return 0
    fi

    log_info "Stopping sandbox container..."
    podman stop "$CONTAINER_NAME"
    log_success "Sandbox container stopped"
}

# Destroy the sandbox container (keeps image)
destroy_sandbox() {
    if ! podman container exists "$CONTAINER_NAME"; then
        log_warning "Sandbox container does not exist"
        return 0
    fi

    log_warning "This will destroy the sandbox container and all data inside it"
    read -p "Are you sure? (y/N) " -n 1 -r
    echo

    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_info "Operation cancelled"
        return 0
    fi

    log_info "Destroying sandbox container..."
    podman rm -f "$CONTAINER_NAME"
    log_success "Sandbox container destroyed"
}

# SSH into the sandbox
ssh_sandbox() {
    if ! podman ps --filter "name=$CONTAINER_NAME" --format "{{.Names}}" | grep -q "$CONTAINER_NAME"; then
        log_error "Sandbox container is not running"
        log_info "Start it with: ./sandbox-manager.sh start"
        exit 1
    fi

    log_info "Connecting to sandbox via SSH..."
    ssh -o StrictHostKeyChecking=no -p "$SSH_PORT" -i "$SSH_KEY_PATH" testuser@localhost
}

# Execute command in sandbox
exec_sandbox() {
    if ! podman ps --filter "name=$CONTAINER_NAME" --format "{{.Names}}" | grep -q "$CONTAINER_NAME"; then
        log_error "Sandbox container is not running"
        exit 1
    fi

    if [[ $# -eq 0 ]]; then
        log_error "No command specified"
        log_info "Usage: ./sandbox-manager.sh exec <command>"
        exit 1
    fi

    ssh -o StrictHostKeyChecking=no -p "$SSH_PORT" -i "$SSH_KEY_PATH" testuser@localhost "$@"
}

# Show sandbox status
status_sandbox() {
    echo "=== CLEO Sandbox Status ==="
    echo

    # Check image
    if podman image exists "$IMAGE_NAME"; then
        echo -e "${GREEN}✓${NC} Image: $IMAGE_NAME exists"
        podman images "$IMAGE_NAME" --format "  Built: {{.CreatedSince}}, Size: {{.Size}}"
    else
        echo -e "${RED}✗${NC} Image: $IMAGE_NAME not found"
    fi

    echo

    # Check container
    if podman container exists "$CONTAINER_NAME"; then
        local state=$(podman ps -a --filter "name=$CONTAINER_NAME" --format "{{.State}}")
        if [[ "$state" == "running" ]]; then
            echo -e "${GREEN}✓${NC} Container: $CONTAINER_NAME is running"
            podman ps --filter "name=$CONTAINER_NAME" --format "  Uptime: {{.Status}}"
            echo "  SSH: ssh -p $SSH_PORT -i $SSH_KEY_PATH testuser@localhost"
        else
            echo -e "${YELLOW}⚠${NC} Container: $CONTAINER_NAME exists but is not running (state: $state)"
        fi
    else
        echo -e "${RED}✗${NC} Container: $CONTAINER_NAME does not exist"
    fi

    echo

    # Check SSH key
    if [[ -f "$SSH_KEY_PATH" ]]; then
        echo -e "${GREEN}✓${NC} SSH Key: $SSH_KEY_PATH exists"
    else
        echo -e "${RED}✗${NC} SSH Key: $SSH_KEY_PATH not found"
    fi
}

# Show container logs
logs_sandbox() {
    if ! podman container exists "$CONTAINER_NAME"; then
        log_error "Sandbox container does not exist"
        exit 1
    fi

    podman logs "$@" "$CONTAINER_NAME"
}

# Show usage
usage() {
    cat <<EOF
CLEO Sandbox Manager - Manage testing containers

Usage: $0 <command> [options]

Commands:
    build       Build the sandbox container image
    start       Start the sandbox container (builds if needed)
    stop        Stop the sandbox container
    destroy     Destroy the sandbox container (keeps image)
    ssh         SSH into the running sandbox
    exec        Execute a command in the sandbox
    status      Show sandbox status
    logs        Show container logs (pass -f to follow)
    help        Show this help message

Examples:
    $0 start                    # Start sandbox
    $0 ssh                      # Connect to sandbox
    $0 exec "ls -la"           # Run command in sandbox
    $0 logs -f                 # Follow container logs
    $0 destroy                 # Clean up sandbox

Environment Variables:
    SSH_PORT    SSH port to use (default: 2222)

EOF
}

# Main command dispatcher
main() {
    if [[ $# -eq 0 ]]; then
        usage
        exit 1
    fi

    local command="$1"
    shift

    case "$command" in
        build)
            build_sandbox
            ;;
        start)
            start_sandbox
            ;;
        stop)
            stop_sandbox
            ;;
        destroy)
            destroy_sandbox
            ;;
        ssh)
            ssh_sandbox
            ;;
        exec)
            exec_sandbox "$@"
            ;;
        status)
            status_sandbox
            ;;
        logs)
            logs_sandbox "$@"
            ;;
        help|--help|-h)
            usage
            ;;
        *)
            log_error "Unknown command: $command"
            usage
            exit 1
            ;;
    esac
}

main "$@"

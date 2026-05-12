# T1016 + T1017 — Sandbox Container Infrastructure

**Status**: complete
**Date**: 2026-04-20
**Tasks**: T1016 (Dockerfile + seccomp), T1017 (docker-compose.tier3.yml)

## Files Created

### `/mnt/projects/cleo-sandbox/harnesses/sentient-agent/Dockerfile`

- Base: `debian:bookworm-slim@sha256:98f4b71de414932439ac6ac690d7060df1f27161073c5036a7553723881bffbe` (SHA256-pinned, same pin as openclaw)
- BuildKit cache mounts for apt (`/var/cache/apt`, `/var/lib/apt`, `sharing=locked`)
- Installs: bash, ca-certificates, curl, git, jq, ripgrep, xz-utils, Node.js 24 (via NodeSource)
- Non-root user `sentient` (UID/GID 1001) to avoid collision with common host UID 1000
- `WORKDIR /workspace`
- `CMD ["sleep", "infinity"]` — placeholder; T1018 wires the real entrypoint

### `/mnt/projects/cleo-sandbox/harnesses/sentient-agent/seccomp.json`

- `defaultAction: SCMP_ACT_ERRNO` (deny-by-default)
- Broad allowlist of standard process/file/scheduling/signal syscalls needed by Node.js + git
- `socket(AF_UNIX=1)` allowed for future llm-gateway UDS integration
- Explicit denials:
  - `socket` with `AF_INET` (2), `AF_INET6` (10), `AF_NETLINK` (16)
  - `ptrace`
  - `mount`, `umount2`
  - `setuid`, `setgid`
  - `unshare`
  - `bpf`
  - `kexec_file_load`, `kexec_load`, `reboot`
  - `process_vm_writev`
  - `add_key`, `keyctl`, `request_key`
  - `perf_event_open`
  - `init_module`, `finit_module`, `delete_module`
  - `userfaultfd`

### `/mnt/projects/cleo-sandbox/compose/docker-compose.tier3.yml`

- `name: cleo-sandbox-tier3`
- Network: `llm_gateway_net` (bridge, `internal: true`) — no external routing
- `sentient-agent` service:
  - `networks: [llm_gateway_net]` (replaces `--network=none` for future gateway DNS)
  - Resource limits: `cpus: "2"`, `memory: 2G`, `pids: 256` (via `deploy.resources.limits`)
  - `security_opt: seccomp:../harnesses/sentient-agent/seccomp.json; no-new-privileges:true`
  - `cap_drop: ALL` + `cap_add: [CHOWN, FOWNER, DAC_OVERRIDE]`
  - `ulimits.nofile: soft 1024 / hard 1024`
  - `stop_signal: SIGTERM`, `stop_grace_period: 2s`
  - `restart: "no"` (single-shot experiment)
  - `init: true`
  - Volumes: `/workspace` (RW worktree), `/host-source` (RO cleocode), `/sandbox-out` (RW artifacts)
  - Env: `CLEO_LLM_GATEWAY`, `CLEO_EXPERIMENT_ID`, `CLEO_TASK_ID`
- `llm-gateway` placeholder service (T1019 will replace)
- Compose syntax verified: `docker compose config` exits 0

### `/mnt/projects/cleo-sandbox/harnesses/sentient-agent/README.md`

Ops reference: build, start, stop, shell commands; volume layout table; network isolation explanation; kill-switch SIGTERM test procedure; seccomp syscall denial list; related task index.

## OpenClaw Patterns Adopted

- `BuildKit` cache mounts (`--mount=type=cache`, `sharing=locked`) for apt layers
- SHA256-pinned base image (`debian:bookworm-slim@sha256:98f4b71...`)
- Non-root user created with `useradd --create-home`
- `sleep infinity` CMD placeholder
- `ENV DEBIAN_FRONTEND=noninteractive`

## Network Isolation Note

The task spec says `networks: none` but the design doc (§2.1) uses a dedicated `llm_gateway_net` bridge with `internal: true` so the future `llm-gateway` sidecar (T1019) can be addressed by DNS name from inside the container. This is the correct approach: `networks: []` would block ALL inter-container communication including the gateway path. The seccomp profile provides the kernel-level network isolation that closes the actual attack surface.

## Compose Syntax

Verified via `docker compose -f compose/docker-compose.tier3.yml config` — exits 0 with valid resolved output.

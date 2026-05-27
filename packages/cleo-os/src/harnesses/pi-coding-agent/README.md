# cleo-os Pi Coding Agent Harness Adapter

TypeScript harness adapter for `@mariozechner/pi-coding-agent` inside the
cleo-os package. Wraps the Pi CLI with a structured lifecycle surface (spawn,
status, kill, output) and optional Docker sandbox isolation.

## Overview

This adapter sits at `packages/cleo-os/src/harnesses/pi-coding-agent/` and
implements the local `HarnessAdapter` interface defined in `types.ts`. It is
the cleo-os counterpart to the CAAMP `PiSpawnProvider` in
`packages/adapters/src/providers/pi/spawn.ts`:

| Feature | PiSpawnProvider (CAAMP) | PiCodingAgentAdapter (cleo-os) |
|---|---|---|
| Spawn mode | Detached, fire-and-forget | Attached, full lifecycle |
| Output capture | None | Bounded ring buffer (500 lines) |
| Exit tracking | PID liveness poll | exitPromise |
| Sandbox support | No | Yes (Docker, opt-in) |
| Location | packages/adapters/ | packages/cleo-os/ |

## Usage

```typescript
import { PiCodingAgentAdapter } from './harnesses/pi-coding-agent/index.js';

const adapter = new PiCodingAgentAdapter();

// Spawn Pi with a task prompt (host-native mode)
const { instanceId, exitPromise } = await adapter.spawn(
  'T123',
  'Initialize a CLEO project, add a task, and mark it complete.',
  { cwd: '/my/project' },
);

// Stream recent output
const lines = adapter.output(instanceId);

// Kill if needed
await adapter.kill(instanceId);

// Await exit
const status = await exitPromise;
console.log('exit code:', status.exitCode);
```

## Environment Variables

### Core

| Variable | Default | Description |
|---|---|---|
| `CLEO_PI_BINARY` | `pi` | Path to the `pi` binary. Use when `pi` is not on PATH. |
| `CLEO_TERMINATE_GRACE_MS` | `5000` | SIGTERM → SIGKILL grace window in milliseconds. |
| `CLEO_HARNESS_OUTPUT_BUFFER` | `500` | Max output lines retained per process. |

### Docker Sandbox Mode

| Variable | Default | Description |
|---|---|---|
| `CLEO_PI_SANDBOXED` | unset | Set to `1` to enable Docker sandbox mode globally. |
| `CLEO_PI_SANDBOX_IMAGE` | `cleo-sandbox/pi:local` | Docker image for sandbox containers. |
| `CLEO_PI_SANDBOX_NETWORK` | unset | Docker network to join (e.g. `cleo-sandbox_sandbox_net`). |
| `CLEO_PI_SANDBOX_WORKDIR` | `/sandbox` | Working directory inside the container. |
| `CLEO_PI_SANDBOX_SOURCE` | unset | Host path bind-mounted read-only at `/sandbox-src`. |
| `CLEO_PI_SANDBOX_ARTIFACTS` | (uses `cwd`) | Host path bind-mounted read-write at container workdir. |

### Pi Runtime (forwarded from host when set)

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key for the `anthropic` provider. |
| `OPENAI_API_KEY` | OpenAI API key. |
| `GOOGLE_API_KEY` | Google Gemini API key. |
| `OPENROUTER_API_KEY` | OpenRouter API key. |
| `PI_CODING_AGENT_DIR` | Pi sessions/config directory override (default: `~/.pi/agent`). |

## Sandboxed vs Host Mode

### Host-native (default)

Pi runs directly on the host machine. The `pi` binary must be installed
globally (`npm install -g @mariozechner/pi-coding-agent`) or reachable via
`CLEO_PI_BINARY`.

```bash
# Run normally
const adapter = new PiCodingAgentAdapter();
await adapter.spawn('T123', prompt, { cwd: '/project' });
```

### Docker sandbox (opt-in)

Set `CLEO_PI_SANDBOXED=1` or pass `sandboxed: true` to `spawn()`. The adapter
launches Pi inside the `cleo-sandbox/pi:local` Docker container.

```bash
# Build the sandbox image first (one-time setup)
cd /mnt/projects/cleo-sandbox
docker build -f harnesses/pi/Dockerfile -t cleo-sandbox/pi:local .
```

```typescript
// Per-call sandbox override
await adapter.spawn('T123', prompt, { sandboxed: true, cwd: '/artifacts' });

// Global sandbox enable via env
// CLEO_PI_SANDBOXED=1 node my-script.js
```

When Docker is unavailable or the image is not present, the adapter falls back
to host-native mode with a warning logged to stderr.

## Registry

The adapter is registered in
`packages/cleo-os/src/harnesses/index.ts`:

```typescript
import { createHarness, listHarnesses } from './harnesses/index.js';

const adapter = createHarness('pi-coding-agent');
const all = listHarnesses(); // [{ id: 'pi-coding-agent', name: 'Pi Coding Agent', ... }]
```

## File layout

```
src/harnesses/
  index.ts                          # Harness registry
  pi-coding-agent/
    adapter.ts                      # PiCodingAgentAdapter (HarnessAdapter impl)
    docker-mode.ts                  # DockerModeAdapter + docker run arg builder
    pi-wrapper.ts                   # PiWrapper + process tracking helpers
    types.ts                        # HarnessAdapter interface + shared types
    index.ts                        # Barrel export
    README.md                       # This file
```

## Patterns adopted from OpenClaw

The implementation adopts the following patterns from
`/mnt/projects/openclaw/`:

- **Extension injection via `--extension <path>`**: CleoOS extensions
  (CANT bridge, hooks bridge, etc.) are prepended to the Pi argument list
  so they load even in non-interactive runs. Mirrors `collectExtensionPaths()`
  in `cli.ts`.
- **Dockerfile.sandbox-common pattern**: The Docker mode uses the same
  two-layer image structure (base image + agent layer) and applies the same
  apt-get cache mounts, Brew/pnpm install steps, and non-root final user
  (`cleo`/`sandbox`).
- **`--rm` + `/tmp` prompt file**: Containers are ephemeral; prompts land in
  `/tmp/` with unique suffixes and are cleaned up on exit.
- **Bind-mount separation**: source code read-only (`/sandbox-src:ro`),
  output artifacts read-write (`/sandbox`).
- **API keys via `-e`**: Never baked into the image; always forwarded from
  the host environment at `docker run` time.

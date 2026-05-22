/**
 * CLI agent command group — agent credential management (unified registry).
 *
 * Provides:
 *   cleo agent register   — register a new agent credential
 *   cleo agent list       — list all registered agent credentials
 *   cleo agent get <id>   — get a specific agent credential
 *   cleo agent remove <id> — remove an agent credential
 *   cleo agent rotate-key <id> — rotate an agent's API key
 *   cleo agent poll       — one-shot message check
 *   cleo agent send       — send a message to an agent or conversation
 *   cleo agent start      — start the daemon poller for an agent
 *   cleo agent install    — install an agent from .cantz archive or directory
 *   cleo agent pack       — package an agent directory as .cantz archive
 *   cleo agent create     — scaffold a new agent package with persona.cant and manifest.json
 *
 * **Daemon vs. Pi session — important distinction.** The daemon spawned
 * by `cleo agent start` ONLY polls SignalDock for inbound messages and
 * keeps the cloud status indicator green. It does NOT execute CANT
 * workflow profiles inside the daemon process. CANT workflow execution
 * (sessions, parallel arms, conditionals, approval gates, discretion
 * evaluation, etc.) lives entirely inside the
 * `cant-bridge.ts` Pi extension at
 * `packages/cleo/templates/cleoos-hub/pi-extensions/cant-bridge.ts`,
 * which interprets `.cant` files via shell-out to the `cleo cant`
 * command family. Operators who want profile-driven behaviour should
 * start a Pi session and use `/cant:load <file>` followed by
 * `/cant:run <file> <workflowName>`. The daemon and the Pi session are
 * distinct runtimes with distinct purposes, by design (see ADR-035 §D5
 * "Option Y" addendum).
 *
 * @see docs/specs/SIGNALDOCK-UNIFIED-AGENT-REGISTRY.md Section 3.4
 * @see .cleo/adrs/ADR-035-pi-v2-v3-harness.md §D5 + Addendum
 * @task T178
 */

import type { AgentDoctorFinding } from '@cleocode/contracts';
import { getProjectRoot } from '@cleocode/core';
import {
  checkAgentHealth,
  detectCrashedAgents,
  detectStaleAgents,
  getHealthReport,
  STALE_THRESHOLD_MS,
} from '@cleocode/core/agents';
import {
  cleanupInstallTempDir,
  resolveAgentCantPath,
} from '@cleocode/core/agents/install-pipeline.js';
import {
  inferTierFromRole,
  scaffoldAgent,
  validateName,
  validateRole,
  validateTier,
} from '@cleocode/core/agents/scaffold.js';
import { startWorkLoop } from '@cleocode/core/agents/work-loop.js';
import { defineCommand, showUsage } from 'citty';
import { AGENTS_SUBDIR, CANT_AGENTS_SUBDIR, CLEO_DIR_NAME } from '../paths.js';
import { cliError, cliOutput, humanLine, humanWarn } from '../renderers/index.js';
import { computeProfileStatus, type ProfileValidation } from './agent-profile-status.js';

/** cleo agent register — register a new agent credential in the local registry */
const registerCommand = defineCommand({
  meta: {
    name: 'register',
    description: 'Register a new agent credential in the local registry',
  },
  args: {
    id: {
      type: 'string',
      description: 'Unique agent identifier',
      required: true,
    },
    name: {
      type: 'string',
      description: 'Human-readable display name',
      required: true,
    },
    'api-key': {
      type: 'string',
      description: 'API key (sk_live_...)',
      required: true,
    },
    'api-url': {
      type: 'string',
      description: 'API base URL',
      default: 'https://api.signaldock.io',
    },
    classification: {
      type: 'string',
      description: 'Agent classification (e.g. code_dev, orchestrator)',
    },
    privacy: {
      type: 'string',
      description: 'Privacy tier: public, discoverable, private',
      default: 'public',
    },
  },
  async run({ args }) {
    try {
      const { AgentRegistryAccessor } = await import('@cleocode/core/agents');
      const { getDb } = await import('@cleocode/core/internal'); // core-first-allowed: infrastructure — TODO T9621 promote getDb
      await getDb();
      const registry = new AgentRegistryAccessor(getProjectRoot());

      const agentId = args.id;
      const displayName = args.name;
      const classification = args.classification as string | undefined;

      const credential = await registry.register({
        agentId,
        displayName,
        apiKey: args['api-key'],
        apiBaseUrl: args['api-url'] ?? 'https://api.signaldock.io',
        classification,
        privacyTier: (args.privacy as 'public' | 'discoverable' | 'private') ?? 'public',
        capabilities: [],
        skills: [],
        transportType: 'http',
        transportConfig: {},
        isActive: true,
      });

      // Scaffold .cant persona file if it doesn't exist
      const { existsSync, mkdirSync, writeFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const cantDir = join(CLEO_DIR_NAME, AGENTS_SUBDIR);
      const cantPath = join(cantDir, `${agentId}.cant`);
      let cantScaffolded = false;

      if (!existsSync(cantPath)) {
        mkdirSync(cantDir, { recursive: true });
        const role = classification ?? 'specialist';
        const cantContent = `---
kind: agent
version: 2
---

agent ${agentId}:
  house: none
  allegiance: canon
  role: ${role}
  parent: project-orchestrator
  description: "${displayName}"

  tone:
    |
    TODO: Describe how this agent communicates.

  prompt:
    |
    TODO: Write the core behavioral instruction.

  skills: [ct-cleo]

  permissions:
    tasks: read
    session: read
    memory: read

  transport:
    primary: local
    fallback: sse
    cloud: http
    apiBaseUrl: https://api.signaldock.io

  lifecycle:
    start: cleo agent start ${agentId}
    stop: cleo agent stop ${agentId}
    status: cleo agent status ${agentId}

  context:
    active-tasks
    memory-bridge

  on SessionStart:
    /checkin @all #online

  enforcement:
    1: TODO — what does this agent push back on?
`;
        writeFileSync(cantPath, cantContent, 'utf-8');
        cantScaffolded = true;
      }

      cliOutput(
        {
          success: true,
          data: {
            agentId: credential.agentId,
            displayName: credential.displayName,
            cantFile: cantScaffolded ? cantPath : existsSync(cantPath) ? cantPath : null,
            cantScaffolded,
          },
        },
        { command: 'agent register' },
      );
    } catch (err) {
      cliOutput(
        { success: false, error: { code: 'E_REGISTER', message: String(err) } },
        { command: 'agent register' },
      );
      process.exitCode = 1;
    }
  },
});

/** cleo agent signin <agentId> — sign in as an agent */
const signinCommand = defineCommand({
  meta: {
    name: 'signin',
    description: 'Sign in as an agent — marks active, caches credentials for session',
  },
  args: {
    agentId: {
      type: 'positional',
      description: 'Agent ID to sign in as',
      required: true,
    },
    'api-url': {
      type: 'string',
      description: 'Override API base URL for cloud status update',
    },
  },
  async run({ args }) {
    try {
      const { AgentRegistryAccessor } = await import('@cleocode/core/agents');
      const { getDb } = await import('@cleocode/core/internal'); // core-first-allowed: infrastructure — TODO T9621 promote getDb
      await getDb();
      const registry = new AgentRegistryAccessor(getProjectRoot());

      // Look up the credential
      const credential = await registry.get(args.agentId);
      if (!credential) {
        cliOutput(
          {
            success: false,
            error: {
              code: 'E_NOT_FOUND',
              message: `Agent '${args.agentId}' not registered. Run: cleo agent register --id ${args.agentId} --name "..." --api-key sk_live_...`,
            },
          },
          { command: 'agent signin' },
        );
        process.exitCode = 1;
        return;
      }

      // Mark as active + update lastUsedAt
      await registry.update(args.agentId, { isActive: true });
      await registry.markUsed(args.agentId);

      // Attempt to set online status on cloud (best-effort, don't fail if offline)
      const apiUrl = args['api-url'] ?? credential.apiBaseUrl;
      try {
        await fetch(`${apiUrl}/agents/${args.agentId}/status`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${credential.apiKey}`,
            'X-Agent-Id': args.agentId,
          },
          body: JSON.stringify({ status: 'online' }),
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        // Offline is fine — LocalTransport works without cloud
      }

      cliOutput(
        {
          success: true,
          data: {
            agentId: credential.agentId,
            displayName: credential.displayName,
            apiBaseUrl: apiUrl,
            status: 'online',
            transport: 'local',
          },
        },
        { command: 'agent signin' },
      );
    } catch (err) {
      cliOutput(
        { success: false, error: { code: 'E_SIGNIN', message: String(err) } },
        { command: 'agent signin' },
      );
      process.exitCode = 1;
    }
  },
});

/**
 * cleo agent start <agentId> — start the SignalDock-poller daemon.
 *
 * Profile handling:
 *   The `--cant <file>` option (or the default
 *   `.cleo/agents/<agentId>.cant` lookup) is read for two reasons:
 *
 *   1. **Fail-fast validation**: if the file exists and the optional
 *      `@cleocode/cant` validator is available in this build, the
 *      file is parsed so malformed profiles surface as a status
 *      string rather than blowing up later.
 *   2. **Status surface**: the resulting status (`validated`,
 *      `invalid (N errors)`, `loaded (unvalidated)`, or `none`) is
 *      reported in the LAFS envelope so operators know the daemon
 *      saw the file they expected.
 *
 *   The profile string is then DROPPED. The daemon does NOT execute
 *   workflow profiles. Profile-driven behaviour runs inside Pi sessions
 *   through the `cant-bridge.ts` Pi extension.
 *   See ADR-035 §D5 (Option Y addendum) for the architectural rationale.
 */
const startCommand = defineCommand({
  meta: {
    name: 'start',
    description:
      'Start an agent daemon — polls SignalDock for messages. Profile is validated for fail-fast feedback only; CANT execution lives in Pi via cant-bridge.ts.',
  },
  args: {
    agentId: {
      type: 'positional',
      description: 'Agent ID to start',
      required: true,
    },
    cant: {
      type: 'string',
      description: 'Path to .cant persona file (validated only, NOT executed by the daemon)',
    },
    'poll-interval': {
      type: 'string',
      description: 'Poll interval in milliseconds',
      default: '5000',
    },
    heartbeat: {
      type: 'boolean',
      description: 'Enable heartbeat service (default: true)',
      default: true,
    },
  },
  async run({ args }) {
    try {
      const { AgentRegistryAccessor } = await import('@cleocode/core/agents');
      const { getDb } = await import('@cleocode/core/internal'); // core-first-allowed: infrastructure — TODO T9621 promote getDb
      const { createRuntime } = await import('@cleocode/runtime');
      const { existsSync, readFileSync } = await import('node:fs');
      const { join } = await import('node:path');

      await getDb();
      const registry = new AgentRegistryAccessor(getProjectRoot());

      // 1. Look up credential
      const credential = await registry.get(args.agentId);
      if (!credential) {
        cliOutput(
          {
            success: false,
            error: {
              code: 'E_NOT_FOUND',
              message: `Agent '${args.agentId}' not registered. Run: cleo agent register --id ${args.agentId} --name "..." --api-key sk_live_...`,
            },
          },
          { command: 'agent start' },
        );
        process.exitCode = 1;
        return;
      }

      // 2. Read and (best-effort) validate the .cant profile.
      //    This is FAIL-FAST GUARDING ONLY. The profile string is
      //    used to compute a status field below, then dropped. The
      //    daemon does not interpret the workflow body.
      let profile: string | null = null;
      let cantValidation: ProfileValidation | null = null;
      const cantPath = args.cant ?? join(CLEO_DIR_NAME, AGENTS_SUBDIR, `${args.agentId}.cant`);
      if (existsSync(cantPath)) {
        profile = readFileSync(cantPath, 'utf-8');
        try {
          const cantModule = await import('@cleocode/cant');
          // validate() may not be available in all builds of @cleocode/cant
          const validate =
            'validate' in cantModule
              ? (
                  cantModule as {
                    validate: (input: string) => {
                      valid: boolean;
                      diagnostics?: Array<{ message: string }>;
                    };
                  }
                ).validate
              : null;
          if (validate) {
            const result = validate(profile);
            cantValidation = {
              valid: result.valid,
              errors: result.diagnostics?.map((d) => d.message) ?? [],
            };
          }
        } catch {
          // cant-napi not available — profile loaded but unvalidated
          cantValidation = null;
        }
      }

      // 3. Mark active + update lastUsedAt
      await registry.update(args.agentId, { isActive: true });
      await registry.markUsed(args.agentId);

      // 4. Set cloud status (best-effort)
      try {
        await fetch(`${credential.apiBaseUrl}/agents/${args.agentId}/status`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${credential.apiKey}`,
            'X-Agent-Id': args.agentId,
          },
          body: JSON.stringify({ status: 'online' }),
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        // Offline is fine — LocalTransport works without cloud
      }

      // 5. Start runtime services (transport auto-resolved: Local > SSE > HTTP).
      //    Note: createRuntime() does NOT receive the profile. The
      //    daemon's job is purely SignalDock polling + cloud status.
      const pollInterval = Number.parseInt(args['poll-interval'], 10);
      const runtime = await createRuntime(registry, {
        agentId: args.agentId,
        pollIntervalMs: pollInterval,
        heartbeatIntervalMs: args.heartbeat === false ? 0 : 30000,
        groupConversationIds: [],
      });

      runtime.poller.start();

      cliOutput(
        {
          success: true,
          data: {
            agentId: args.agentId,
            displayName: credential.displayName,
            status: 'online',
            transport: runtime.transport.name,
            // Surfaced for operator visibility only — see
            // computeProfileStatus tsdoc for the four possible values.
            profile: computeProfileStatus(profile, cantValidation),
            services: {
              poller: 'running',
              heartbeat: runtime.heartbeat ? 'running' : 'disabled',
              keyRotation: runtime.keyRotation ? 'running' : 'disabled',
            },
          },
        },
        { command: 'agent start' },
      );

      // 6. Keep process alive until shutdown signal (cross-platform)
      const shutdown = () => {
        runtime.stop();
        void registry.update(args.agentId, { isActive: false }).catch(() => {});
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      // Windows: listen for 'message' from parent process managers (PM2, etc.)
      if (process.platform === 'win32') {
        process.on('message', (msg) => {
          if (msg === 'shutdown') shutdown();
        });
      }

      // Keep alive
      await new Promise(() => {});
    } catch (err) {
      cliOutput(
        { success: false, error: { code: 'E_START', message: String(err) } },
        { command: 'agent start' },
      );
      process.exitCode = 1;
    }
  },
});

/** cleo agent stop <agentId> — stop an agent and mark it offline */
const stopCommand = defineCommand({
  meta: {
    name: 'stop',
    description: 'Stop an agent — mark offline and deactivate',
  },
  args: {
    agentId: {
      type: 'positional',
      description: 'Agent ID to stop',
      required: true,
    },
  },
  async run({ args }) {
    try {
      const { AgentRegistryAccessor } = await import('@cleocode/core/agents');
      const { getDb } = await import('@cleocode/core/internal'); // core-first-allowed: infrastructure — TODO T9621 promote getDb
      await getDb();
      const registry = new AgentRegistryAccessor(getProjectRoot());

      const credential = await registry.get(args.agentId);
      if (!credential) {
        cliOutput(
          {
            success: false,
            error: { code: 'E_NOT_FOUND', message: `Agent '${args.agentId}' not registered.` },
          },
          { command: 'agent stop' },
        );
        process.exitCode = 1;
        return;
      }

      // Mark inactive
      await registry.update(args.agentId, { isActive: false });

      // Set cloud status offline (best-effort)
      try {
        await fetch(`${credential.apiBaseUrl}/agents/${args.agentId}/status`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${credential.apiKey}`,
            'X-Agent-Id': args.agentId,
          },
          body: JSON.stringify({ status: 'offline' }),
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        // Offline is fine
      }

      cliOutput(
        { success: true, data: { agentId: args.agentId, status: 'offline' } },
        { command: 'agent stop' },
      );
    } catch (err) {
      cliOutput(
        { success: false, error: { code: 'E_STOP', message: String(err) } },
        { command: 'agent stop' },
      );
      process.exitCode = 1;
    }
  },
});

/** cleo agent status [agentId] — show agent status for all or a specific agent */
const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description: 'Show agent status — all agents or specific agent',
  },
  args: {
    agentId: {
      type: 'positional',
      description: 'Agent ID to check (optional — omit for all)',
      required: false,
    },
  },
  async run({ args }) {
    try {
      const { AgentRegistryAccessor } = await import('@cleocode/core/agents');
      const { getDb } = await import('@cleocode/core/internal'); // core-first-allowed: infrastructure — TODO T9621 promote getDb
      await getDb();
      const registry = new AgentRegistryAccessor(getProjectRoot());

      if (args.agentId) {
        const credential = await registry.get(args.agentId);
        if (!credential) {
          cliOutput(
            {
              success: false,
              error: { code: 'E_NOT_FOUND', message: `Agent '${args.agentId}' not registered.` },
            },
            { command: 'agent status' },
          );
          process.exitCode = 1;
          return;
        }
        cliOutput(
          {
            success: true,
            data: {
              agentId: credential.agentId,
              displayName: credential.displayName,
              active: credential.isActive,
              lastUsedAt: credential.lastUsedAt,
              transport: credential.transportType,
            },
          },
          { command: 'agent status' },
        );
      } else {
        const agents = await registry.list();
        cliOutput(
          {
            success: true,
            data: {
              agents: agents.map((a) => ({
                agentId: a.agentId,
                displayName: a.displayName,
                active: a.isActive,
                lastUsedAt: a.lastUsedAt,
              })),
              total: agents.length,
            },
          },
          { command: 'agent status' },
        );
      }
    } catch (err) {
      cliOutput(
        { success: false, error: { code: 'E_STATUS', message: String(err) } },
        { command: 'agent status' },
      );
      process.exitCode = 1;
    }
  },
});

/** cleo agent assign <agentId> <taskId> — assign a task to an agent via messaging */
const assignCommand = defineCommand({
  meta: {
    name: 'assign',
    description: 'Assign a task to an agent via messaging',
  },
  args: {
    agentId: {
      type: 'positional',
      description: 'Target agent ID',
      required: true,
    },
    taskId: {
      type: 'positional',
      description: 'Task ID to assign',
      required: true,
    },
  },
  async run({ args }) {
    try {
      const { AgentRegistryAccessor, createConduit } = await import('@cleocode/core/agents');
      const { getDb } = await import('@cleocode/core/internal'); // core-first-allowed: infrastructure — TODO T9621 promote getDb
      await getDb();
      const registry = new AgentRegistryAccessor(getProjectRoot());

      const active = await registry.getActive();
      if (!active) {
        cliOutput(
          {
            success: false,
            error: {
              code: 'E_NO_ACTIVE',
              message: 'No active agent. Run: cleo agent signin <id>',
            },
          },
          { command: 'agent assign' },
        );
        process.exitCode = 1;
        return;
      }

      const conduit = await createConduit(registry);
      await conduit.send(
        args.agentId,
        `/action @${args.agentId} #task-assignment\n\nAssigned task ${args.taskId}. Run: cleo show ${args.taskId} && cleo start ${args.taskId}`,
      );
      await conduit.disconnect();

      cliOutput(
        {
          success: true,
          data: { agentId: args.agentId, taskId: args.taskId, assignedBy: active.agentId },
        },
        { command: 'agent assign' },
      );
    } catch (err) {
      cliOutput(
        { success: false, error: { code: 'E_ASSIGN', message: String(err) } },
        { command: 'agent assign' },
      );
      process.exitCode = 1;
    }
  },
});

/** cleo agent wake <agentId> — wake an idle agent by sending a prod message */
const wakeCommand = defineCommand({
  meta: {
    name: 'wake',
    description: 'Wake an idle agent — send a prod message',
  },
  args: {
    agentId: {
      type: 'positional',
      description: 'Agent ID to wake',
      required: true,
    },
  },
  async run({ args }) {
    try {
      const { AgentRegistryAccessor, createConduit } = await import('@cleocode/core/agents');
      const { getDb } = await import('@cleocode/core/internal'); // core-first-allowed: infrastructure — TODO T9621 promote getDb
      await getDb();
      const registry = new AgentRegistryAccessor(getProjectRoot());

      const active = await registry.getActive();
      if (!active) {
        cliOutput(
          {
            success: false,
            error: {
              code: 'E_NO_ACTIVE',
              message: 'No active agent. Run: cleo agent signin <id>',
            },
          },
          { command: 'agent wake' },
        );
        process.exitCode = 1;
        return;
      }

      const conduit = await createConduit(registry);
      await conduit.send(
        args.agentId,
        `/action @${args.agentId} #wake #prod\n\nYou are idle. Check your queue: cleo current || cleo next. Report status immediately.`,
      );
      await conduit.disconnect();

      cliOutput(
        { success: true, data: { agentId: args.agentId, prodBy: active.agentId } },
        { command: 'agent wake' },
      );
    } catch (err) {
      cliOutput(
        { success: false, error: { code: 'E_WAKE', message: String(err) } },
        { command: 'agent wake' },
      );
      process.exitCode = 1;
    }
  },
});

/** cleo agent spawn — spawn a new ephemeral agent for a specific task */
const spawnCommand = defineCommand({
  meta: {
    name: 'spawn',
    description: 'Spawn a new ephemeral agent for a specific task',
  },
  args: {
    role: {
      type: 'string',
      description: 'Agent role (e.g. code_dev, research, security)',
      required: true,
    },
    task: {
      type: 'string',
      description: 'Task to assign to the spawned agent',
    },
    model: {
      type: 'string',
      description: 'Model to use (e.g. opus, sonnet)',
    },
    name: {
      type: 'string',
      description: 'Display name for the agent',
    },
  },
  async run({ args }) {
    try {
      const { AgentRegistryAccessor } = await import('@cleocode/core/agents');
      const { getDb } = await import('@cleocode/core/internal'); // core-first-allowed: infrastructure — TODO T9621 promote getDb
      await getDb();
      const registry = new AgentRegistryAccessor(getProjectRoot());

      const role = args.role;
      const taskId = args.task as string | undefined;
      const model = args.model ?? 'sonnet';
      const displayName = args.name ?? `ephemeral-${role}-${Date.now().toString(36)}`;
      const agentId = displayName;

      // Register the ephemeral agent locally (no cloud registration)
      await registry.register({
        agentId,
        displayName,
        apiKey: 'ephemeral-local-only',
        apiBaseUrl: 'local',
        classification: role,
        privacyTier: 'private',
        capabilities: ['chat', 'tools'],
        skills: [role],
        transportType: 'http',
        transportConfig: {},
        isActive: true,
      });

      cliOutput(
        {
          success: true,
          data: {
            agentId,
            displayName,
            role,
            model,
            taskId: taskId ?? null,
            transport: 'local',
            lifecycle: 'ephemeral',
          },
        },
        { command: 'agent spawn' },
      );
    } catch (err) {
      cliOutput(
        { success: false, error: { code: 'E_SPAWN', message: String(err) } },
        { command: 'agent spawn' },
      );
      process.exitCode = 1;
    }
  },
});

/** cleo agent reassign <taskId> <agentId> — reassign a task to another agent via conduit */
const reassignCommand = defineCommand({
  meta: {
    name: 'reassign',
    description: 'Reassign a task to another agent via conduit message',
  },
  args: {
    taskId: {
      type: 'positional',
      description: 'Task ID to reassign',
      required: true,
    },
    agentId: {
      type: 'positional',
      description: 'Target agent ID',
      required: true,
    },
  },
  async run({ args }) {
    try {
      const { AgentRegistryAccessor, createConduit } = await import('@cleocode/core/agents');
      const { getDb } = await import('@cleocode/core/internal'); // core-first-allowed: infrastructure — TODO T9621 promote getDb
      await getDb();
      const registry = new AgentRegistryAccessor(getProjectRoot());
      const active = await registry.getActive();
      if (!active) {
        cliOutput(
          { success: false, error: { code: 'E_NO_ACTIVE', message: 'No active agent.' } },
          { command: 'agent reassign' },
        );
        process.exitCode = 1;
        return;
      }
      const conduit = await createConduit(registry);
      await conduit.send(
        args.agentId,
        `/action @${args.agentId} #task-reassignment\n\nTask ${args.taskId} reassigned to you by ${active.agentId}. Run: cleo show ${args.taskId} && cleo start ${args.taskId}`,
      );
      await conduit.disconnect();
      cliOutput(
        {
          success: true,
          data: { taskId: args.taskId, newOwner: args.agentId, reassignedBy: active.agentId },
        },
        { command: 'agent reassign' },
      );
    } catch (err) {
      cliOutput(
        { success: false, error: { code: 'E_REASSIGN', message: String(err) } },
        { command: 'agent reassign' },
      );
      process.exitCode = 1;
    }
  },
});

/** cleo agent stop-all — stop all active agents and mark them offline */
const stopAllCommand = defineCommand({
  meta: {
    name: 'stop-all',
    description: 'Stop all active agents — mark all offline',
  },
  async run() {
    try {
      const { AgentRegistryAccessor } = await import('@cleocode/core/agents');
      const { getDb } = await import('@cleocode/core/internal'); // core-first-allowed: infrastructure — TODO T9621 promote getDb
      await getDb();
      const registry = new AgentRegistryAccessor(getProjectRoot());
      const agents = await registry.list({ active: true });
      let stopped = 0;
      for (const a of agents) {
        await registry.update(a.agentId, { isActive: false });
        try {
          await fetch(`${a.apiBaseUrl}/agents/${a.agentId}/status`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${a.apiKey}`,
              'X-Agent-Id': a.agentId,
            },
            body: JSON.stringify({ status: 'offline' }),
            signal: AbortSignal.timeout(3000),
          });
        } catch {
          /* best-effort */
        }
        stopped++;
      }
      cliOutput(
        { success: true, data: { stopped, total: agents.length } },
        { command: 'agent stop-all' },
      );
    } catch (err) {
      cliOutput(
        { success: false, error: { code: 'E_STOP_ALL', message: String(err) } },
        { command: 'agent stop-all' },
      );
      process.exitCode = 1;
    }
  },
});

/**
 * cleo agent work <agentId> — enter autonomous work loop.
 *
 * Phase 3: --execute enables the Conductor Loop, which autonomously
 * dispatches ready tasks via orchestrate.spawn.execute.
 */
const workCommand = defineCommand({
  meta: {
    name: 'work',
    description:
      'Enter autonomous work loop — poll tasks, report, optionally execute. --execute enables the Conductor Loop.',
  },
  args: {
    agentId: {
      type: 'positional',
      description: 'Agent ID to run the work loop as',
      required: true,
    },
    'poll-interval': {
      type: 'string',
      description: 'Task check interval in milliseconds',
      default: '30000',
    },
    execute: {
      type: 'boolean',
      description:
        'Autonomously execute ready tasks via orchestrate.spawn.execute (Phase 3 Conductor Loop)',
    },
    adapter: {
      type: 'string',
      description: 'Adapter id to route spawns through (default: auto-detect from capabilities)',
    },
    epic: {
      type: 'string',
      description: 'Restrict autonomous execution to a specific epic (default: any ready task)',
    },
  },
  async run({ args }) {
    try {
      const { AgentRegistryAccessor } = await import('@cleocode/core/agents');
      const { getDb } = await import('@cleocode/core/internal'); // core-first-allowed: infrastructure — TODO T9621 promote getDb
      const { createRuntime } = await import('@cleocode/runtime');
      const { existsSync } = await import('node:fs');
      const { join } = await import('node:path');
      await getDb();
      const registry = new AgentRegistryAccessor(getProjectRoot());
      const credential = await registry.get(args.agentId);
      if (!credential) {
        cliOutput(
          {
            success: false,
            error: { code: 'E_NOT_FOUND', message: `Agent '${args.agentId}' not registered.` },
          },
          { command: 'agent work' },
        );
        process.exitCode = 1;
        return;
      }
      await registry.update(args.agentId, { isActive: true });
      await registry.markUsed(args.agentId);
      const cantPath = join(CLEO_DIR_NAME, AGENTS_SUBDIR, `${args.agentId}.cant`);
      const hasProfile = existsSync(cantPath);
      const runtime = await createRuntime(registry, {
        agentId: args.agentId,
        pollIntervalMs: 5000,
        heartbeatIntervalMs: 30000,
      });
      runtime.poller.start();
      const executeMode = args.execute === true;
      const epicRestrict = args.epic as string | undefined;
      const adapterRestrict = args.adapter as string | undefined;
      cliOutput(
        {
          success: true,
          data: {
            agentId: args.agentId,
            mode: executeMode ? 'conductor-loop' : 'watch-only',
            profile: hasProfile ? 'loaded' : 'none',
            status: 'running',
            epic: epicRestrict ?? 'any',
            adapter: adapterRestrict ?? 'auto',
          },
        },
        { command: 'agent work' },
      );

      const taskInterval = Number.parseInt(args['poll-interval'], 10);
      const loop = startWorkLoop(
        {
          agentId: args.agentId,
          pollIntervalMs: taskInterval,
          executeMode,
          epicRestrict,
          adapterRestrict,
        },
        {
          onInfo: (msg) => humanLine(msg),
          onWarn: (msg) => humanWarn(msg),
        },
      );

      const shutdown = () => {
        loop.stop();
        runtime.stop();
        void registry.update(args.agentId, { isActive: false }).catch(() => {});
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      if (process.platform === 'win32') {
        process.on('message', (msg) => {
          if (msg === 'shutdown') shutdown();
        });
      }
      await new Promise(() => {});
    } catch (err) {
      cliOutput(
        { success: false, error: { code: 'E_WORK', message: String(err) } },
        { command: 'agent work' },
      );
      process.exitCode = 1;
    }
  },
});

/**
 * cleo agent list — list registered agent credentials.
 *
 * Default: project-scoped INNER JOIN. Use --global for full cross-project scan
 * (ADR-037 §4 Q1=B).
 *
 * @task T362 @epic T310
 */
const listCommand = defineCommand({
  meta: {
    name: 'list',
    description: 'List registered agent credentials',
  },
  args: {
    active: {
      type: 'boolean',
      description: 'Show only active agents (project-scoped mode only)',
    },
    global: {
      type: 'boolean',
      description: 'Show all global agents regardless of project attachment (ADR-037 §4 Q1=B)',
    },
    'include-disabled': {
      type: 'boolean',
      description: 'Include detached/disabled agents (enabled=0)',
    },
  },
  async run({ args }) {
    try {
      const { listAgentsForProject } = await import('@cleocode/core/agents');
      const { getDb } = await import('@cleocode/core/internal'); // core-first-allowed: infrastructure — TODO T9621 promote getDb
      await getDb();

      const includeGlobal = args.global === true;
      const includeDisabled = args['include-disabled'] === true;

      const agents = listAgentsForProject(getProjectRoot(), {
        includeGlobal,
        includeDisabled,
      });

      // Apply legacy --active filter only when NOT in global mode
      const filtered = !includeGlobal && args.active ? agents.filter((a) => a.isActive) : agents;

      cliOutput(
        {
          success: true,
          data: filtered.map((a) => ({
            agentId: a.agentId,
            name: a.displayName,
            classification: a.classification ?? null,
            transportType: a.transportType,
            isActive: a.isActive,
            lastUsedAt: a.lastUsedAt ?? null,
            attachment: a.projectRef
              ? a.projectRef.enabled === 1
                ? '[attached]'
                : '[disabled]'
              : '[global]',
          })),
        },
        { command: 'agent list' },
      );
    } catch (err) {
      cliOutput(
        { success: false, error: { code: 'E_LIST', message: String(err) } },
        { command: 'agent list' },
      );
      process.exitCode = 1;
    }
  },
});

/**
 * cleo agent get <agentId> — get details for a specific agent credential.
 *
 * Default: project-scoped lookup. With --global: cross-project identity lookup
 * (ADR-037 §4).
 *
 * @task T362 @epic T310
 */
const getCommand = defineCommand({
  meta: {
    name: 'get',
    description: 'Get details for a specific agent credential',
  },
  args: {
    agentId: {
      type: 'positional',
      description: 'Agent ID to look up',
      required: true,
    },
    global: {
      type: 'boolean',
      description:
        'Perform global identity lookup — returns agent even if not attached to current project',
    },
  },
  async run({ args }) {
    try {
      const { lookupAgent } = await import('@cleocode/core/agents');
      const { getDb } = await import('@cleocode/core/internal'); // core-first-allowed: infrastructure — TODO T9621 promote getDb
      await getDb();

      const includeGlobal = args.global === true;
      const agent = lookupAgent(getProjectRoot(), args.agentId, { includeGlobal });

      if (!agent) {
        cliOutput(
          {
            success: false,
            error: { code: 'E_NOT_FOUND', message: `Agent not found: ${args.agentId}` },
          },
          { command: 'agent get' },
        );
        process.exitCode = 4;
        return;
      }

      // Redact API key in output
      const redactedKey =
        agent.apiKey.length > 16
          ? `${agent.apiKey.substring(0, 12)}...${agent.apiKey.substring(agent.apiKey.length - 4)}`
          : '***redacted***';

      cliOutput(
        {
          success: true,
          data: {
            agentId: agent.agentId,
            displayName: agent.displayName,
            apiKey: redactedKey,
            apiBaseUrl: agent.apiBaseUrl,
            classification: agent.classification ?? null,
            transportType: agent.transportType,
            isActive: agent.isActive,
            lastUsedAt: agent.lastUsedAt ?? null,
            createdAt: agent.createdAt,
            updatedAt: agent.updatedAt,
            projectRef: agent.projectRef ?? 'not attached to current project',
          },
        },
        { command: 'agent get' },
      );
    } catch (err) {
      cliOutput(
        { success: false, error: { code: 'E_GET', message: String(err) } },
        { command: 'agent get' },
      );
      process.exitCode = 1;
    }
  },
});

/**
 * cleo agent attach <agentId> — attach a global agent to the current project.
 *
 * @task T364 @epic T310
 * @why ADR-037 §3 — project_agent_refs override table allows per-project
 *      agents to be attached/detached without touching global identity.
 */
const attachCommand = defineCommand({
  meta: {
    name: 'attach',
    description: 'Attach a global agent to the current project',
  },
  args: {
    agentId: {
      type: 'positional',
      description: 'Agent ID to attach',
      required: true,
    },
    role: {
      type: 'string',
      description: 'Per-project role override',
    },
    'capabilities-override': {
      type: 'string',
      description: 'JSON blob of capability overrides',
    },
  },
  async run({ args }) {
    try {
      const { AgentRegistryAccessor, attachAgentToProject, lookupAgent } = await import(
        '@cleocode/core/agents'
      );
      const { getDb } = await import('@cleocode/core/internal'); // core-first-allowed: infrastructure — TODO T9621 promote getDb
      await getDb();
      const projectRoot = getProjectRoot();

      // Ensure both DBs initialised before any cross-DB operation
      const _registry = new AgentRegistryAccessor(projectRoot);
      void _registry;

      // Verify agent exists globally
      const globalAgent = lookupAgent(projectRoot, args.agentId, { includeGlobal: true });
      if (!globalAgent) {
        cliOutput(
          {
            success: false,
            error: { code: 'E_NOT_FOUND', message: `Agent not found: ${args.agentId}` },
          },
          { command: 'agent attach' },
        );
        process.exitCode = 4;
        return;
      }

      attachAgentToProject(projectRoot, args.agentId, {
        role: typeof args.role === 'string' ? args.role : null,
        capabilitiesOverride:
          typeof args['capabilities-override'] === 'string' ? args['capabilities-override'] : null,
      });

      cliOutput(
        {
          success: true,
          data: {
            attached: args.agentId,
            projectRoot,
            role: typeof args.role === 'string' ? args.role : null,
          },
        },
        { command: 'agent attach' },
      );
    } catch (err) {
      cliOutput(
        { success: false, error: { code: 'E_ATTACH', message: String(err) } },
        { command: 'agent attach' },
      );
      process.exitCode = 1;
    }
  },
});

/**
 * cleo agent detach <agentId> — detach an agent from the current project.
 *
 * @task T364 @epic T310
 * @why ADR-037 §3 — soft-delete via project_agent_refs.enabled=0 preserves
 *      global agent identity while removing it from the project view.
 */
const detachCommand = defineCommand({
  meta: {
    name: 'detach',
    description: 'Detach an agent from the current project (preserves global identity)',
  },
  args: {
    agentId: {
      type: 'positional',
      description: 'Agent ID to detach',
      required: true,
    },
  },
  async run({ args }) {
    try {
      const { AgentRegistryAccessor, detachAgentFromProject, getProjectAgentRef } = await import(
        '@cleocode/core/agents'
      );
      const { getDb } = await import('@cleocode/core/internal'); // core-first-allowed: infrastructure — TODO T9621 promote getDb
      await getDb();
      const projectRoot = getProjectRoot();

      // Ensure both DBs initialised
      const _registry = new AgentRegistryAccessor(projectRoot);
      void _registry;

      const ref = getProjectAgentRef(projectRoot, args.agentId);
      if (!ref) {
        cliOutput(
          {
            success: false,
            error: {
              code: 'E_NOT_FOUND',
              message: `Agent ${args.agentId} not attached to current project`,
            },
          },
          { command: 'agent detach' },
        );
        process.exitCode = 4;
        return;
      }

      detachAgentFromProject(projectRoot, args.agentId);

      cliOutput(
        { success: true, data: { detached: args.agentId, projectRoot } },
        { command: 'agent detach' },
      );
    } catch (err) {
      cliOutput(
        { success: false, error: { code: 'E_DETACH', message: String(err) } },
        { command: 'agent detach' },
      );
      process.exitCode = 1;
    }
  },
});

/**
 * cleo agent remove <agentId> — detach agent from project or remove from global registry.
 *
 * Default (no --global): sets enabled=0 in conduit.db:project_agent_refs only.
 * --global: calls AgentRegistryAccessor.removeGlobal() (destructive). Pre-check
 * scans the current project's conduit.db for an active reference.
 *
 * @task T366 @epic T310
 * @why ADR-037 §6 — never-auto-delete semantics; --global flag required for
 *      destructive removal; best-effort cross-project scan with documented
 *      limitation (current project only for v1).
 */
const removeCommand = defineCommand({
  meta: {
    name: 'remove',
    description:
      'Detach agent from current project (default) or remove global identity with --global',
  },
  args: {
    agentId: {
      type: 'positional',
      description: 'Agent ID to remove',
      required: true,
    },
    global: {
      type: 'boolean',
      description: 'Remove from global signaldock.db (destructive, irreversible)',
    },
    'force-global': {
      type: 'boolean',
      description:
        'Force global removal even when the current project still has an active reference',
    },
  },
  async run({ args }) {
    try {
      const { AgentRegistryAccessor, detachAgentFromProject, getProjectAgentRef } = await import(
        '@cleocode/core/agents'
      );
      const { getDb } = await import('@cleocode/core/internal'); // core-first-allowed: infrastructure — TODO T9621 promote getDb
      await getDb();
      const projectRoot = getProjectRoot();

      if (!args.global) {
        // Project-scoped detach (default post-T310) — mirrors `cleo agent detach`
        // Ensure both DBs initialised
        const _registry = new AgentRegistryAccessor(projectRoot);
        void _registry;

        const ref = getProjectAgentRef(projectRoot, args.agentId);
        if (!ref) {
          cliOutput(
            {
              success: false,
              error: {
                code: 'E_NOT_FOUND',
                message: `Agent ${args.agentId} not attached to current project`,
              },
            },
            { command: 'agent remove' },
          );
          process.exitCode = 4;
          return;
        }

        detachAgentFromProject(projectRoot, args.agentId);

        cliOutput(
          { success: true, data: { removed: args.agentId, scope: 'project', projectRoot } },
          { command: 'agent remove' },
        );
        return;
      }

      // --global: destructive removal from signaldock.db
      // Safety scan — limited to current project (ADR-037 §6 known limitation).
      const _registry2 = new AgentRegistryAccessor(projectRoot);
      void _registry2;

      const activeRef = getProjectAgentRef(projectRoot, args.agentId);

      if (activeRef && !args['force-global']) {
        humanWarn(
          `NOTE: Safety scan is limited to the current project. Other projects may have ` +
            `dangling references after global removal.`,
        );
        cliOutput(
          {
            success: false,
            error: {
              code: 'E_VALIDATION',
              message:
                `Agent "${args.agentId}" is still attached to current project. ` +
                `Detach first or pass --force-global to proceed anyway.`,
              fix:
                `cleo agent detach ${args.agentId}  # detach first, then retry` +
                `  OR  cleo agent remove ${args.agentId} --global --force-global`,
            },
          },
          { command: 'agent remove' },
        );
        process.exitCode = 6;
        return;
      }

      humanWarn(
        `NOTE: Safety scan is limited to the current project. Other projects may have ` +
          `dangling references after global removal.`,
      );

      const registry = new AgentRegistryAccessor(projectRoot);
      await registry.removeGlobal(args.agentId, { force: args['force-global'] === true });

      cliOutput(
        { success: true, data: { removed: args.agentId, scope: 'global' } },
        { command: 'agent remove' },
      );
    } catch (err) {
      cliOutput(
        { success: false, error: { code: 'E_REMOVE', message: String(err) } },
        { command: 'agent remove' },
      );
      process.exitCode = 1;
    }
  },
});

/** cleo agent rotate-key <agentId> — rotate an agent API key */
const rotateKeyCommand = defineCommand({
  meta: {
    name: 'rotate-key',
    description: 'Rotate an agent API key (generates new key on cloud, re-encrypts locally)',
  },
  args: {
    agentId: {
      type: 'positional',
      description: 'Agent ID whose key should be rotated',
      required: true,
    },
  },
  async run({ args }) {
    try {
      const { AgentRegistryAccessor } = await import('@cleocode/core/agents');
      const { getDb } = await import('@cleocode/core/internal'); // core-first-allowed: infrastructure — TODO T9621 promote getDb
      await getDb();
      const registry = new AgentRegistryAccessor(getProjectRoot());

      const result = await registry.rotateKey(args.agentId);
      cliOutput(
        {
          success: true,
          data: {
            agentId: result.agentId,
            newApiKey: `${result.newApiKey.substring(0, 12)}...`,
            message: 'API key rotated. Old key is invalidated.',
          },
        },
        { command: 'agent rotate-key' },
      );
    } catch (err) {
      cliOutput(
        { success: false, error: { code: 'E_ROTATE', message: String(err) } },
        { command: 'agent rotate-key' },
      );
      process.exitCode = 1;
    }
  },
});

/** cleo agent claim-code <agentId> — generate a claim code for human ownership verification */
const claimCodeCommand = defineCommand({
  meta: {
    name: 'claim-code',
    description: 'Generate a claim code for human ownership of an agent',
  },
  args: {
    agentId: {
      type: 'positional',
      description: 'Agent ID to generate a claim code for',
      required: true,
    },
  },
  async run({ args }) {
    try {
      const { AgentRegistryAccessor } = await import('@cleocode/core/agents');
      const { getDb } = await import('@cleocode/core/internal'); // core-first-allowed: infrastructure — TODO T9621 promote getDb
      await getDb();
      const registry = new AgentRegistryAccessor(getProjectRoot());

      const credential = await registry.get(args.agentId);
      if (!credential) {
        cliOutput(
          {
            success: false,
            error: { code: 'E_NOT_FOUND', message: `Agent not found: ${args.agentId}` },
          },
          { command: 'agent claim-code' },
        );
        process.exitCode = 4;
        return;
      }

      const response = await fetch(`${credential.apiBaseUrl}/agents/${args.agentId}/claim-code`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${credential.apiKey}`,
          'X-Agent-Id': args.agentId,
        },
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Failed to generate claim code: ${response.status} ${text}`);
      }

      const data = (await response.json()) as {
        data?: { claimCode?: string; claimUrl?: string; expiresAt?: string };
      };

      cliOutput(
        {
          success: true,
          data: {
            agentId: args.agentId,
            claimCode: data.data?.claimCode,
            claimUrl: data.data?.claimUrl ?? `https://signaldock.io/claim/${data.data?.claimCode}`,
            expiresAt: data.data?.expiresAt,
            message: 'Share this claim code with the human owner to verify agent ownership.',
          },
        },
        { command: 'agent claim-code' },
      );
    } catch (err) {
      cliOutput(
        { success: false, error: { code: 'E_CLAIM', message: String(err) } },
        { command: 'agent claim-code' },
      );
      process.exitCode = 1;
    }
  },
});

/** cleo agent watch — start continuous message polling for the active agent */
const watchCommand = defineCommand({
  meta: {
    name: 'watch',
    description: 'Start continuous message polling for the active agent (long-running)',
  },
  args: {
    agent: {
      type: 'string',
      description: 'Agent ID to watch as (defaults to most recently used)',
      alias: 'a',
    },
    interval: {
      type: 'string',
      description: 'Poll interval in milliseconds',
      default: '5000',
    },
    group: {
      type: 'string',
      description: 'Comma-separated group conversation IDs to monitor',
    },
  },
  async run({ args }) {
    try {
      const { AgentRegistryAccessor } = await import('@cleocode/core/agents');
      const { getDb } = await import('@cleocode/core/internal'); // core-first-allowed: infrastructure — TODO T9621 promote getDb
      const { createRuntime } = await import('@cleocode/runtime');
      await getDb();
      const registry = new AgentRegistryAccessor(getProjectRoot());

      const groupIds = args.group ? args.group.split(',').map((s) => s.trim()) : undefined;

      const handle = await createRuntime(registry, {
        agentId: args.agent as string | undefined,
        pollIntervalMs: Number(args.interval) || 5000,
        groupConversationIds: groupIds,
      });

      handle.poller.onMessage((msg) => {
        cliOutput(
          {
            success: true,
            data: {
              event: 'message',
              id: msg.id,
              from: msg.from,
              content: msg.content,
              threadId: msg.threadId,
              timestamp: msg.timestamp,
            },
          },
          { command: 'agent watch' },
        );
      });

      handle.poller.start();

      cliOutput(
        {
          success: true,
          data: {
            event: 'started',
            agentId: handle.agentId,
            pollIntervalMs: Number(args.interval) || 5000,
            groupConversationIds: groupIds ?? [],
            message: 'Watching for messages. Press Ctrl+C to stop.',
          },
        },
        { command: 'agent watch' },
      );

      // Keep alive until SIGINT/SIGTERM
      const shutdown = () => {
        handle.stop();
        cliOutput(
          { success: true, data: { event: 'stopped', agentId: handle.agentId } },
          { command: 'agent watch' },
        );
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      if (process.platform === 'win32') {
        process.on('message', (msg) => {
          if (msg === 'shutdown') shutdown();
        });
      }
    } catch (err) {
      cliOutput(
        { success: false, error: { code: 'E_WATCH', message: String(err) } },
        { command: 'agent watch' },
      );
      process.exitCode = 1;
    }
  },
});

/** cleo agent poll — one-shot message check for the active agent */
const pollCommand = defineCommand({
  meta: {
    name: 'poll',
    description: 'One-shot message check for the active agent',
  },
  args: {
    agent: {
      type: 'string',
      description: 'Agent ID to poll as (defaults to most recently used)',
      alias: 'a',
    },
    limit: {
      type: 'string',
      description: 'Max messages to fetch',
      default: '20',
    },
  },
  async run({ args }) {
    try {
      const { AgentRegistryAccessor, createConduit } = await import('@cleocode/core/agents');
      const { getDb } = await import('@cleocode/core/internal'); // core-first-allowed: infrastructure — TODO T9621 promote getDb
      await getDb();
      const registry = new AgentRegistryAccessor(getProjectRoot());

      const agentId = args.agent as string | undefined;
      const conduit = await createConduit(registry, agentId);
      const limit = Number(args.limit) || 20;
      const messages = await conduit.poll({ limit });

      cliOutput(
        {
          success: true,
          data: { agentId: conduit.agentId, messages, count: messages.length, limit },
        },
        { command: 'agent poll' },
      );

      await conduit.disconnect();
    } catch (err) {
      cliOutput(
        { success: false, error: { code: 'E_POLL', message: String(err) } },
        { command: 'agent poll' },
      );
      process.exitCode = 1;
    }
  },
});

/** cleo agent send <message> — send a message to an agent or conversation */
const sendCommand = defineCommand({
  meta: {
    name: 'send',
    description: 'Send a message to an agent or conversation',
  },
  args: {
    message: {
      type: 'positional',
      description: 'Message content to send',
      required: true,
    },
    to: {
      type: 'string',
      description: 'Target agent ID',
    },
    conv: {
      type: 'string',
      description: 'Target conversation ID',
    },
    agent: {
      type: 'string',
      description: 'Send as this agent (defaults to most recently used)',
      alias: 'a',
    },
  },
  async run({ args }) {
    try {
      const { AgentRegistryAccessor, createConduit } = await import('@cleocode/core/agents');
      const { getDb } = await import('@cleocode/core/internal'); // core-first-allowed: infrastructure — TODO T9621 promote getDb
      await getDb();
      const registry = new AgentRegistryAccessor(getProjectRoot());

      const agentId = args.agent as string | undefined;
      const to = args.to as string | undefined;
      const conv = args.conv as string | undefined;

      if (!to && !conv) {
        cliOutput(
          { success: false, error: { code: 'E_ARGS', message: 'Must specify --to or --conv' } },
          { command: 'agent send' },
        );
        process.exitCode = 1;
        return;
      }

      const conduit = await createConduit(registry, agentId);
      const result = await conduit.send(to ?? conv ?? '', args.message, {
        threadId: conv,
      });

      cliOutput(
        { success: true, data: { messageId: result.messageId, deliveredAt: result.deliveredAt } },
        { command: 'agent send' },
      );

      await conduit.disconnect();
    } catch (err) {
      cliOutput(
        { success: false, error: { code: 'E_SEND', message: String(err) } },
        { command: 'agent send' },
      );
      process.exitCode = 1;
    }
  },
});

/** cleo agent health — check agent health and detect stale or crashed agents */
const healthCommand = defineCommand({
  meta: {
    name: 'health',
    description: 'Check agent health and detect stale or crashed agents',
  },
  args: {
    id: {
      type: 'string',
      description: 'Check health for a specific agent ID',
    },
    threshold: {
      type: 'string',
      description: 'Staleness threshold in milliseconds (default: 180000 = 3 minutes)',
      default: String(STALE_THRESHOLD_MS),
    },
    'detect-crashed': {
      type: 'boolean',
      description: 'Detect and mark crashed agents (write operation)',
    },
  },
  async run({ args }) {
    const thresholdMs = Number(args.threshold);
    const agentId = args.id as string | undefined;
    const detectCrashed = args['detect-crashed'] === true;

    if (agentId) {
      const health = await checkAgentHealth(agentId, thresholdMs);
      if (!health) {
        cliOutput(
          {
            success: false,
            error: { code: 'E_NOT_FOUND', message: `Agent not found: ${agentId}` },
          },
          { command: 'agent health' },
        );
        process.exitCode = 4;
        return;
      }
      cliOutput({ success: true, data: health }, { command: 'agent health' });
      return;
    }

    if (detectCrashed) {
      const crashed = await detectCrashedAgents(thresholdMs);
      cliOutput(
        {
          success: true,
          data: {
            detectedCrashed: crashed.length,
            agents: crashed.map((a) => ({
              id: a.id,
              agentType: a.agentType,
              lastHeartbeat: a.lastHeartbeat,
              status: a.status,
            })),
          },
        },
        { command: 'agent health' },
      );
      return;
    }

    const [report, stale] = await Promise.all([
      getHealthReport(thresholdMs),
      detectStaleAgents(thresholdMs),
    ]);

    cliOutput(
      {
        success: true,
        data: {
          summary: {
            total: report.total,
            active: report.active,
            idle: report.idle,
            starting: report.starting,
            error: report.error,
            crashed: report.crashed,
            stopped: report.stopped,
            totalErrors: report.totalErrors,
          },
          staleAgents: stale.map((s) => ({
            id: s.agentId,
            status: s.status,
            heartbeatAgeMs: s.heartbeatAgeMs,
            lastHeartbeat: s.lastHeartbeat,
            thresholdMs: s.thresholdMs,
          })),
          thresholdMs,
        },
      },
      { command: 'agent health' },
    );
  },
});

/**
 * cleo agent install <path> — install an agent from a `.cant` manifest or
 * `.cantz` archive (ZIP) using the T889 / W2-3 {@link installAgentFromCant}
 * pipeline.
 *
 * - `.cant` file: fed directly to the pipeline; copied to the tier directory
 *   and the `agents` row + `agent_skills` junctions are written atomically.
 * - `.cantz` archive: extracted to a temp dir, `persona.cant` is located and
 *   renamed to `<agentId>.cant` before being passed to the pipeline.
 * - Agent-directory (legacy): same path as `.cantz` — looks for
 *   `persona.cant` inside and feeds a renamed copy to the pipeline.
 *
 * Flags:
 * - `--global`: install to global tier ({@link getCleoGlobalAgentsDir}).
 * - `--strict`: fail with `E_VALIDATION` when the pipeline reports warnings
 *   (e.g. unknown skill slugs).
 * - `--attach`: after install, also attach the agent to the current project
 *   via {@link attachAgentToProject} (conduit.db:project_agent_refs).
 * - `--force`: overwrite an existing row / file instead of throwing
 *   `E_AGENT_ALREADY_INSTALLED`.
 * - `--resync`: drop the existing `agents` row (keep the `.cant` on disk)
 *   then re-install; combines `force: true` with a pre-flight row delete.
 *
 * On success, emits a LAFS envelope of shape `{ agentId, tier, cantPath,
 * cantSha256, inserted, skillsAttached, warnings, attached }`.
 *
 * @task T889 / W2-6
 * @epic T889
 * @see docs/specs/CANTZ-PACKAGE-STANDARD.md
 */
const installCommand = defineCommand({
  meta: {
    name: 'install',
    description: 'Install an agent from a .cant file or .cantz archive',
  },
  args: {
    path: {
      type: 'positional',
      description: 'Path to the .cant file, .cantz archive, or agent directory',
      required: true,
    },
    global: {
      type: 'boolean',
      description: 'Install to global tier (~/.local/share/cleo/cant/agents/)',
    },
    strict: {
      type: 'boolean',
      description: 'Fail on warnings (e.g. unknown skill slugs)',
    },
    attach: {
      type: 'boolean',
      description: 'Attach to the current project after install',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite existing agent row / file',
    },
    resync: {
      type: 'boolean',
      description: 'Drop + reinstall the agents row, keeping the on-disk .cant',
    },
  },
  async run({ args }) {
    let tempDir: string | null = null;
    try {
      const { existsSync } = await import('node:fs');
      const { basename, resolve } = await import('node:path');

      const resolvedPath = resolve(args.path);

      if (!existsSync(resolvedPath)) {
        cliOutput(
          {
            success: false,
            error: {
              code: 'E_NOT_FOUND',
              message: `Path does not exist: ${resolvedPath}`,
            },
          },
          { command: 'agent install' },
        );
        process.exitCode = 4;
        return;
      }

      let resolved: Awaited<ReturnType<typeof resolveAgentCantPath>>;
      try {
        resolved = resolveAgentCantPath({ resolvedPath });
      } catch (resolveErr) {
        const message = resolveErr instanceof Error ? resolveErr.message : String(resolveErr);
        cliOutput(
          { success: false, error: { code: 'E_VALIDATION', message } },
          { command: 'agent install' },
        );
        process.exitCode = 6;
        return;
      }
      const { cantPath, tempDir: resolvedTempDir } = resolved;
      tempDir = resolvedTempDir;

      const { installAgentFromCant, attachAgentToProject } = await import('@cleocode/core/agents');
      const { openCleoDb } = await import('@cleocode/core/store/open-cleo-db');
      const { db: _sdDb } = await openCleoDb('signaldock');
      const db = _sdDb as import('node:sqlite').DatabaseSync;

      const isGlobal = args.global === true;
      const targetTier: 'global' | 'project' = isGlobal ? 'global' : 'project';
      const projectRoot = getProjectRoot();

      try {
        if (args.resync) {
          const parsedName = basename(cantPath, '.cant');
          const row = db.prepare('SELECT id FROM agents WHERE agent_id = ?').get(parsedName) as
            | { id: string }
            | undefined;
          if (row) {
            db.exec('BEGIN IMMEDIATE TRANSACTION');
            try {
              db.prepare('DELETE FROM agent_skills WHERE agent_id = ?').run(row.id);
              db.prepare('DELETE FROM agents WHERE id = ?').run(row.id);
              db.exec('COMMIT');
            } catch (resyncErr) {
              db.exec('ROLLBACK');
              throw resyncErr;
            }
          }
        }

        const result = installAgentFromCant(db, {
          cantSource: cantPath,
          targetTier,
          installedFrom: 'user',
          projectRoot: targetTier === 'project' ? projectRoot : undefined,
          force: args.force === true || args.resync === true,
        });

        if (args.strict && result.warnings.length > 0) {
          cliOutput(
            {
              success: false,
              error: {
                code: 'E_VALIDATION',
                message: `Install produced warnings in --strict mode: ${result.warnings.join('; ')}`,
              },
              data: {
                agentId: result.agentId,
                tier: result.tier,
                warnings: result.warnings,
              },
            },
            { command: 'agent install' },
          );
          process.exitCode = 6;
          return;
        }

        let attached = false;
        if (args.attach && targetTier === 'global') {
          attachAgentToProject(projectRoot, result.agentId);
          attached = true;
        }

        cliOutput(
          {
            success: true,
            data: {
              agentId: result.agentId,
              tier: result.tier,
              cantPath: result.cantPath,
              cantSha256: result.cantSha256,
              inserted: result.inserted,
              skillsAttached: result.skillsAttached,
              warnings: result.warnings,
              attached,
            },
          },
          { command: 'agent install' },
        );
      } finally {
        db.close();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = /E_AGENT_ALREADY_INSTALLED/.test(message)
        ? 'E_AGENT_ALREADY_INSTALLED'
        : 'E_INSTALL';
      cliOutput({ success: false, error: { code, message } }, { command: 'agent install' });
      process.exitCode = 1;
    } finally {
      cleanupInstallTempDir(tempDir);
    }
  },
});

/**
 * cleo agent pack <dir> — package an agent directory into a .cantz ZIP archive.
 *
 * Validates that the source directory contains `persona.cant`, then creates a
 * ZIP archive named `<dirname>.cantz` in the current working directory.
 *
 * @task T438 @epic T250
 * @see docs/specs/CANTZ-PACKAGE-STANDARD.md
 */
const packCommand = defineCommand({
  meta: {
    name: 'pack',
    description: 'Package an agent directory as a .cantz archive',
  },
  args: {
    dir: {
      type: 'positional',
      description: 'Agent directory to package',
      required: true,
    },
  },
  async run({ args }) {
    try {
      const { existsSync, statSync } = await import('node:fs');
      const { resolve, basename, dirname } = await import('node:path');
      const { execFileSync } = await import('node:child_process');

      const resolvedDir = resolve(args.dir);

      if (!existsSync(resolvedDir) || !statSync(resolvedDir).isDirectory()) {
        cliOutput(
          {
            success: false,
            error: {
              code: 'E_NOT_FOUND',
              message: `Directory does not exist: ${resolvedDir}`,
            },
          },
          { command: 'agent pack' },
        );
        process.exitCode = 4;
        return;
      }

      // Validate persona.cant exists
      const { join } = await import('node:path');
      const personaPath = join(resolvedDir, 'persona.cant');
      if (!existsSync(personaPath)) {
        cliOutput(
          {
            success: false,
            error: {
              code: 'E_VALIDATION',
              message: `Agent directory must contain persona.cant: ${personaPath}`,
            },
          },
          { command: 'agent pack' },
        );
        process.exitCode = 6;
        return;
      }

      const agentName = basename(resolvedDir);
      const archiveName = `${agentName}.cantz`;
      const archivePath = resolve(archiveName);
      const parentDir = dirname(resolvedDir);

      // Create ZIP archive — run zip from parent directory so the
      // archive contains agentName/ as the top-level directory
      try {
        execFileSync('zip', ['-r', archivePath, agentName], {
          cwd: parentDir,
          encoding: 'utf-8',
          timeout: 30000,
        });
      } catch (zipErr) {
        cliOutput(
          {
            success: false,
            error: {
              code: 'E_PACK',
              message: `Failed to create archive: ${String(zipErr)}`,
            },
          },
          { command: 'agent pack' },
        );
        process.exitCode = 1;
        return;
      }

      // Get file count and archive size
      const archiveStats = statSync(archivePath);
      const { readdirSync } = await import('node:fs');
      let fileCount = 0;
      const countFiles = (dirPath: string): void => {
        const entries = readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile()) {
            fileCount++;
          } else if (entry.isDirectory()) {
            countFiles(join(dirPath, entry.name));
          }
        }
      };
      countFiles(resolvedDir);

      cliOutput(
        {
          success: true,
          data: {
            archive: archivePath,
            agent: agentName,
            files: fileCount,
            size: archiveStats.size,
          },
        },
        { command: 'agent pack' },
      );
    } catch (err) {
      cliOutput(
        { success: false, error: { code: 'E_PACK', message: String(err) } },
        { command: 'agent pack' },
      );
      process.exitCode = 1;
    }
  },
});

/**
 * cleo agent create — scaffold a complete agent package.
 *
 * Creates a directory structure conforming to the CANTZ package standard
 * (docs/specs/CANTZ-PACKAGE-STANDARD.md) with role-based persona templates
 * derived from the starter-bundle canonical agents.
 *
 * Template roles:
 * - **orchestrator**: read-only tools, high tier, dispatch-focused
 * - **lead**: read-only tools, mid tier, task decomposition
 * - **worker**: full tool access, mid tier, code execution
 * - **docs-worker**: documentation-focused worker variant
 *
 * @task T439 @epic T250
 * @see docs/specs/CANTZ-PACKAGE-STANDARD.md
 * @see packages/cleo-os/starter-bundle/agents/ — canonical format reference
 */
const createCommand = defineCommand({
  meta: {
    name: 'create',
    description: 'Scaffold a new agent package with persona.cant and manifest.json',
  },
  args: {
    name: {
      type: 'string',
      description: 'Agent name (kebab-case)',
      required: true,
    },
    role: {
      type: 'string',
      description: 'Agent role: orchestrator, lead, worker, or docs-worker',
      required: true,
    },
    tier: {
      type: 'string',
      description: 'Agent tier: low, mid, or high (defaults based on role)',
    },
    team: {
      type: 'string',
      description: 'Team this agent belongs to',
    },
    domain: {
      type: 'string',
      description: 'Domain description for file permissions and context',
    },
    global: {
      type: 'boolean',
      description: 'Create in global tier (~/.local/share/cleo/cant/agents/)',
    },
    'seed-brain': {
      type: 'boolean',
      description: 'Create expertise/mental-model-seed.md and seed a BRAIN observation',
    },
    parent: {
      type: 'string',
      description: 'Parent agent name in the hierarchy',
    },
  },
  async run({ args }) {
    try {
      const name = args.name;
      const role = args.role;
      const tier = args.tier ?? inferTierFromRole(role);
      const team = args.team as string | undefined;
      const domain = args.domain as string | undefined;
      const isGlobal = args.global === true;
      const seedBrain = args['seed-brain'] === true;
      const parent = args.parent as string | undefined;

      try {
        validateRole(role);
      } catch (e) {
        cliOutput(
          {
            success: false,
            error: {
              code: 'E_VALIDATION',
              message: String(e instanceof Error ? e.message : e),
              fix: `cleo agent create --name ${name} --role worker`,
            },
          },
          { command: 'agent create' },
        );
        process.exitCode = 6;
        return;
      }

      try {
        validateTier(tier);
      } catch (e) {
        cliOutput(
          {
            success: false,
            error: {
              code: 'E_VALIDATION',
              message: String(e instanceof Error ? e.message : e),
              fix: `cleo agent create --name ${name} --role ${role} --tier mid`,
            },
          },
          { command: 'agent create' },
        );
        process.exitCode = 6;
        return;
      }

      try {
        validateName(name);
      } catch (e) {
        cliOutput(
          {
            success: false,
            error: {
              code: 'E_VALIDATION',
              message: String(e instanceof Error ? e.message : e),
              fix: 'Use lowercase letters, numbers, and hyphens. Must start with a letter.',
            },
          },
          { command: 'agent create' },
        );
        process.exitCode = 6;
        return;
      }

      let scaffoldResult: Awaited<ReturnType<typeof scaffoldAgent>>;
      try {
        scaffoldResult = scaffoldAgent({
          name,
          role,
          tier,
          team,
          domain,
          parent,
          global: isGlobal,
          seedBrain,
          projectRoot: isGlobal ? undefined : getProjectRoot(),
          cleoDirName: CLEO_DIR_NAME,
          cantAgentsSubdir: CANT_AGENTS_SUBDIR,
        });
      } catch (e) {
        cliOutput(
          {
            success: false,
            error: {
              code: 'E_VALIDATION',
              message: String(e instanceof Error ? e.message : e),
              fix: 'Remove the existing directory or choose a different name.',
            },
          },
          { command: 'agent create' },
        );
        process.exitCode = 6;
        return;
      }

      // Best-effort BRAIN observation via CLI when --seed-brain
      if (seedBrain) {
        try {
          const { execFile } = await import('node:child_process');
          const { promisify } = await import('node:util');
          const execFileAsync = promisify(execFile);
          await execFileAsync(
            'cleo',
            [
              'observe',
              `Agent ${name} created with role ${role}`,
              '--title',
              `Agent creation: ${name}`,
            ],
            { encoding: 'utf-8', timeout: 10000 },
          ).catch(() => {
            // Best-effort — do not fail create if observe fails
          });
        } catch {
          // Best-effort — do not fail create if observe fails
        }
      }

      // Best-effort agent registration in signaldock.db
      let registered = false;
      try {
        const { AgentRegistryAccessor } = await import('@cleocode/core/agents');
        const { getDb } = await import('@cleocode/core/internal'); // core-first-allowed: infrastructure — TODO T9621 promote getDb
        await getDb();
        const registry = new AgentRegistryAccessor(getProjectRoot());
        const existing = await registry.get(name);

        if (!existing) {
          await registry.register({
            agentId: name,
            displayName: name,
            apiKey: 'local-created',
            apiBaseUrl: 'local',
            classification: role,
            privacyTier: 'private',
            capabilities: [],
            skills: [],
            transportType: 'http',
            transportConfig: {},
            isActive: false,
          });
          registered = true;
        }
      } catch {
        // Registration is best-effort — do not fail the create
      }

      cliOutput(
        {
          success: true,
          data: {
            ...scaffoldResult,
            registered,
          },
        },
        { command: 'agent create' },
      );
    } catch (err) {
      cliOutput(
        { success: false, error: { code: 'E_CREATE', message: String(err) } },
        { command: 'agent create' },
      );
      process.exitCode = 1;
    }
  },
});

/**
 * cleo agent doctor — reconcile `.cant` files on disk vs the registry DB.
 *
 * Walks the tier filesystems (global + the current project, if any) against
 * `signaldock.db:agents` and emits typed D-code findings. With `--repair`
 * the doctor applies safe, idempotent remediations (delete orphan rows,
 * refresh drifting SHA-256 digests). Exits non-zero when any
 * error-severity finding is present so CI can gate on a clean report.
 *
 * @task T889 / T901 / W2-7
 * @epic T889
 */
/**
 * cleo agent mint — invoke agent-architect meta-agent to synthesize a project-specific
 * agent from a .cant spec file and project context.
 *
 * Semantic distinction from `cleo agent create`:
 *   - `create` — static scaffold from role templates (no AI synthesis)
 *   - `mint`   — meta-agent-driven synthesis from a spec file + project context (AC8)
 *
 * @task T1276 v2026.4.127 T1259 E2 cleo agent mint CLI verb
 */
const mintCommand = defineCommand({
  meta: {
    name: 'mint',
    description:
      'Synthesize a project-specific agent from a .cant spec using agent-architect meta-agent',
  },
  args: {
    spec: {
      type: 'positional',
      description: 'Path to the .cant spec file describing the agent to synthesize',
      required: true,
    },
    'output-dir': {
      type: 'string',
      description: 'Directory to write synthesized .cant files (defaults to .cleo/cant/agents/)',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Preview invocation tokens without invoking agent-architect',
      default: false,
    },
    json: {
      type: 'boolean',
      description: 'Emit result as LAFS JSON envelope',
      default: false,
    },
  },
  async run({ args }) {
    try {
      const { existsSync, readFileSync, mkdirSync } = await import('node:fs');
      const { resolve, join } = await import('node:path');

      const specPath = resolve(args.spec);
      if (!existsSync(specPath)) {
        cliError(`spec file not found: ${specPath}`, 4, { name: 'E_NOT_FOUND' });
        process.exitCode = 4;
        return;
      }

      const specContent = readFileSync(specPath, 'utf-8');
      const projectRoot = getProjectRoot();
      const outputDir = args['output-dir']
        ? resolve(args['output-dir'])
        : join(projectRoot, '.cleo', 'cant', 'agents');
      mkdirSync(outputDir, { recursive: true });

      if (args['dry-run']) {
        cliOutput(
          {
            dryRun: true,
            agentName: 'agent-architect',
            specPath,
            outputDir,
            projectRoot,
            message: 'Dry-run: would invoke agent-architect with the above tokens',
          },
          { command: 'agent', operation: 'agent.mint' },
        );
        return;
      }

      const { invokeMetaAgent } = await import('@cleocode/core/agents/invoke-meta-agent');
      const result = await invokeMetaAgent({
        agentName: 'agent-architect',
        projectRoot,
        tokens: {
          CANT_AGENTS_DIR: outputDir,
          // Pass spec content as PROJECT_CONTEXT to let agent-architect read it
          PROJECT_CONTEXT: specContent,
        },
      });

      if (result.invoked) {
        cliOutput(
          {
            invoked: true,
            outputs: result.outputs ?? [],
            outputDir,
            message: `agent-architect synthesized ${result.outputs?.length ?? 0} agent(s)`,
          },
          { command: 'agent', operation: 'agent.mint' },
        );
      } else {
        const fallbackMsg = `agent-architect unavailable: ${result.reason ?? 'unknown'}. Run 'cleo agent create' for static scaffolding.`;
        cliError(fallbackMsg, 1, { name: 'E_META_AGENT_UNAVAILABLE' });
        process.exitCode = 1;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(`agent mint failed: ${message}`, 1, { name: 'E_AGENT_MINT' });
      process.exitCode = 1;
    }
  },
});

/** T9173: cleo agent prune-orphans — delete D-002 orphan registry rows from any cwd. @task T9173 */
const pruneOrphansCommand = defineCommand({
  meta: {
    name: 'prune-orphans',
    description:
      'Delete orphan registry rows whose .cant path no longer exists (cross-project safe)',
  },
  args: {
    json: { type: 'boolean', description: 'Emit raw JSON' },
    'dry-run': { type: 'boolean', description: 'Report without making changes' },
  },
  async run({ args }) {
    try {
      const { buildDoctorReport, reconcileDoctor } = await import('@cleocode/core/agents');
      const { openCleoDb } = await import('@cleocode/core/store/open-cleo-db');
      // Open via chokepoint — applies pragma SSoT (T9047, T9189)
      const { db: _sdDb2 } = await openCleoDb('signaldock');
      const db = _sdDb2 as import('node:sqlite').DatabaseSync;
      try {
        const report = await buildDoctorReport(db, {});
        const d002 = report.findings.filter((f: AgentDoctorFinding) => f.code === 'D-002');
        const dryRun = args['dry-run'] === true;
        let repaired: string[] = [],
          skipped: string[] = [];
        if (!dryRun && d002.length > 0) {
          const r = await reconcileDoctor(db, d002, {});
          repaired = r.repaired;
          skipped = r.skipped;
        }
        const msg =
          d002.length === 0
            ? 'No orphan rows found.'
            : `Found ${d002.length} orphan(s)${dryRun ? ' (dry-run)' : ': pruned=' + repaired.length}`;
        cliOutput(
          {
            success: true,
            data: {
              message: msg,
              found: d002.length,
              repaired: dryRun ? 0 : repaired.length,
              skipped: dryRun ? 0 : skipped.length,
              dryRun,
            },
          },
          { command: 'agent prune-orphans' },
        );
        if (!dryRun && skipped.length > 0) process.exitCode = 1;
      } finally {
        db.close();
      }
    } catch (err) {
      cliOutput(
        { success: false, error: { code: 'E_PRUNE_ORPHANS', message: String(err) } },
        { command: 'agent prune-orphans' },
      );
      process.exitCode = 1;
    }
  },
});

const doctorCommand = defineCommand({
  meta: {
    name: 'doctor',
    description: 'Reconcile .cant files on disk against the registry and report drift',
  },
  args: {
    repair: {
      type: 'boolean',
      description: 'Apply safe repairs (D-002 orphan-row delete, D-003 hash refresh)',
    },
    'import-legacy-json': {
      type: 'boolean',
      description: 'When used with --repair, import a discovered ~/.cleo/agent-registry.json',
    },
    'migrate-path': {
      type: 'boolean',
      description:
        'When used with --repair, migrate legacy .cleo/agents/ rows to .cleo/cant/agents/',
    },
    json: {
      type: 'boolean',
      description: 'Emit the raw DoctorReport envelope as JSON instead of a human table',
    },
  },
  async run({ args }) {
    try {
      const { buildDoctorReport, reconcileDoctor } = await import('@cleocode/core/agents');
      const { openCleoDb } = await import('@cleocode/core/store/open-cleo-db');
      // Open via chokepoint — applies pragma SSoT (T9047, T9189)
      const { db: _sdDb3 } = await openCleoDb('signaldock');
      const db = _sdDb3 as import('node:sqlite').DatabaseSync;

      try {
        const report = await buildDoctorReport(db, { projectRoot: getProjectRoot() });
        const repairFlag = args.repair === true;

        let reconciled: Awaited<ReturnType<typeof reconcileDoctor>> | undefined;
        if (repairFlag) {
          reconciled = await reconcileDoctor(db, report.findings, {
            importLegacyJson: args['import-legacy-json'] === true,
            allowPathMigration: args['migrate-path'] === true,
          });
        }

        if (args.json === true) {
          cliOutput(
            { success: true, data: { report, reconciled: reconciled ?? null } },
            { command: 'agent doctor' },
          );
        } else {
          const lines: string[] = [];
          if (report.findings.length === 0) {
            lines.push('No drift detected — registry and filesystem are in sync.');
          } else {
            lines.push(
              `Findings: ${report.summary.error} error(s), ${report.summary.warn} warning(s), ${report.summary.info} info`,
            );
            lines.push('');
            for (const f of report.findings) {
              lines.push(`[${f.code}] ${f.severity.toUpperCase()} ${f.subject} — ${f.message}`);
              if (f.fixCommand) lines.push(`  fix: ${f.fixCommand}`);
            }
            if (reconciled) {
              lines.push('');
              lines.push(
                `Repaired: ${reconciled.repaired.length > 0 ? reconciled.repaired.join(', ') : '(none)'}`,
              );
              lines.push(
                `Skipped:  ${reconciled.skipped.length > 0 ? reconciled.skipped.join(', ') : '(none)'}`,
              );
            }
          }
          cliOutput(
            {
              success: true,
              data: {
                message: lines.join('\n'),
                summary: report.summary,
                generatedAt: report.generatedAt,
                findings: report.findings.length,
                repaired: reconciled?.repaired.length ?? 0,
                skipped: reconciled?.skipped.length ?? 0,
              },
            },
            { command: 'agent doctor' },
          );
        }

        if (report.summary.error > 0) {
          process.exitCode = 1;
        }
      } finally {
        db.close();
      }
    } catch (err) {
      cliOutput(
        { success: false, error: { code: 'E_DOCTOR', message: String(err) } },
        { command: 'agent doctor' },
      );
      process.exitCode = 1;
    }
  },
});

/**
 * Root agent command group — agent lifecycle, credentials, and messaging.
 *
 * Registers all agent subcommands. See file-level TSDoc for the full
 * command surface and daemon vs. Pi session architectural distinction.
 *
 * @see docs/specs/SIGNALDOCK-UNIFIED-AGENT-REGISTRY.md Section 3.4
 * @see .cleo/adrs/ADR-035-pi-v2-v3-harness.md §D5
 * @task T178
 */
export const agentCommand = defineCommand({
  meta: { name: 'agent', description: 'Agent lifecycle, credentials, and messaging' },
  subCommands: {
    doctor: doctorCommand,
    'prune-orphans': pruneOrphansCommand,
    register: registerCommand,
    signin: signinCommand,
    start: startCommand,
    stop: stopCommand,
    status: statusCommand,
    assign: assignCommand,
    wake: wakeCommand,
    spawn: spawnCommand,
    reassign: reassignCommand,
    'stop-all': stopAllCommand,
    work: workCommand,
    list: listCommand,
    get: getCommand,
    attach: attachCommand,
    detach: detachCommand,
    remove: removeCommand,
    'rotate-key': rotateKeyCommand,
    'claim-code': claimCodeCommand,
    watch: watchCommand,
    poll: pollCommand,
    send: sendCommand,
    health: healthCommand,
    install: installCommand,
    pack: packCommand,
    create: createCommand,
    mint: mintCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});

// Template helpers have moved to packages/core/src/agents/scaffold.ts (T10062 T9833c)

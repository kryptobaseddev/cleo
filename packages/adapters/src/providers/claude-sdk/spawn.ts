/**
 * Claude SDK Spawn Provider
 *
 * Implements `AdapterSpawnProvider` using the `@anthropic-ai/claude-agent-sdk`
 * programmatic API instead of shelling out to the `claude` CLI.
 *
 * Differences from `ClaudeCodeSpawnProvider`:
 * - Uses SDK `query()` instead of a detached child process
 * - Awaits full completion before returning (synchronous output capture)
 * - Session IDs from the SDK enable future multi-turn resumption
 * - No temp files, no OS PIDs — tracking is purely in-memory session IDs
 * - `canSpawn()` uses 3-tier key resolution (env var → stored key → Claude Code OAuth)
 *
 * CANT enrichment is identical to the CLI provider: `buildCantEnrichedPrompt()`
 * is called before `query()` and the result is passed as the SDK prompt string.
 *
 * @task T581
 * @see T752 — canSpawn() OAuth fix
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AdapterSpawnProvider, SpawnContext, SpawnResult } from '@cleocode/contracts';
import { getErrorMessage } from '@cleocode/contracts';
import { getServers } from './mcp-registry.js';
import { SessionStore } from './session-store.js';
import { resolveTools } from './tool-bridge.js';

// ---------------------------------------------------------------------------
// Inline 3-tier Anthropic key resolver
// NOTE: Cannot import from @cleocode/core — circular dependency
//       (@cleocode/core depends on @cleocode/adapters). This is a deliberate
//       inline copy of the resolution logic from anthropic-key-resolver.ts.
//       Keep in sync with packages/core/src/memory/anthropic-key-resolver.ts.
//       T752 — OAuth fix for canSpawn()
// ---------------------------------------------------------------------------

/**
 * Resolve the Anthropic API key using a 3-tier priority chain:
 * 1. `ANTHROPIC_API_KEY` environment variable
 * 2. `~/.local/share/cleo/anthropic-key` (user-stored via cleo config)
 * 3. `~/.claude/.credentials.json` → claudeAiOauth.accessToken (Claude Code OAuth)
 *
 * @returns The key/token string, or null if unavailable.
 */
function resolveAnthropicApiKey(): string | null {
  // 1. Explicit env var
  const envKey = process.env.ANTHROPIC_API_KEY;
  if (envKey?.trim()) return envKey;

  // 2. CLEO global stored key
  try {
    const xdg = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
    const keyFile = join(xdg, 'cleo', 'anthropic-key');
    if (existsSync(keyFile)) {
      const stored = readFileSync(keyFile, 'utf-8').trim();
      if (stored) return stored;
    }
  } catch {
    // Not available — continue
  }

  // 3. Claude Code OAuth token (free for Claude Code users)
  try {
    const credPath = join(homedir(), '.claude', '.credentials.json');
    if (!existsSync(credPath)) return null;
    const raw = readFileSync(credPath, 'utf-8');
    const creds = JSON.parse(raw) as {
      claudeAiOauth?: { accessToken?: string; expiresAt?: number };
    };
    const token = creds.claudeAiOauth?.accessToken;
    if (token?.trim()) {
      const expiresAt = creds.claudeAiOauth?.expiresAt;
      if (expiresAt && Date.now() > expiresAt) return null;
      return token;
    }
  } catch {
    // Credentials file missing or unreadable — not an error
  }

  return null;
}

/** Model used when no model is specified in spawn options. */
const DEFAULT_MODEL = 'claude-sonnet-4-5';

/**
 * Spawn provider that uses the Anthropic Claude Agent SDK for programmatic
 * subagent execution.
 *
 * Each call to `spawn()` runs a full SDK `query()` to completion and
 * captures the output. Sessions are tracked in `SessionStore` so callers
 * can inspect active sessions via `listRunning()` and cancel them via
 * `terminate()`.
 *
 * @remarks
 * The `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions: true`
 * combination mirrors the `--dangerously-skip-permissions` flag used by
 * the CLI provider. Both are required by the SDK when bypassing all tool
 * permission prompts.
 */
export class ClaudeSDKSpawnProvider implements AdapterSpawnProvider {
  /** In-memory session registry. */
  private readonly sessions = new SessionStore();

  /**
   * Check whether the SDK can be used in the current environment.
   *
   * Uses 3-tier key resolution so the provider works with:
   * - `ANTHROPIC_API_KEY` environment variable (explicit)
   * - `~/.local/share/cleo/anthropic-key` (user-stored via cleo config)
   * - Claude Code OAuth token (zero-config for Claude Code users)
   *
   * No binary check is needed because the SDK manages the Claude Code
   * subprocess internally.
   *
   * @returns `true` when any Anthropic credential is available
   */
  async canSpawn(): Promise<boolean> {
    return !!resolveAnthropicApiKey();
  }

  /**
   * Spawn a subagent using the Claude Agent SDK.
   *
   * Enriches the prompt via CANT context, runs the SDK `query()` to
   * completion, captures all assistant text output, and returns a
   * `SpawnResult` with the final output and exit code.
   *
   * @param context - Spawn context with taskId, prompt, options
   * @returns Resolved spawn result (status: 'completed' or 'failed')
   */
  async spawn(context: SpawnContext): Promise<SpawnResult> {
    const instanceId = `sdk-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const startTime = new Date().toISOString();

    // Register in session store immediately so listRunning() reflects it
    // before the async query starts.
    this.sessions.add({
      instanceId,
      sessionId: undefined,
      taskId: context.taskId,
      startTime,
    });

    try {
      // CANT enrichment — best-effort, identical to ClaudeCodeSpawnProvider.
      let enrichedPrompt = context.prompt;
      try {
        const { buildCantEnrichedPrompt } = await import('../../cant-context.js');
        enrichedPrompt = await buildCantEnrichedPrompt({
          projectDir: context.workingDirectory ?? process.cwd(),
          basePrompt: context.prompt,
          agentName: (context.options?.agentName as string) ?? undefined,
        });
      } catch {
        // CANT enrichment unavailable — use raw prompt
      }

      // Lazy-import the SDK to avoid hard failures when ANTHROPIC_API_KEY
      // is absent (canSpawn() guards the normal path, but tests may import
      // this module without the key).
      const { query } = await import('@anthropic-ai/claude-agent-sdk');

      // Build allowedTools from the spawn context or fall back to CLEO defaults.
      const toolAllowlist = context.options?.toolAllowlist as string[] | undefined;
      const allowedTools = resolveTools(toolAllowlist);

      // Resolve available MCP servers for the working directory.
      const workDir = context.workingDirectory ?? process.cwd();
      const mcpServers = getServers(workDir);

      // Resume support: pass a prior session ID if provided.
      const resumeSessionId = context.options?.resumeSessionId as string | undefined;

      const sdkQuery = query({
        prompt: enrichedPrompt,
        options: {
          cwd: workDir,
          model: (context.options?.model as string) ?? DEFAULT_MODEL,
          allowedTools,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
          ...(resumeSessionId ? { resume: resumeSessionId } : {}),
        },
      });

      // Stream messages from the SDK, collecting text output and session ID.
      const textParts: string[] = [];
      let exitCode = 0;
      let finalError: string | undefined;

      for await (const message of sdkQuery) {
        // Capture the session ID from the first message that carries it.
        if ('session_id' in message && typeof message.session_id === 'string') {
          this.sessions.setSessionId(instanceId, message.session_id);
        }

        if (message.type === 'assistant') {
          // Aggregate text blocks from assistant messages.
          for (const block of message.message.content) {
            if (block.type === 'text') {
              textParts.push(block.text);
            }
          }
        } else if (message.type === 'result') {
          if (message.subtype === 'success') {
            // The result field on success contains the final summary text.
            if (message.result) {
              textParts.push(message.result);
            }
            exitCode = message.is_error ? 1 : 0;
          } else {
            // Error subtypes: error_max_turns, error_during_execution, etc.
            exitCode = 1;
            if ('errors' in message && Array.isArray(message.errors) && message.errors.length > 0) {
              finalError = (message.errors as string[]).join('; ');
            } else {
              // Fallback: use the subtype string as the error description so
              // `finalError` is always truthy for non-success result messages.
              finalError = String(message.subtype);
            }
          }
        }
      }

      const endTime = new Date().toISOString();
      this.sessions.remove(instanceId);

      const output = textParts.join('\n').trim();

      if (finalError) {
        return {
          instanceId,
          taskId: context.taskId,
          providerId: 'claude-sdk',
          status: 'failed',
          output,
          exitCode,
          startTime,
          endTime,
          error: finalError,
        };
      }

      return {
        instanceId,
        taskId: context.taskId,
        providerId: 'claude-sdk',
        status: 'completed',
        output,
        exitCode,
        startTime,
        endTime,
      };
    } catch (error) {
      const endTime = new Date().toISOString();
      this.sessions.remove(instanceId);

      return {
        instanceId,
        taskId: context.taskId,
        providerId: 'claude-sdk',
        status: 'failed',
        startTime,
        endTime,
        exitCode: 1,
        error: getErrorMessage(error),
      };
    }
  }

  /**
   * List sessions currently tracked as active (spawned but not yet completed).
   *
   * Because SDK sessions run to completion inside `spawn()`, this list is
   * typically empty unless concurrent spawns are in flight.
   *
   * @returns Array of in-flight spawn results
   */
  async listRunning(): Promise<SpawnResult[]> {
    return this.sessions.listActive().map((entry) => ({
      instanceId: entry.instanceId,
      taskId: entry.taskId,
      providerId: 'claude-sdk',
      status: 'running' as const,
      startTime: entry.startTime,
    }));
  }

  /**
   * Remove a session from tracking.
   *
   * The underlying SDK query runs inside `spawn()` and cannot be cancelled
   * externally once the async iterator is in flight. Removing the entry from
   * the store prevents it from appearing in `listRunning()` but does not
   * interrupt the in-progress HTTP request.
   *
   * @param instanceId - ID of the spawn instance to terminate
   */
  async terminate(instanceId: string): Promise<void> {
    this.sessions.remove(instanceId);
  }
}

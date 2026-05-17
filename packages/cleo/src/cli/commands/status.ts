/**
 * `cleo status` — thin CLI wrapper over {@link getCleoStatus} (T9423).
 *
 * The CLI surface for the unified `CleoStatus` snapshot. Today CLEO has
 * `cleo dash` (tasks-only) and `cleo llm whoami` (LLM roles). Neither
 * answers "what is my full config state?" — that gap is what this command
 * fills. Output covers six sections:
 *
 *   Identity     — `agentId`, `identityFile`, `loggedIn`
 *   Credentials  — every entry from the unified credential pool
 *   Config       — global + project config paths, secrets-in-project warning
 *   Session      — active session id + focused task
 *   Harness      — detected harness + health
 *   Daemon       — sentient daemon pid + last tick + kill-switch
 *
 * Modes:
 *   `cleo status`         — human-readable, section-by-section formatted output
 *   `cleo status --json`  — full `CleoStatus` JSON via the standard LAFS envelope
 *
 * Exit codes:
 *   0  — all credentials healthy
 *   1  — at least one credential has `lastStatus === 'invalid'`
 *
 * Highlights in human mode:
 *   - `hasSecretsInProjectConfig: true` → bold red warning banner at the top.
 *   - Credentials with `lastStatus === 'invalid'` → red `[INVALID]`.
 *   - Credentials with `isExpired: true` → yellow `[EXPIRED]`.
 *
 * @task T9424
 * @epic E-CONFIG-AUTH-UNIFY (E3 §5.3 T-E3-5)
 */

import { getCleoStatus } from '@cleocode/core/status';
import { defineCommand } from 'citty';
import { isJsonFormat } from '../format-context.js';
import { BOLD, CYAN, DIM, GREEN, NC, RED, YELLOW } from '../renderers/colors.js';
import { cliOutput } from '../renderers/index.js';

// ---------------------------------------------------------------------------
// Human renderer
// ---------------------------------------------------------------------------

/**
 * Local minimal shape of the {@link CleoStatus} envelope. Mirrors the public
 * interface in `@cleocode/core/status` but kept inline as `Record`-style
 * indexing here so the human renderer doesn't pull the full type graph into
 * the CLI cold-start path.
 *
 * @internal
 */
interface StatusShape {
  identity: {
    agentId: string | null;
    loggedIn: boolean;
    identityFile: string | null;
  };
  credentials: Array<{
    provider: string;
    source: string;
    hasCredential: boolean;
    authType?: string;
    expiresAt?: number | null;
    isExpired?: boolean;
    lastStatus?: 'ok' | 'exhausted' | 'invalid';
    label?: string;
  }>;
  config: {
    globalConfigPath: string;
    projectConfigPath: string | null;
    activeConfigPath: string;
    hasSecretsInProjectConfig: boolean;
    secretsWarnings: string[];
  };
  session: {
    active: boolean;
    sessionId: string | null;
    focusedTask: string | null;
  };
  harness: {
    active: 'pi' | 'claude-code' | 'unknown';
    healthy: boolean;
    issues: string[];
  };
  daemon: {
    running: boolean;
    pid: number | null;
    lastTickAt: number | null;
    killSwitchActive: boolean;
  };
}

/**
 * Format an epoch-ms timestamp as a short ISO date (UTC). Empty string when
 * the input is `null`/`undefined`. Used by both the credentials and daemon
 * blocks so expiry and last-tick render consistently.
 *
 * @internal
 */
function formatEpoch(epoch: number | null | undefined): string {
  if (epoch == null) return '';
  const d = new Date(epoch);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

/**
 * Build a one-line credential summary. Highlights:
 *
 *   `[INVALID]` → red, when `lastStatus === 'invalid'`.
 *   `[EXPIRED]` → yellow, when `isExpired === true`.
 *
 * Both badges may appear together for a credential that is both expired AND
 * has been observed as invalid in a later request.
 *
 * @internal
 */
function renderCredentialLine(c: StatusShape['credentials'][number]): string {
  const badges: string[] = [];
  if (c.lastStatus === 'invalid') badges.push(`${RED}${BOLD}[INVALID]${NC}`);
  if (c.isExpired === true) badges.push(`${YELLOW}${BOLD}[EXPIRED]${NC}`);
  const label = c.label ?? '(no label)';
  const head = `${BOLD}${c.provider}${NC} ${DIM}${label}${NC}`;
  const meta: string[] = [];
  meta.push(`source=${c.source}`);
  if (c.authType !== undefined) meta.push(`authType=${c.authType}`);
  if (c.lastStatus !== undefined) meta.push(`lastStatus=${c.lastStatus}`);
  if (c.expiresAt != null) meta.push(`expiresAt=${formatEpoch(c.expiresAt)}`);
  const metaLine = `${DIM}${meta.join(' · ')}${NC}`;
  const badgeStr = badges.length > 0 ? ` ${badges.join(' ')}` : '';
  return `    ${head}${badgeStr}\n      ${metaLine}`;
}

/**
 * Render the full {@link CleoStatus} envelope as a human-readable summary.
 *
 * Output is rendered as six labeled sections (Identity, Credentials, Config,
 * Session, Harness, Daemon). When `hasSecretsInProjectConfig` is `true`, a
 * bold red banner is emitted at the very top so the operator sees the
 * footgun even if their terminal scrolls the rest off-screen.
 *
 * @internal
 */
function renderStatusHuman(status: StatusShape): string {
  const lines: string[] = [];

  // Prominent secrets-in-project-config warning at the very top.
  if (status.config.hasSecretsInProjectConfig) {
    lines.push(`${RED}${BOLD}WARNING: Secrets detected in project config${NC}`);
    for (const w of status.config.secretsWarnings) {
      lines.push(`  ${RED}${w}${NC}`);
    }
    lines.push('');
  }

  // Identity
  lines.push(`${BOLD}Identity${NC}`);
  lines.push(`  ${DIM}agentId:${NC}      ${status.identity.agentId ?? '(none)'}`);
  lines.push(`  ${DIM}identityFile:${NC} ${status.identity.identityFile ?? '(none)'}`);
  const loggedInBadge = status.identity.loggedIn
    ? `${GREEN}yes${NC}`
    : `${YELLOW}no — run \`cleo setup\`${NC}`;
  lines.push(`  ${DIM}loggedIn:${NC}     ${loggedInBadge}`);
  lines.push('');

  // Credentials
  lines.push(`${BOLD}Credentials${NC} ${DIM}(${status.credentials.length} entries)${NC}`);
  if (status.credentials.length === 0) {
    lines.push(`  ${DIM}(no credentials — run \`cleo auth list\` after \`cleo setup\`)${NC}`);
  } else {
    for (const c of status.credentials) {
      lines.push(renderCredentialLine(c));
    }
  }
  lines.push('');

  // Config
  lines.push(`${BOLD}Config${NC}`);
  lines.push(`  ${DIM}globalConfigPath:${NC}  ${status.config.globalConfigPath}`);
  lines.push(`  ${DIM}projectConfigPath:${NC} ${status.config.projectConfigPath ?? '(none)'}`);
  lines.push(`  ${DIM}activeConfigPath:${NC}  ${status.config.activeConfigPath}`);
  lines.push('');

  // Session
  lines.push(`${BOLD}Session${NC}`);
  const sessionState = status.session.active ? `${GREEN}active${NC}` : `${DIM}inactive${NC}`;
  lines.push(`  ${DIM}state:${NC}       ${sessionState}`);
  lines.push(`  ${DIM}sessionId:${NC}   ${status.session.sessionId ?? '(none)'}`);
  lines.push(`  ${DIM}focusedTask:${NC} ${status.session.focusedTask ?? '(none)'}`);
  lines.push('');

  // Harness
  lines.push(`${BOLD}Harness${NC}`);
  lines.push(`  ${DIM}active:${NC}  ${CYAN}${status.harness.active}${NC}`);
  lines.push(
    `  ${DIM}healthy:${NC} ${status.harness.healthy ? `${GREEN}yes${NC}` : `${RED}no${NC}`}`,
  );
  if (status.harness.issues.length > 0) {
    for (const issue of status.harness.issues) {
      lines.push(`    ${YELLOW}- ${issue}${NC}`);
    }
  }
  lines.push('');

  // Daemon
  lines.push(`${BOLD}Daemon${NC}`);
  const daemonState = status.daemon.running ? `${GREEN}running${NC}` : `${DIM}stopped${NC}`;
  lines.push(`  ${DIM}state:${NC}            ${daemonState}`);
  lines.push(`  ${DIM}pid:${NC}              ${status.daemon.pid ?? '(none)'}`);
  lines.push(
    `  ${DIM}lastTickAt:${NC}       ${
      status.daemon.lastTickAt != null ? formatEpoch(status.daemon.lastTickAt) : '(never)'
    }`,
  );
  const killSwitchBadge = status.daemon.killSwitchActive
    ? `${RED}${BOLD}ACTIVE${NC}`
    : `${DIM}inactive${NC}`;
  lines.push(`  ${DIM}killSwitchActive:${NC} ${killSwitchBadge}`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Exit-code policy
// ---------------------------------------------------------------------------

/**
 * Compute the exit code from a status snapshot.
 *
 * Returns 1 when any credential's `lastStatus === 'invalid'` so CI/scripts
 * can pick up auth-state regressions without parsing JSON. Expiry alone is
 * NOT a hard failure (refresh may still succeed) — only confirmed invalid
 * state escalates to exit 1.
 *
 * @internal
 */
function computeExitCode(status: StatusShape): number {
  const hasInvalid = status.credentials.some((c) => c.lastStatus === 'invalid');
  return hasInvalid ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/**
 * `cleo status` — print the unified config snapshot.
 *
 * Imports `@cleocode/core/status` statically. The status surface is the
 * one command users explicitly type to inspect their config — there is no
 * cold-start saving to be had from lazy-loading the snapshot aggregator
 * when running it. Static import keeps vitest workspace-alias resolution
 * straightforward (dynamic-import alias rewrites are flaky under v4.x).
 *
 * @task T9424
 */
export const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description:
      'Unified config + credential + session + harness + daemon snapshot. ' +
      'Use --json for the full LAFS envelope (CleoStatus interface). ' +
      'Exits non-zero when any credential is in invalid state.',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Output as JSON envelope (CleoStatus interface)',
    },
  },
  async run({ args }) {
    const a = args as Record<string, unknown>;
    // --json on this command is an explicit override on top of the global
    // --format resolution: the command-level flag wins for users who want
    // JSON without exporting CLEO_FORMAT.
    const forceJson = a['json'] === true;

    const status = (await getCleoStatus()) as StatusShape;

    // In human mode, emit the section-by-section renderer directly via
    // process.stdout so the renderer is bypass-safe for tests and respects
    // ANSI/NO_COLOR via the shared color helpers. JSON mode goes through
    // cliOutput for the LAFS envelope.
    if (forceJson || isJsonFormat()) {
      cliOutput(status, {
        command: 'status',
        operation: 'status.show',
      });
    } else {
      process.stdout.write(`${renderStatusHuman(status)}\n`);
    }

    const exitCode = computeExitCode(status);
    if (exitCode !== 0) process.exit(exitCode);
  },
});

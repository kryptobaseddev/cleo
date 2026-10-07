/**
 * CLI glue for `cleo login nexus` and its guided first run (T13102): sign in,
 * then run `@cleocode/core/cloud/nexus-first-run.js` and emit one envelope
 * (`data` = the login result plus `data.firstRun`) or one human summary.
 *
 * Consent: `--yes` acts without asking; a terminal (stdin and stderr are both
 * TTYs, and not under CI) is asked on stderr; anything else (an agent, a
 * pipe, a redirected stderr, CI) is never asked and gets the exact next
 * command, on stderr and in `data.firstRun.nextCommand` (or the choices, when
 * the next step is the user's decision).
 * A first-run problem never fails the sign-in.
 *
 * No function here receives or prints a token.
 *
 * @task T13102
 * @epic T12322
 */

import type { NexusFirstRunResult, NexusLoginResult, NexusNamedProject } from '@cleocode/contracts';
import { isHumanOutput } from '../renderers/index.js';
import {
  emitNexusResult,
  failNexus,
  nexusLoginSummary,
  runNexusLogin,
} from './nexus-account-cli.js';
import { ReadlineWizardIO } from './readline-wizard-io.js';
import { terminalSafe } from './terminal-safe.js';

/** Parsed citty args. */
type Args = Readonly<Record<string, unknown>>;

/** Progress lines (stderr) for the steps that take a while. */
const STEP_LINES = {
  link: 'Linking this project to Cleo Nexus...',
  backup: 'Backing it up (encrypted)...',
  restore: 'Restoring its backup from Cleo Nexus...',
  projects: 'Looking up your Cleo Nexus projects...',
} as const;

/**
 * How the run may act: `--yes`, a terminal, or never ask. A prompt needs both
 * stdin and stderr on a terminal (a prompt written to a redirected stderr is
 * invisible and would wait on stdin), and never runs under CI (review LOW-3).
 */
function consentOf(args: Args): 'yes' | 'prompt' | 'never' {
  if (args['yes'] === true) return 'yes';
  const ci = (process.env['CI'] ?? '') !== '' && process.env['CI'] !== 'false';
  return process.stdin.isTTY && process.stderr.isTTY && !ci ? 'prompt' : 'never';
}

/**
 * Run the guided first run after a sign-in. Never throws: an unexpected
 * failure becomes a `skipped` result with a warning.
 *
 * @param args - Parsed citty args (`--yes`, `--api-url`, `--read-only`).
 * @param login - The sign-in result.
 * @returns The first run's outcome.
 */
export async function runNexusFirstRunCli(
  args: Args,
  login: NexusLoginResult,
): Promise<NexusFirstRunResult> {
  const { nexusFirstRunResult, runNexusFirstRun } = await import(
    /* webpackIgnore: true */ '@cleocode/core/cloud/nexus-first-run.js'
  );
  const consent = consentOf(args);
  // Prompts go to stderr: stdout carries exactly one envelope (ADR-086).
  const io = consent === 'prompt' ? new ReadlineWizardIO(process.stdin, process.stderr) : null;
  try {
    return await runNexusFirstRun({
      apiUrl: login.apiUrl,
      consent,
      ...(io
        ? {
            confirm: (question: string, defaultYes: boolean) => io.confirm(question, defaultYes),
          }
        : {}),
      deviceId: login.device?.deviceId ?? null,
      readOnly: args['read-only'] === true,
      onStep: (step) => process.stderr.write(`${STEP_LINES[step]}\n`),
    });
  } catch (err) {
    return nexusFirstRunResult('skipped', {
      reason: 'the guided first run failed',
      warnings: [
        {
          code: 'W_NEXUS_FIRST_RUN_FAILED',
          message: err instanceof Error ? err.message : String(err),
        },
      ],
    });
  } finally {
    io?.close();
  }
}

/** One line per project: name, sync state and its restore command. */
function projectLine(p: NexusNamedProject): string {
  const where = p.onThisDevice
    ? 'already on this machine'
    : p.hasBackup === false
      ? 'no backup yet'
      : p.lastSyncAt
        ? `last sync ${p.lastSyncAt}`
        : 'backed up';
  const command = p.restoreByNameCommand ?? p.restoreCommand;
  return `  ${p.name} (${where})${command ? `: ${command}` : ''}`;
}

/** The project list block of the human summary. */
function projectsBlock(r: NexusFirstRunResult): string {
  if (r.projects.length === 0) {
    return r.warnings.length > 0
      ? ' Your Cleo Nexus projects could not be listed (see warnings).'
      : ' This account has no Cleo Nexus projects yet: run `cleo login nexus` inside a CLEO project to link and back it up.';
  }
  return [
    ' Your Cleo Nexus projects (run a restore inside the folder it belongs in, e.g. a clone of its repository):',
    ...r.projects.map(projectLine),
  ].join('\n');
}

/**
 * The human summary of a sign-in and its first run.
 *
 * @param login - The sign-in result.
 * @param r - The first run's outcome.
 * @returns One line, or a short block when projects are listed.
 */
export function nexusFirstRunSummary(login: NexusLoginResult, r: NexusFirstRunResult): string {
  const signedIn = nexusLoginSummary(login);
  const name = r.link?.label ? `"${r.link.label}"` : 'this project';
  switch (r.state) {
    case 'backed-up': {
      const snap = r.backup?.snapshot;
      const what =
        r.backup?.status === 'up-to-date'
          ? `the cloud already holds this state (snapshot ${snap?.checkpointId ?? 'none'})`
          : `snapshot ${snap?.checkpointId ?? 'unknown'}, ${snap?.rows ?? 0} rows`;
      return `Signed in, linked, backed up. ${signedIn} Project ${name} is linked and backed up (${what}).`;
    }
    case 'restored': {
      const what =
        r.restore?.status === 'up-to-date'
          ? 'this copy already held its newest backup'
          : `snapshot ${r.restore?.snapshot?.checkpointId ?? 'unknown'}, ${r.restore?.tables ?? 0} tables verified${r.restore?.safetyBackup ? `; the previous state is saved at ${r.restore.safetyBackup}` : ''}`;
      return `Signed in, restored, linked. ${signedIn} Project ${name} was restored from Cleo Nexus (${what}).`;
    }
    case 'restore-failed':
      return r.choices.length > 0
        ? `${signedIn} This copy has rows it never synced, so the backup was not restored. Choose one:\n${r.choices.map((c) => `  ${c.command}  (${c.effect})`).join('\n')}`
        : `${signedIn} Restoring this project's backup failed (see warnings). Next: ${r.nextCommand}`;
    case 'link-failed':
      return `${signedIn} Linking this project failed (see warnings). Next: ${r.nextCommand}`;
    case 'backup-failed':
      return `${signedIn} Project ${name} is linked, but the backup failed (see warnings). Next: ${r.nextCommand}`;
    case 'offered':
      return r.offer === 'restore'
        ? `${signedIn} Cleo Nexus holds a backup of this project that this copy never synced. To restore it here: ${r.nextCommand}`
        : `${signedIn} This project is not linked to Cleo Nexus. To link and back it up: ${r.nextCommand}`;
    case 'declined':
      return r.offer === 'restore'
        ? `${signedIn} Not restored. To restore its backup later: ${r.nextCommand}`
        : `${signedIn} Not linked. To link and back up later: ${r.nextCommand}`;
    case 'projects':
      return `${signedIn}${projectsBlock(r)}`;
    default:
      return signedIn;
  }
}

/**
 * `cleo login nexus`: sign in, run the guided first run, print its warnings
 * and next command to stderr, and emit the result (a first-run problem never
 * fails the sign-in; a sign-in failure exits non-zero through `failNexus`).
 *
 * @param args - Parsed citty args.
 * @param operation - LAFS operation id (`login.run`, `auth.login`, `llm.login`).
 * @param openBrowser - Browser opener for the device-code page.
 */
export async function runNexusLoginCommand(
  args: Args,
  operation: string,
  openBrowser: (url: string) => void,
): Promise<void> {
  let login: NexusLoginResult;
  try {
    login = await runNexusLogin(args, openBrowser);
  } catch (err) {
    failNexus(err, operation);
  }
  const firstRun = await runNexusFirstRunCli(args, login);
  for (const w of firstRun.warnings)
    process.stderr.write(`warning: ${terminalSafe(w.message)} (${w.code})\n`);
  if (!isHumanOutput()) {
    if (firstRun.nextCommand) process.stderr.write(`next: ${firstRun.nextCommand}\n`);
    for (const c of firstRun.choices) process.stderr.write(`choice: ${c.command}  (${c.effect})\n`);
  }
  emitNexusResult(
    { ...login, firstRun },
    nexusFirstRunSummary(login, firstRun),
    'login',
    operation,
  );
}

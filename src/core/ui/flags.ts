/**
 * Centralized flag parsing for CLEO CLI commands.
 *
 * Provides standardized flag handling: --json, --human, --quiet, --dry-run,
 * --verbose, --help, --force. Commands import and use these utilities.
 *
 * @task T4454
 * @epic T4454
 */

/** Parsed flag state. */
export interface ParsedFlags {
  format: 'json' | 'human' | '';
  quiet: boolean;
  dryRun: boolean;
  verbose: boolean;
  help: boolean;
  force: boolean;
  remaining: string[];
}

/** Default flag values. */
export function defaultFlags(): ParsedFlags {
  return {
    format: '',
    quiet: false,
    dryRun: false,
    verbose: false,
    help: false,
    force: false,
    remaining: [],
  };
}

/**
 * Parse common CLI flags from an argument array.
 * Returns flags and remaining positional arguments.
 */
export function parseCommonFlags(args: string[]): ParsedFlags {
  const flags = defaultFlags();
  const remaining: string[] = [];
  let i = 0;

  while (i < args.length) {
    const arg = args[i]!;

    switch (arg) {
      case '--json':
        flags.format = 'json';
        break;
      case '--human':
        flags.format = 'human';
        break;
      case '--format': {
        i++;
        const fmt = args[i];
        if (fmt === 'json' || fmt === 'human') {
          flags.format = fmt;
        }
        break;
      }
      case '--quiet':
      case '-q':
        flags.quiet = true;
        break;
      case '--dry-run':
        flags.dryRun = true;
        break;
      case '--verbose':
      case '-v':
        flags.verbose = true;
        break;
      case '--help':
      case '-h':
        flags.help = true;
        break;
      case '--force':
      case '-f':
        flags.force = true;
        break;
      case '--':
        // Everything after -- is positional
        remaining.push(...args.slice(i + 1));
        i = args.length; // break loop
        break;
      default:
        remaining.push(arg);
        break;
    }
    i++;
  }

  flags.remaining = remaining;
  return flags;
}

/**
 * Resolve output format based on flags and TTY detection.
 * Returns 'json' for non-TTY (piped), 'human' for TTY.
 */
export function resolveFormat(flagFormat: string): 'json' | 'human' {
  if (flagFormat === 'json' || flagFormat === 'human') return flagFormat;

  // Auto-detect: JSON for pipes, human for terminals
  return process.stdout.isTTY ? 'human' : 'json';
}

/** Check if output should be JSON. */
export function isJsonOutput(flags: ParsedFlags): boolean {
  return resolveFormat(flags.format) === 'json';
}

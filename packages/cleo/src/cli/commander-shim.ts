/**
 * Commander.js API shim for citty migration.
 *
 * Provides a minimal Commander-compatible Command class that captures
 * command definitions (name, args, options, actions, subcommands) without
 * any dependency on the `commander` package. The captured definitions are
 * then translated into citty commands by the entry point.
 *
 * Only the API surface actually used by the 90 command files is implemented:
 *   .command(nameAndArgs) → ShimCommand
 *   .description(desc) → this
 *   .option(flags, desc, parseOrDefault?, defaultVal?) → this
 *   .requiredOption(flags, desc) → this
 *   .alias(name) → this
 *   .action(fn) → this
 *   .allowUnknownOption() → this  (no-op, compatibility)
 *   .opts() → Record<string, unknown>
 *   .optsWithGlobals() → Record<string, unknown>
 *
 * Positional arguments are extracted from the command name string:
 *   'add <title>'       → name='add', args=[{name:'title', required:true}]
 *   'find [query]'      → name='find', args=[{name:'query', required:false}]
 *   'trend [days]'      → name='trend', args=[{name:'days', required:false}]
 */

/** Parsed option definition. */
export interface ShimOption {
  /** Long flag name (camelCase), e.g. 'dryRun' */
  longName: string;
  /** Short alias, e.g. 's' */
  shortName?: string;
  /** Whether it takes a value (vs boolean flag) */
  takesValue: boolean;
  /** Description text */
  description: string;
  /** Whether this option is required */
  required: boolean;
  /** Custom parse function (e.g. parseInt) */
  parseFn?: (val: string) => unknown;
  /** Default value */
  defaultValue?: unknown;
}

/** Positional argument definition. */
export interface ShimArg {
  name: string;
  required: boolean;
  variadic?: boolean;
}

/** Commander-compatible option view for tests. */
export interface CommanderCompatOption {
  long: string;
  required: boolean;
  defaultValue?: unknown;
}

/**
 * Type for the action handler function - flexible to support various signatures
 */
export type ActionHandler = (...args: unknown[]) => Promise<void> | void;

/**
 * Minimal Commander-compatible Command class.
 * Captures command definitions for later translation into citty commands.
 */
export class ShimCommand {
  _name = '';
  _description = '';
  _aliases: string[] = [];
  _options: ShimOption[] = [];
  _args: ShimArg[] = [];
  _action?: ActionHandler;
  _subcommands: ShimCommand[] = [];
  _parent?: ShimCommand;
  _isDefault = false;

  /** Commander-compatible property: list of registered subcommands. */
  get commands(): ShimCommand[] {
    return this._subcommands;
  }

  /** Commander-compatible property: options with .long, .required, .defaultValue */
  get options(): CommanderCompatOption[] {
    return this._options.map((o) => ({
      long: `--${camelToKebab(o.longName)}`,
      required: o.required,
      defaultValue: o.defaultValue,
    }));
  }

  /** Commander-compatible property: positional arguments with .required, .variadic */
  get registeredArguments(): ShimArg[] {
    return this._args;
  }

  constructor(name?: string) {
    if (name) {
      const parsed = parseCommandName(name);
      this._name = parsed.name;
      this._args = parsed.args;
    }
  }

  /** Register a subcommand. Returns the new subcommand for chaining. */
  command(nameAndArgs: string, opts?: { isDefault?: boolean }): ShimCommand {
    const sub = new ShimCommand(nameAndArgs);
    sub._parent = this;
    if (opts?.isDefault) sub._isDefault = true;
    this._subcommands.push(sub);
    return sub;
  }

  /** Set description (chaining). */
  description(desc: string): this;
  /** Get description (Commander compat). */
  description(): string;
  description(desc?: string): this | string {
    if (desc === undefined) {
      return this._description;
    }
    this._description = desc;
    return this;
  }

  alias(name: string): this {
    this._aliases.push(name);
    return this;
  }

  option(flags: string, description: string, parseOrDefault?: unknown, defaultVal?: unknown): this {
    const opt = parseOptionFlags(flags, description, false);
    if (typeof parseOrDefault === 'function') {
      opt.parseFn = parseOrDefault as (val: string) => unknown;
      if (defaultVal !== undefined) opt.defaultValue = defaultVal;
    } else if (parseOrDefault !== undefined) {
      opt.defaultValue = parseOrDefault;
    }
    this._options.push(opt);
    return this;
  }

  requiredOption(flags: string, description: string): this {
    const opt = parseOptionFlags(flags, description, true);
    this._options.push(opt);
    return this;
  }

  /**
   * Add a positional argument after command creation.
   * Commander compat: .argument('[name]', 'description')
   */
  argument(spec: string, _description?: string): this {
    if (spec.startsWith('<') && spec.endsWith('>')) {
      this._args.push({ name: spec.slice(1, -1), required: true });
    } else if (spec.startsWith('[') && spec.endsWith(']')) {
      this._args.push({ name: spec.slice(1, -1), required: false });
    }
    return this;
  }

  action<T extends (...args: any[]) => Promise<void> | void>(fn: T): this {
    this._action = fn as ActionHandler;
    return this;
  }

  /** No-op for Commander compatibility. citty handles unknown options gracefully. */
  allowUnknownOption(_allow?: boolean): this {
    return this;
  }

  /** No-op for Commander compatibility. */
  allowExcessArguments(_allow?: boolean): this {
    return this;
  }

  /** Get the command name. Commander compat method. */
  name(): string {
    return this._name;
  }

  /**
   * Return parsed global flags from process.argv.
   * Commander compat: returns parent + own options merged.
   */
  optsWithGlobals(): Record<string, unknown> {
    return parseGlobalFlagsFromArgv();
  }

  /**
   * Return parsed options. For shim purposes, same as optsWithGlobals().
   */
  opts(): Record<string, unknown> {
    return parseGlobalFlagsFromArgv();
  }
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse global flags from process.argv for opts()/optsWithGlobals() compat.
 * Extracts --json, --human, --quiet, --field, --fields, --mvi.
 */
function parseGlobalFlagsFromArgv(): Record<string, unknown> {
  const argv = process.argv.slice(2);
  const opts: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') opts['json'] = true;
    else if (arg === '--human') opts['human'] = true;
    else if (arg === '--quiet') opts['quiet'] = true;
    else if (arg === '--field' && i + 1 < argv.length) opts['field'] = argv[++i];
    else if (arg === '--fields' && i + 1 < argv.length) opts['fields'] = argv[++i];
    else if (arg === '--mvi' && i + 1 < argv.length) opts['mvi'] = argv[++i];
  }
  return opts;
}

/**
 * Parse a Commander-style command name string.
 * 'add <title>'  → { name: 'add', args: [{ name: 'title', required: true }] }
 * 'find [query]' → { name: 'find', args: [{ name: 'query', required: false }] }
 */
function parseCommandName(input: string): { name: string; args: ShimArg[] } {
  const parts = input.trim().split(/\s+/);
  const name = parts[0];
  const args: ShimArg[] = [];
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    if (part.startsWith('<') && part.endsWith('>')) {
      const inner = part.slice(1, -1);
      const variadic = inner.endsWith('...');
      args.push({ name: variadic ? inner.slice(0, -3) : inner, required: true, variadic });
    } else if (part.startsWith('[') && part.endsWith(']')) {
      const inner = part.slice(1, -1);
      const variadic = inner.endsWith('...');
      args.push({ name: variadic ? inner.slice(0, -3) : inner, required: false, variadic });
    }
  }
  return { name, args };
}

/**
 * Parse Commander-style option flags.
 * '-s, --status <status>'   → { longName: 'status', shortName: 's', takesValue: true }
 * '--dry-run'               → { longName: 'dryRun', takesValue: false }
 * '-d, --description <desc>'→ { longName: 'description', shortName: 'd', takesValue: true }
 */
function parseOptionFlags(flags: string, description: string, required: boolean): ShimOption {
  let shortName: string | undefined;
  let longName = '';
  let takesValue = false;

  // Check if there's a value placeholder like <status> or <desc>
  if (/<[^>]+>/.test(flags)) {
    takesValue = true;
  }

  // Extract short and long flags
  const flagParts = flags
    .replace(/<[^>]+>/, '')
    .trim()
    .split(/,\s*/);
  for (const part of flagParts) {
    const trimmed = part.trim();
    if (trimmed.startsWith('--')) {
      longName = kebabToCamel(trimmed.replace(/^--/, '').trim());
    } else if (trimmed.startsWith('-') && trimmed.length <= 3) {
      shortName = trimmed.replace(/^-/, '').trim();
    }
  }

  return { longName, shortName, takesValue, description, required };
}

/** Convert kebab-case to camelCase: 'dry-run' → 'dryRun' */
function kebabToCamel(str: string): string {
  return str.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/** Convert camelCase to kebab-case: 'dryRun' → 'dry-run' */
function camelToKebab(str: string): string {
  return str.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

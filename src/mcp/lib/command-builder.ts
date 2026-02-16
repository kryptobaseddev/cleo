/**
 * CLI Command Builder
 *
 * Constructs safe CLI commands with proper argument escaping and flag formatting.
 * Prevents shell injection attacks by properly escaping all arguments.
 *
 * @task T2914
 */

/**
 * Escape shell argument to prevent injection
 *
 * Wraps argument in single quotes and escapes any embedded single quotes.
 * This is safe for all shell interpreters (bash, sh, zsh).
 */
export function escapeArg(arg: string | number | boolean): string {
  // Convert to string
  const str = String(arg);

  // Escape single quotes by replacing ' with '\''
  // This closes the quote, adds an escaped quote, and reopens the quote
  const escaped = str.replace(/'/g, "'\\''");

  // Wrap in single quotes
  return `'${escaped}'`;
}

/**
 * Format CLI flags from key-value object
 *
 * Converts {json: true, parent: "T001"} to ["--json", "--parent", "T001"]
 */
export function formatFlags(flags: Record<string, unknown>): string[] {
  const result: string[] = [];

  for (const [key, value] of Object.entries(flags)) {
    // Skip undefined/null values
    if (value === undefined || value === null) {
      continue;
    }

    // Boolean flags
    if (typeof value === 'boolean') {
      if (value === true) {
        result.push(`--${key}`);
      }
      // Skip false boolean flags (don't add anything)
      continue;
    }

    // Array flags (multiple values)
    if (Array.isArray(value)) {
      for (const item of value) {
        result.push(`--${key}`, escapeArg(item as string | number | boolean));
      }
      continue;
    }

    // Object flags (JSON stringify)
    if (typeof value === 'object') {
      result.push(`--${key}`, escapeArg(JSON.stringify(value)));
      continue;
    }

    // Regular flags (string/number)
    result.push(`--${key}`, escapeArg(value as string | number | boolean));
  }

  return result;
}

/**
 * Map domain+operation to CLI command
 *
 * Maps MCP domain/operation pairs to the actual CLI command structure.
 * For example: domain='tasks', operation='add' -> command='add', addOperationAsSubcommand=false
 */
export function mapDomainToCommand(domain: string, operation: string): { command: string; addOperationAsSubcommand: boolean } {
  // Domain aliases used by legacy handlers/comments that should resolve to
  // canonical CLI commands.
  const domainAliases: Record<string, { command: string; addOperationAsSubcommand: boolean }> = {
    depends: { command: 'deps', addOperationAsSubcommand: true },
    import: { command: 'import-tasks', addOperationAsSubcommand: true },
    lint: { command: 'validate', addOperationAsSubcommand: true },
    skill: { command: 'skills', addOperationAsSubcommand: true },
    version: { command: 'version', addOperationAsSubcommand: false },
  };

  if (domainAliases[domain]) {
    return domainAliases[domain];
  }

  // For tasks domain, the operation IS the command
  // For session/lifecycle domains, we need both (e.g., 'session start')
  const domainOperationMap: Record<string, Record<string, { command: string; addOperationAsSubcommand: boolean }>> = {
    tasks: {
      show: { command: 'show', addOperationAsSubcommand: false },
      list: { command: 'list', addOperationAsSubcommand: false },
      find: { command: 'find', addOperationAsSubcommand: false },
      add: { command: 'add', addOperationAsSubcommand: false },
      update: { command: 'update', addOperationAsSubcommand: false },
      complete: { command: 'complete', addOperationAsSubcommand: false },
      delete: { command: 'delete', addOperationAsSubcommand: false },
      archive: { command: 'archive', addOperationAsSubcommand: false },
      unarchive: { command: 'unarchive', addOperationAsSubcommand: false },
      restore: { command: 'restore', addOperationAsSubcommand: false },
      reopen: { command: 'reopen', addOperationAsSubcommand: false },
      exists: { command: 'exists', addOperationAsSubcommand: false },
      next: { command: 'next', addOperationAsSubcommand: false },
      deps: { command: 'deps show', addOperationAsSubcommand: false },
      blockers: { command: 'blockers', addOperationAsSubcommand: false },
      tree: { command: 'tree', addOperationAsSubcommand: false },
      analyze: { command: 'analyze', addOperationAsSubcommand: false },
    },
    session: {
      start: { command: 'session', addOperationAsSubcommand: true },
      end: { command: 'session', addOperationAsSubcommand: true },
      status: { command: 'session', addOperationAsSubcommand: true },
      list: { command: 'session', addOperationAsSubcommand: true },
      show: { command: 'session', addOperationAsSubcommand: true },
      focus: { command: 'focus', addOperationAsSubcommand: false },
      suspend: { command: 'session', addOperationAsSubcommand: true },
      resume: { command: 'session', addOperationAsSubcommand: true },
      history: { command: 'session', addOperationAsSubcommand: true },
      archive: { command: 'session', addOperationAsSubcommand: true },
      cleanup: { command: 'session', addOperationAsSubcommand: true },
      doctor: { command: 'session', addOperationAsSubcommand: true },
      switch: { command: 'session', addOperationAsSubcommand: true },
      // Compound focus operations from MCP (session.focus.set → cleo focus set)
      'focus.set': { command: 'focus set', addOperationAsSubcommand: false },
      'focus.clear': { command: 'focus clear', addOperationAsSubcommand: false },
      'focus.get': { command: 'focus show', addOperationAsSubcommand: false },
      'focus.show': { command: 'focus show', addOperationAsSubcommand: false },
      'focus.note': { command: 'focus note', addOperationAsSubcommand: false },
      'focus.next': { command: 'focus next', addOperationAsSubcommand: false },
    },
    // Focus operations mapped to 'cleo focus <subcommand>'
    // These handle 'focus.set' / 'focus.clear' / 'focus.get' operations
    // from the session domain in MCP
    focus: {
      set: { command: 'focus', addOperationAsSubcommand: true },
      clear: { command: 'focus', addOperationAsSubcommand: true },
      show: { command: 'focus', addOperationAsSubcommand: true },
      get: { command: 'focus show', addOperationAsSubcommand: false },
      note: { command: 'focus', addOperationAsSubcommand: true },
      next: { command: 'focus', addOperationAsSubcommand: true },
    },
    lifecycle: {
      status: { command: 'lifecycle show', addOperationAsSubcommand: false },
      show: { command: 'lifecycle show', addOperationAsSubcommand: false },
      stages: { command: 'lifecycle show', addOperationAsSubcommand: false },
      validate: { command: 'lifecycle gate', addOperationAsSubcommand: false },
      record: { command: 'lifecycle complete', addOperationAsSubcommand: false },
      start: { command: 'lifecycle start', addOperationAsSubcommand: false },
      complete: { command: 'lifecycle complete', addOperationAsSubcommand: false },
      enforce: { command: 'lifecycle gate', addOperationAsSubcommand: false },
      skip: { command: 'lifecycle skip', addOperationAsSubcommand: false },
      unskip: { command: 'lifecycle', addOperationAsSubcommand: true },
      report: { command: 'lifecycle show', addOperationAsSubcommand: false },
      export: { command: 'lifecycle', addOperationAsSubcommand: true },
      import: { command: 'lifecycle', addOperationAsSubcommand: true },
      // Map MCP operation aliases to CLI equivalents
      progress: { command: 'lifecycle complete', addOperationAsSubcommand: false },
      check: { command: 'lifecycle gate', addOperationAsSubcommand: false },
      gate: { command: 'lifecycle gate', addOperationAsSubcommand: false },
      gates: { command: 'lifecycle show', addOperationAsSubcommand: false },
      prerequisites: { command: 'lifecycle show', addOperationAsSubcommand: false },
      history: { command: 'lifecycle show', addOperationAsSubcommand: false },
      reset: { command: 'lifecycle start', addOperationAsSubcommand: false },
      'gate.pass': { command: 'lifecycle gate', addOperationAsSubcommand: false },
      'gate.fail': { command: 'lifecycle gate', addOperationAsSubcommand: false },
    },
    // Orchestrate domain maps to 'cleo orchestrate <subcommand>'
    orchestrate: {
      analyze: { command: 'orchestrate', addOperationAsSubcommand: true },
      start: { command: 'orchestrate', addOperationAsSubcommand: true },
      startup: { command: 'orchestrate start', addOperationAsSubcommand: false },
      status: { command: 'orchestrate context', addOperationAsSubcommand: false },
      next: { command: 'orchestrate', addOperationAsSubcommand: true },
      ready: { command: 'orchestrate', addOperationAsSubcommand: true },
      spawn: { command: 'orchestrate', addOperationAsSubcommand: true },
      waves: { command: 'orchestrate analyze', addOperationAsSubcommand: false },
      parallel: { command: 'orchestrate ready', addOperationAsSubcommand: false },
      check: { command: 'orchestrate validate', addOperationAsSubcommand: false },
      validate: { command: 'orchestrate', addOperationAsSubcommand: true },
      context: { command: 'orchestrate', addOperationAsSubcommand: true },
      skill: { command: 'orchestrate', addOperationAsSubcommand: true },
    },
    // Research domain maps to 'cleo research <subcommand>'
    research: {
      link: { command: 'research', addOperationAsSubcommand: true },
      links: { command: 'research', addOperationAsSubcommand: true },
      unlink: { command: 'research', addOperationAsSubcommand: true },
      list: { command: 'research', addOperationAsSubcommand: true },
      show: { command: 'research', addOperationAsSubcommand: true },
      get: { command: 'research', addOperationAsSubcommand: true },
      add: { command: 'research', addOperationAsSubcommand: true },
      query: { command: 'research', addOperationAsSubcommand: false },
      stats: { command: 'research manifest', addOperationAsSubcommand: false },
      pending: { command: 'research', addOperationAsSubcommand: true },
      inject: { command: 'research', addOperationAsSubcommand: true },
      archive: { command: 'research', addOperationAsSubcommand: true },
      'archive-list': { command: 'research', addOperationAsSubcommand: true },
      status: { command: 'research', addOperationAsSubcommand: true },
      compact: { command: 'research', addOperationAsSubcommand: true },
      validate: { command: 'research', addOperationAsSubcommand: true },
      // Manifest sub-operations map to actual CLI subcommands
      'manifest.append': { command: 'research add', addOperationAsSubcommand: false },
      'manifest.read': { command: 'research list', addOperationAsSubcommand: false },
      'manifest.archive': { command: 'research archive', addOperationAsSubcommand: false },
    },
    system: {
      version: { command: 'version', addOperationAsSubcommand: false },
      config: { command: 'config', addOperationAsSubcommand: false },
      backup: { command: 'backup', addOperationAsSubcommand: false },
      cleanup: { command: 'cleanup', addOperationAsSubcommand: false },
      doctor: { command: 'doctor', addOperationAsSubcommand: false },
      stats: { command: 'stats', addOperationAsSubcommand: false },
      context: { command: 'context', addOperationAsSubcommand: false },
    },
    validate: {
      schema: { command: 'validate', addOperationAsSubcommand: false },
      task: { command: 'validate', addOperationAsSubcommand: false },
      compliance: { command: 'compliance', addOperationAsSubcommand: false },
      test: { command: 'test', addOperationAsSubcommand: false },
    },
  };

  const mapping = domainOperationMap[domain]?.[operation];

  if (mapping) {
    return mapping;
  }

  // Handle compound operations (e.g., 'focus.set' in 'session' domain)
  // Split on first dot and try to resolve via a sub-domain
  if (operation.includes('.')) {
    const dotIndex = operation.indexOf('.');
    const subDomain = operation.substring(0, dotIndex);
    const subOp = operation.substring(dotIndex + 1);
    // Check if there's a dedicated domain for the sub-operation
    const subMapping = domainOperationMap[subDomain]?.[subOp];
    if (subMapping) {
      return subMapping;
    }
  }

  // Default: use domain as command, operation as subcommand
  return { command: domain, addOperationAsSubcommand: true };
}

/**
 * Build complete CLI command
 *
 * @param cliPath - Path to CLEO CLI executable
 * @param domain - Domain name (e.g., 'tasks', 'session') OR direct command (e.g., 'show', 'add')
 * @param operation - Operation name (e.g., 'show', 'list') OR first argument
 * @param args - Positional arguments
 * @param flags - Named flags/options
 * @returns Complete command string ready for execution
 *
 * @example
 * ```typescript
 * buildCLICommand('cleo', 'tasks', 'show', ['T2914'], {json: true})
 * // Returns: "cleo show 'T2914' --json"
 *
 * buildCLICommand('cleo', 'show', 'T2914', [], {json: true})
 * // Returns: "cleo show 'T2914' --json"
 * ```
 */
export function buildCLICommand(
  cliPath: string,
  domain: string,
  operation: string,
  args: Array<string | number> = [],
  flags: Record<string, unknown> = {}
): string {
  const parts: string[] = [cliPath];

  // Check if we need to map domain+operation to CLI command
  // This handles E2E tests that use domain='tasks', operation='add'
  // versus domain handlers that use domain='add', operation=title
  // Valid CLI commands that can be used directly as the first command word.
  // These are commands where domain IS the command itself (e.g., domain='add', operation='My Task Title').
  // Do NOT include domain names that need mapDomainToCommand lookup (like 'session', 'lifecycle',
  // 'orchestrate', 'research', 'tasks', 'focus', 'system', 'validate').
  const validCliCommands = [
    'add', 'list', 'show', 'find', 'update', 'complete', 'delete', 'archive',
    'restore', 'exists', 'next', 'version', 'dash', 'analyze', 'config',
    'backup', 'init', 'blockers', 'deps', 'tree',
  ];

  if (!validCliCommands.includes(domain)) {
    // This looks like domain='tasks', operation='add' pattern from E2E tests
    // Map it to the proper CLI command
    const mapping = mapDomainToCommand(domain, operation);
    parts.push(mapping.command);

    // For commands that need the operation as a subcommand (session, lifecycle)
    if (mapping.addOperationAsSubcommand) {
      parts.push(escapeArg(operation));
    }
    // For tasks domain, the operation IS already the command, so don't add it again
  } else {
    // This is already a direct CLI command (domain='add', operation=title)
    parts.push(domain);

    // Add operation (may be user-controlled, e.g., task title, so escape it)
    if (operation) {
      parts.push(escapeArg(operation));
    }
  }

  // Add positional arguments (escaped)
  for (const arg of args) {
    parts.push(escapeArg(arg));
  }

  // Add flags (escaped)
  const flagParts = formatFlags(flags);
  parts.push(...flagParts);

  return parts.join(' ');
}

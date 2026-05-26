/**
 * CLI idempotency-key context.
 *
 * The root CLI parser strips the global `--idempotency-key` flag before citty
 * validates leaf-command arguments, then stores the value here so every
 * dispatch-routed mutating command can receive the key without duplicating the
 * flag in each command module.
 */

let currentIdempotencyKey: string | undefined;

/**
 * Set the idempotency key parsed from the current CLI invocation.
 *
 * @param key - Optional caller-provided retry token.
 */
export function setIdempotencyKeyContext(key: string | undefined): void {
  currentIdempotencyKey = key;
}

/**
 * Read the idempotency key parsed from the current CLI invocation.
 *
 * @returns The idempotency key, when one was supplied.
 */
export function getIdempotencyKeyContext(): string | undefined {
  return currentIdempotencyKey;
}

/**
 * Remove the global `--idempotency-key` flag from an argv vector.
 *
 * Supports both `--idempotency-key value` and `--idempotency-key=value` forms.
 * The returned argv can be passed to citty without requiring every leaf command
 * to declare the same global flag.
 *
 * @param argv - Raw process argv tokens after the executable and script name.
 * @returns The sanitized argv plus the parsed key, if present.
 */
export function extractIdempotencyKeyArg(argv: string[]): {
  argv: string[];
  idempotencyKey?: string;
} {
  const sanitized: string[] = [];
  let idempotencyKey: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--idempotency-key') {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        idempotencyKey = next;
        i++;
      }
      continue;
    }

    if (token?.startsWith('--idempotency-key=')) {
      idempotencyKey = token.slice('--idempotency-key='.length);
      continue;
    }

    if (token !== undefined) sanitized.push(token);
  }

  return { argv: sanitized, idempotencyKey };
}

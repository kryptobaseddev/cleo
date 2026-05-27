/**
 * Format utility functions
 */

/**
 * Deep merge two objects, with `source` values winning on conflict.
 *
 * Recursively merges nested plain objects. Arrays and non-object values from
 * `source` overwrite `target` values.
 *
 * @param target - Base object to merge into
 * @param source - Object with values that take precedence
 * @returns A new merged object (does not mutate inputs)
 *
 * @remarks
 * Only plain objects are recursively merged. Arrays and primitive values from
 * `source` replace `target` values outright. Neither input is mutated.
 *
 * @example
 * ```typescript
 * const merged = deepMerge({ a: 1, b: { c: 2 } }, { b: { d: 3 } });
 * // { a: 1, b: { c: 2, d: 3 } }
 * ```
 *
 * @public
 */
export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };

  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = target[key];

    if (
      sourceVal !== null &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal) &&
      targetVal !== null &&
      typeof targetVal === 'object' &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      );
    } else {
      result[key] = sourceVal;
    }
  }

  return result;
}

/**
 * Set a nested value using a dot-notation key path.
 *
 * @remarks
 * Creates intermediate objects as needed. Returns a shallow copy of the
 * root object (does not mutate the input).
 *
 * @param obj - Root object to modify
 * @param keyPath - Dot-separated path to the parent key (e.g. `"mcpServers"`)
 * @param key - Final key name for the value
 * @param value - Value to set at the nested location
 * @returns A new object with the value set at the specified path
 *
 * @example
 * ```typescript
 * const result = setNestedValue({}, "a.b", "c", 42);
 * // { a: { b: { c: 42 } } }
 * ```
 *
 * @public
 */
export function setNestedValue(
  obj: Record<string, unknown>,
  keyPath: string,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const parts = keyPath.split('.');
  const result = { ...obj };
  let current: Record<string, unknown> = result;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === undefined) continue;
    if (i === parts.length - 1) {
      // Last part: set the server entry
      const existing = (current[part] as Record<string, unknown>) ?? {};
      current[part] = { ...existing, [key]: value };
    } else {
      // Intermediate: ensure object exists
      if (typeof current[part] !== 'object' || current[part] === null) {
        current[part] = {};
      }
      current[part] = { ...(current[part] as Record<string, unknown>) };
      current = current[part] as Record<string, unknown>;
    }
  }

  return result;
}

/**
 * Get a nested value from an object using a dot-notation key path.
 *
 * @param obj - Object to traverse
 * @param keyPath - Dot-separated key path (e.g. `"mcpServers"` or `"a.b.c"`)
 * @returns The value at the key path, or `undefined` if not found
 *
 * @remarks
 * Splits the key path on `.` and walks the object tree. Returns `undefined`
 * at the first missing or non-object segment.
 *
 * @example
 * ```typescript
 * getNestedValue({ a: { b: { c: 42 } } }, "a.b.c"); // 42
 * getNestedValue({ a: 1 }, "a.b"); // undefined
 * ```
 *
 * @public
 */
export function getNestedValue(obj: Record<string, unknown>, keyPath: string): unknown {
  const parts = keyPath.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Ensure that the parent directories of a file path exist.
 *
 * Creates directories recursively if they do not exist.
 *
 * @param filePath - Absolute path to a file (parent directories will be created)
 *
 * @remarks
 * Uses `mkdir` with `recursive: true` so existing directories are not an error.
 *
 * @example
 * ```typescript
 * await ensureDir("/path/to/new/dir/file.json");
 * // /path/to/new/dir/ now exists
 * ```
 *
 * @public
 */
export async function ensureDir(filePath: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(filePath), { recursive: true });
}

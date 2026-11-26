/**
 * The CANT parse check the CLI hands to core's agent doctor (T14655).
 *
 * Core cannot depend on `@cleocode/cant` (it depends on core), so `cleo agent
 * doctor`, `cleo upgrade` and `cleo self-update` pass this function instead.
 * The parser is imported on first use, inside the check: when the native
 * addon cannot load, the doctor records one D-012 finding and the rest of the
 * run carries on instead of aborting.
 *
 * @module cli/lib/cant-parses
 */

/**
 * Whether the `.cant` file at `cantPath` parses with the current CANT grammar.
 *
 * @param cantPath - Absolute path of the `.cant` file.
 * @returns `true` when it parses.
 * @throws When `@cleocode/cant` cannot be imported (the doctor reports D-012).
 */
export async function cantParses(cantPath: string): Promise<boolean> {
  const { parseDocument } = await import('@cleocode/cant');
  return (await parseDocument(cantPath)).success;
}

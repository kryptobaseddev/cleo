/**
 * Lazy command wrapper for citty.
 *
 * Wraps a `CommandDef` loader so the underlying command module is imported
 * only when the user actually runs that command. The wrapper itself carries
 * a static `meta` so help rendering and command discovery work without
 * triggering 111 module loads.
 *
 * @remarks
 * Citty's `runCommand` resolves `cmd.args`, `cmd.subCommands`, and `cmd.run`
 * via `resolveValue(input)` which awaits any function/promise. By making
 * those three fields lazy thunks, the wrapper defers all module work until
 * the matched subcommand is executed:
 *
 * - `cleo --version`         → no command match → no command modules load
 * - `cleo --help`            → iterates `subCommands` reading `.meta` only → no loads
 * - `cleo find query`        → matches `find` → loads `commands/find.js` → resolves args + run
 * - `cleo deps tree --epic`  → matches `deps` → loads `commands/deps.js` → which itself
 *                              has nested subCommands; those are NOT lazy because deps already
 *                              loaded its full tree, but only that one tree.
 */

import type { CommandDef } from 'citty';

/**
 * Build a lazy wrapper around a command loader.
 *
 * @param meta   - Static metadata visible to help rendering without loading the module.
 * @param loader - Async factory returning the real `CommandDef`.
 * @returns A `CommandDef` whose `args`, `subCommands`, `setup`, `cleanup`, and `run`
 *          are all gated behind a single shared `loader()` promise.
 */
export function lazyCommand(
  meta: { name: string; description: string },
  loader: () => Promise<CommandDef>,
): CommandDef {
  let promise: Promise<CommandDef> | null = null;
  const load = (): Promise<CommandDef> => {
    promise ??= loader();
    return promise;
  };

  return {
    meta,
    args: (async () => {
      const cmd = await load();
      return cmd.args ?? {};
    }) as unknown as CommandDef['args'],
    subCommands: (async () => {
      const cmd = await load();
      return cmd.subCommands ?? {};
    }) as unknown as CommandDef['subCommands'],
    async setup(ctx) {
      const cmd = await load();
      if (typeof cmd.setup === 'function') await cmd.setup({ ...ctx, cmd });
    },
    async cleanup(ctx) {
      const cmd = await load();
      if (typeof cmd.cleanup === 'function') await cmd.cleanup({ ...ctx, cmd });
    },
    async run(ctx) {
      const cmd = await load();
      // Pass the LOADED cmd as ctx.cmd so parent run blocks that introspect
      // `cmd.subCommands` (e.g. `firstArg in cmd.subCommands`) see the real
      // nested map instead of the lazy wrapper's thunk.
      if (typeof cmd.run === 'function') return cmd.run({ ...ctx, cmd });
    },
  };
}

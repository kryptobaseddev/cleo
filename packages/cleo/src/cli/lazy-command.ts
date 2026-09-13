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
import { assertKnownFlags, type CittyArgsSchema, UnknownFlagError } from './lib/strict-args.js';

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

      // T12139 (GH #1245) — strict unknown-flag validation for EVERY command
      // that reaches this chokepoint.
      //
      // citty's parseArgs is called with `strict: false` and no public knob, so
      // an unknown flag is silently absorbed as a positional. That is how
      // `cleo list --severity P0` returned all 3,173 tasks: the flag did not
      // exist, nothing rejected it, and the unfiltered result was
      // indistinguishable from a successful narrow query.
      //
      // `assertKnownFlags` has existed since T10359 and produces exactly the
      // error contract wanted here — typed `E_UNKNOWN_FLAG`, Levenshtein
      // did-you-mean, `--` terminator and `=value` handling. It was wired to
      // ONE command (`docs`). This applies it generically instead.
      //
      // MUST pass the LOADED `cmd.args`, never this wrapper's `args` thunk.
      // The wrapper exposes `args` as an async function so the module stays
      // unloaded until needed, and `assertKnownFlags` deliberately bails out
      // on a resolvable schema rather than throwing — so handing it the thunk
      // would produce a guard that silently guards NOTHING, reintroducing the
      // exact defect this validation exists to remove. Do not "simplify" this
      // to `ctx.cmd.args` or to the wrapper's own `args`.
      try {
        assertKnownFlags(ctx.rawArgs, cmd.args as CittyArgsSchema, meta.name);
      } catch (err) {
        if (err instanceof UnknownFlagError) {
          // Render through the same path `docs` has used since T10359, so the
          // error contract is identical whichever command produced it. The
          // renderer is imported dynamically: this branch is the error path,
          // and `lazy-command.ts` is on the hot startup path for EVERY
          // invocation — an eager import would charge the renderer's load cost
          // to the 99.9% of calls that pass valid flags.
          const { cliError } = await import('./renderers/index.js');
          const { ExitCode } = await import('@cleocode/contracts');
          cliError(err.message, ExitCode.VALIDATION_ERROR, {
            name: err.code,
            fix: err.fix,
            // `knownFlags` is the command's full accepted surface — the
            // did-you-mean suggestions alone do not tell a caller what IS
            // valid, only what is close to what they typed.
            alternatives: err.knownFlags.map((f) => ({
              action: `${meta.name} ${f}`,
              command: `cleo ${meta.name} ${f}`,
            })),
          });
          process.exit(ExitCode.VALIDATION_ERROR);
        }
        throw err;
      }

      // Pass the LOADED cmd as ctx.cmd so parent run blocks that introspect
      // `cmd.subCommands` (e.g. `firstArg in cmd.subCommands`) see the real
      // nested map instead of the lazy wrapper's thunk.
      if (typeof cmd.run === 'function') return cmd.run({ ...ctx, cmd });
    },
  };
}

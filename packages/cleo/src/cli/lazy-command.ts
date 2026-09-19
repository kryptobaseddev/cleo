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

import type { CommandDef, Resolvable } from 'citty';
import { assertKnownFlags, UnknownFlagError } from './lib/strict-args.js';

/** Resolve Citty's supported value, promise, and factory command declarations. */
async function resolveCommandValue<T>(value: Resolvable<T> | undefined): Promise<T | undefined> {
  return typeof value === 'function' ? (value as () => T | Promise<T>)() : value;
}

/** Preflight the selected command path before any setup or child mutation executes. */
async function validateCommandPath(
  command: CommandDef,
  rawArgs: string[],
  label: string,
): Promise<void> {
  const schema = await resolveCommandValue(command.args);
  const children = await resolveCommandValue(command.subCommands);
  // Match Citty's own dispatch rule: the first non-flag token selects the child.
  const childIndex = rawArgs.findIndex((argument) => !argument.startsWith('-'));
  const childName = rawArgs[childIndex];
  const child =
    childName && children?.[childName] ? await resolveCommandValue(children[childName]) : undefined;
  if (child) {
    assertKnownFlags(rawArgs.slice(0, childIndex), schema, label);
    await validateCommandPath(child, rawArgs.slice(childIndex + 1), `${label} ${childName}`);
  } else {
    assertKnownFlags(rawArgs, schema, label);
  }
}

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

  const validate = async (cmd: CommandDef, rawArgs: string[]): Promise<void> => {
    try {
      await validateCommandPath(cmd, rawArgs, meta.name);
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
            action: `${err.command} ${f}`,
            command: `cleo ${err.command} ${f}`,
          })),
        });
        process.exit(ExitCode.VALIDATION_ERROR);
      }
      throw err;
    }
  };

  return {
    meta,
    args: async () => {
      const cmd = await load();
      return (await resolveCommandValue(cmd.args)) ?? {};
    },
    subCommands: async () => {
      const cmd = await load();
      return (await resolveCommandValue(cmd.subCommands)) ?? {};
    },
    async setup(ctx) {
      const cmd = await load();
      await validate(cmd, ctx.rawArgs);
      if (typeof cmd.setup === 'function') await cmd.setup({ ...ctx, cmd });
    },
    async cleanup(ctx) {
      const cmd = await load();
      if (typeof cmd.cleanup === 'function') await cmd.cleanup({ ...ctx, cmd });
    },
    async run(ctx) {
      const cmd = await load();

      await validate(cmd, ctx.rawArgs);

      // Pass the LOADED cmd as ctx.cmd so parent run blocks that introspect
      // `cmd.subCommands` (e.g. `firstArg in cmd.subCommands`) see the real
      // nested map instead of the lazy wrapper's thunk.
      if (typeof cmd.run === 'function') return cmd.run({ ...ctx, cmd });
    },
  };
}

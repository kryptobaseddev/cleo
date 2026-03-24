/**
 * instructions check command - LAFS-compliant with JSON-first output
 */

import type { Command } from "commander";
import pc from "picocolors";
import { checkAllInjections } from "../../core/instructions/injector.js";
import {
  ErrorCategories,
  ErrorCodes,
  emitJsonError,
  outputSuccess,
  resolveFormat,
} from "../../core/lafs.js";
import { getInstalledProviders } from "../../core/registry/detection.js";
import { getAllProviders, getProvider } from "../../core/registry/providers.js";
import type { Provider } from "../../types.js";

/**
 * Registers the `instructions check` subcommand for verifying injection status across providers.
 *
 * @remarks
 * Checks whether CAAMP injection markers are present and up-to-date in provider instruction files.
 * Reports missing, outdated, or current injection status for each provider.
 *
 * @param parent - The parent `instructions` Command to attach the check subcommand to
 *
 * @example
 * ```bash
 * caamp instructions check --human
 * caamp instructions check --agent claude-code
 * ```
 *
 * @public
 */
export function registerInstructionsCheck(parent: Command): void {
  parent
    .command("check")
    .description("Check injection status across providers")
    .option("-a, --agent <name>", "Check specific agent(s)", (v, prev: string[]) => [...prev, v], [])
    .option("-g, --global", "Check global instruction files")
    .option("--json", "Output as JSON (default)")
    .option("--human", "Output in human-readable format")
    .option("--all", "Check all known providers")
    .action(async (opts: {
      agent: string[];
      global?: boolean;
      json?: boolean;
      human?: boolean;
      all?: boolean;
    }) => {
      const operation = "instructions.check";
      const mvi: import("../../core/lafs.js").MVILevel = "standard";

      let format: "json" | "human";
      try {
        format = resolveFormat({
          jsonFlag: opts.json ?? false,
          humanFlag: opts.human ?? false,
          projectDefault: "json",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emitJsonError(operation, mvi, ErrorCodes.FORMAT_CONFLICT, message, ErrorCategories.VALIDATION);
        process.exit(1);
      }

      let providers: Provider[];

      if (opts.all) {
        providers = getAllProviders();
      } else if (opts.agent.length > 0) {
        providers = opts.agent
          .map((a) => getProvider(a))
          .filter((p): p is Provider => p !== undefined);
      } else {
        providers = getInstalledProviders();
      }

      const scope = opts.global ? "global" as const : "project" as const;
      const results = await checkAllInjections(providers, process.cwd(), scope);

      // Build provider status for result
      const providerStatus = results.map((r) => ({
        id: r.provider,
        present: r.status === "current" || r.status === "outdated",
        path: r.file,
      }));

      const present = providerStatus.filter((p) => p.present).length;
      const missing = providerStatus.filter((p) => !p.present).length;

      if (format === "json") {
        outputSuccess(operation, mvi, {
          providers: providerStatus,
          present,
          missing,
        });
        return;
      }

      // Human-readable output
      console.log(pc.bold(`\nInstruction file status (${scope}):\n`));

      for (const r of results) {
        let icon: string;
        let label: string;

        switch (r.status) {
          case "current":
            icon = pc.green("✓");
            label = "current";
            break;
          case "outdated":
            icon = pc.yellow("~");
            label = "outdated";
            break;
          case "missing":
            icon = pc.red("✗");
            label = "missing";
            break;
          case "none":
            icon = pc.dim("-");
            label = "no injection";
            break;
        }

        console.log(`  ${icon} ${r.file.padEnd(40)} ${label}`);
      }

      console.log();
    });
}

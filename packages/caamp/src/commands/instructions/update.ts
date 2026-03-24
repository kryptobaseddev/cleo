/**
 * instructions update command - LAFS-compliant with JSON-first output
 */

import type { Command } from "commander";
import pc from "picocolors";
import { checkAllInjections, injectAll } from "../../core/instructions/injector.js";
import { generateInjectionContent } from "../../core/instructions/templates.js";
import {
  ErrorCategories,
  ErrorCodes,
  emitJsonError,
  outputSuccess,
  resolveFormat,
} from "../../core/lafs.js";
import { getInstalledProviders } from "../../core/registry/detection.js";

/**
 * Registers the `instructions update` subcommand for refreshing all instruction file injections.
 *
 * @remarks
 * Re-generates and updates CAAMP injection blocks in all detected provider instruction files.
 * Checks for stale injections first and only updates those that have changed.
 *
 * @param parent - The parent `instructions` Command to attach the update subcommand to
 *
 * @example
 * ```bash
 * caamp instructions update --yes
 * caamp instructions update --global --json
 * ```
 *
 * @public
 */
export function registerInstructionsUpdate(parent: Command): void {
  parent
    .command("update")
    .description("Update all instruction file injections")
    .option("-g, --global", "Update global instruction files")
    .option("-y, --yes", "Skip confirmation")
    .option("--json", "Output as JSON (default)")
    .option("--human", "Output in human-readable format")
    .action(async (opts: { global?: boolean; yes?: boolean; json?: boolean; human?: boolean }) => {
      const operation = "instructions.update";
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

      const providers = getInstalledProviders();
      const scope = opts.global ? "global" as const : "project" as const;
      const content = generateInjectionContent();

      // Check current state
      const checks = await checkAllInjections(providers, process.cwd(), scope, content);
      const needsUpdate = checks.filter((c) => c.status !== "current");

      if (needsUpdate.length === 0) {
        if (format === "json") {
          outputSuccess(operation, mvi, {
            updated: [],
            failed: [],
            count: { updated: 0, failed: 0 },
          });
        } else {
          console.log(pc.green("All instruction files are up to date."));
        }
        return;
      }

      if (format === "human") {
        console.log(pc.bold(`${needsUpdate.length} file(s) need updating:\n`));
        for (const c of needsUpdate) {
          console.log(`  ${c.file} (${c.status})`);
        }
      }

      // Filter providers to only those needing updates
      const providerIds = new Set(needsUpdate.map((c) => c.provider));
      const toUpdate = providers.filter((p) => providerIds.has(p.id));

      const results = await injectAll(toUpdate, process.cwd(), scope, content);

      const updated: string[] = [];
      for (const [file] of results) {
        updated.push(file);
      }

      if (format === "human") {
        console.log();
        for (const [file, action] of results) {
          console.log(`  ${pc.green("✓")} ${file} (${action})`);
        }
        console.log(pc.bold(`\n${results.size} file(s) updated.`));
      }

      if (format === "json") {
        outputSuccess(operation, mvi, {
          updated,
          failed: [],
          count: { updated: updated.length, failed: 0 },
        });
      }
    });
}

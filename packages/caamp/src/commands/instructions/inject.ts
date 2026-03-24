/**
 * instructions inject command - LAFS-compliant with JSON-first output
 */

import type { Command } from "commander";
import pc from "picocolors";
import { injectAll } from "../../core/instructions/injector.js";
import { generateInjectionContent, groupByInstructFile } from "../../core/instructions/templates.js";
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
 * Registers the `instructions inject` subcommand for injecting instruction blocks into provider files.
 *
 * @remarks
 * Writes CAAMP-managed instruction blocks into provider instruction files using marker-based
 * injection. Supports custom content, dry-run preview, and targeting specific or all providers.
 *
 * @param parent - The parent `instructions` Command to attach the inject subcommand to
 *
 * @example
 * ```bash
 * caamp instructions inject --all --global
 * caamp instructions inject --agent claude-code --dry-run
 * ```
 *
 * @public
 */
export function registerInstructionsInject(parent: Command): void {
  parent
    .command("inject")
    .description("Inject instruction blocks into all provider files")
    .option("-a, --agent <name>", "Target specific agent(s)", (v, prev: string[]) => [...prev, v], [])
    .option("-g, --global", "Inject into global instruction files")
    .option("--content <text>", "Custom content to inject")
    .option("--dry-run", "Preview without writing")
    .option("--all", "Target all known providers")
    .option("--json", "Output as JSON (default)")
    .option("--human", "Output in human-readable format")
    .action(async (opts: {
      agent: string[];
      global?: boolean;
      content?: string;
      dryRun?: boolean;
      all?: boolean;
      json?: boolean;
      human?: boolean;
    }) => {
      const operation = "instructions.inject";
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

      if (providers.length === 0) {
        const message = "No providers found.";
        if (format === "json") {
          emitJsonError(operation, mvi, ErrorCodes.PROVIDER_NOT_FOUND, message, ErrorCategories.NOT_FOUND);
        } else {
          console.error(pc.red(message));
        }
        process.exit(1);
      }

      const content = opts.content ?? generateInjectionContent();
      const scope = opts.global ? "global" as const : "project" as const;

      // Show grouped preview
      const groups = groupByInstructFile(providers);

      if (opts.dryRun) {
        if (format === "json") {
          outputSuccess(operation, mvi, {
            injected: [],
            providers: providers.map((p) => p.id),
            count: 0,
            dryRun: true,
            wouldInject: Array.from(groups.entries()).map(([file, group]) => ({
              file,
              providers: group.map((p) => p.id),
            })),
          });
        } else {
          console.log(pc.bold("Dry run - would inject into:\n"));
          for (const [file, group] of groups) {
            console.log(`  ${pc.bold(file)}: ${group.map((p) => p.id).join(", ")}`);
          }
          console.log(pc.dim(`\n  Scope: ${scope}`));
          console.log(pc.dim(`  Content length: ${content.length} chars`));
        }
        return;
      }

      const results = await injectAll(providers, process.cwd(), scope, content);

      const injected: string[] = [];
      for (const [file] of results) {
        injected.push(file);
      }

      if (format === "json") {
        outputSuccess(operation, mvi, {
          injected,
          providers: providers.map((p) => p.id),
          count: results.size,
        });
      } else {
        for (const [file, action] of results) {
          const icon = action === "created" ? pc.green("+")
            : action === "updated" ? pc.yellow("~")
              : pc.blue("^");
          console.log(`  ${icon} ${file} (${action})`);
        }
        console.log(pc.bold(`\n${results.size} file(s) processed.`));
      }
    });
}
